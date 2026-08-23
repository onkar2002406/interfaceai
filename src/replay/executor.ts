/**
 * Deterministic replay — the path an AI agent triggers in production.
 *
 * No LLM is imported by this file, transitively or otherwise. That is the point
 * of the whole system: the model's job ended when the artifact was written.
 *
 * Three things here are where the real thinking went.
 *
 * **1. Waiting and classifying are the same loop.**
 * The naive structure is: do the step, wait for the checkpoint, and if it times
 * out, look around for an explanation. That reports a 10-second timeout when the
 * app answered "No records found" instantly. So classification runs on every
 * poll of the checkpoint wait. Searching for a member that doesn't exist returns
 * MEMBER_NOT_FOUND in a few hundred milliseconds, because the condition fires
 * long before the checkpoint deadline that was never going to be met.
 *
 * **2. A timeout is a diagnosis of last resort.**
 * `checkpoint_failed` means "we waited, and nothing we know about explains why".
 * Anything the product profile can explain — session expiry, an app error page,
 * a maintenance overlay — is reported as *that*, not as a timeout. A timeout
 * that could have been diagnosed is a debugging tax paid by whoever is on call.
 *
 * **3. Escalation is a first-class control-flow arm, not an error handler.**
 * A step can be blocked because policy will not take an irreversible action
 * unattended. Nothing failed. The run parks, a human acts on the live session,
 * and — crucially — the executor re-verifies the resume contract before it
 * touches the page again. A human saying "done" is a claim; the checkpoint is
 * the fact.
 */

import { randomUUID } from 'node:crypto';
import type { Capability, Checkpoint, Condition, ErrorClass, Step } from '../capability/schema.js';
import { interpolate } from '../capability/schema.js';
import { conditionsFor, tenantOf, type AppProfile } from '../capability/app-profile.js';
import { resolveForTenant } from '../capability/overrides.js';
import { ControlAuthority, type ControlToken } from '../escalation/control.js';
import {
  newInterventionId,
  UnattendedSink,
  type EscalationSink,
  type HumanAction,
  type InterventionReasonClass,
  type InterventionRequest,
} from '../escalation/broker.js';
import type { Policy } from '../policy/policy.js';
import { redactParams } from '../policy/redact.js';
import { PlaywrightSurface } from '../surface/web/playwright-surface.js';
import { resolve as resolveDescriptor } from '../surface/resolver.js';
import { describeDescriptor } from '../surface/descriptor.js';
import { applyTransform, elementText, TransformError } from '../surface/element.js';
import type { Action, Observation } from '../surface/types.js';
import type { RunRecorder } from '../observability/evidence.js';
import { evaluateCheckpoint, evaluatePredicate, type CheckpointResult } from './predicates.js';
import { classify } from './outcomes.js';
import type {
  DriftSignal,
  RecoveryAttemptReport,
  ReplayEnvelope,
  ReplayResult,
  StepReport,
} from './outcomes.js';
import { ensureAuthenticated, runRecovery } from './recovery.js';

export class CapabilityInputError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid inputs: ${problems.join('; ')}`);
    this.name = 'CapabilityInputError';
  }
}

/**
 * Validates the caller's arguments against the declared input contract.
 *
 * Runs before a browser is launched — a bad member ID should cost milliseconds,
 * not a browser start plus three page loads. Exported so the capability catalog
 * can reject a malformed agent call without entering replay at all.
 */
export function validateInputs(capability: Capability, params: Record<string, unknown>): void {
  const problems: string[] = [];
  for (const input of capability.spec.inputs) {
    const value = params[input.name];
    if (value === undefined || value === null || value === '') {
      if (input.required) problems.push(`"${input.name}" is required (${input.description})`);
      continue;
    }
    const s = String(value);
    if (input.pattern && !new RegExp(input.pattern).test(s)) {
      problems.push(`"${input.name}" must match /${input.pattern}/ (got ${input.sensitivity === 'public' ? `"${s}"` : 'a value that does not match'})`);
    }
    if (input.type === 'number' && Number.isNaN(Number(s))) {
      problems.push(`"${input.name}" must be a number`);
    }
  }
  const declared = new Set(capability.spec.inputs.map((i) => i.name));
  for (const key of Object.keys(params)) {
    if (!declared.has(key)) problems.push(`"${key}" is not an input of this capability`);
  }
  if (problems.length) throw new CapabilityInputError(problems);
}

export interface ReplayOptions {
  capability: Capability;
  params: Record<string, unknown>;
  tenantId: string;
  profile: AppProfile;
  policy: Policy;
  recorder: RunRecorder;
  sink?: EscalationSink;
  headful?: boolean;
  /**
   * The caller explicitly authorises irreversible effects for this invocation.
   * Only honoured when the artifact is also `approval: approved` — two
   * independent gates, because either alone is too easy to set by accident.
   */
  authorizeIrreversible?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * How many times a run may restart from the entry point after losing its
 * session. One. A second session loss inside a single run means something is
 * wrong with the credentials or the session policy, and retrying would loop.
 */
const MAX_FLOW_RESTARTS = 1;

export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const { profile, policy, recorder } = opts;
  const runId = recorder.runId;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  validateInputs(opts.capability, opts.params);

  const tenant = tenantOf(profile, opts.tenantId);
  const { capability, appliedOverrides } = resolveForTenant(opts.capability, opts.tenantId);
  const spec = capability.spec;

  const sensitivity = Object.fromEntries(spec.inputs.map((i) => [i.name, i.sensitivity]));
  const safeParams = redactParams(opts.params, sensitivity);

  const approved = capability.metadata.approval === 'approved';
  const irreversibleAuthorized = approved && opts.authorizeIrreversible === true;

  recorder.event('replay_start', {
    capability: `${capability.metadata.name}@${capability.metadata.version}`,
    tenant: tenant.id,
    product: `${profile.product} v${tenant.productVersion}`,
    baseUrl: tenant.baseUrl,
    approval: capability.metadata.approval,
    irreversibleAuthorized,
    params: safeParams,
    overrides: appliedOverrides.length,
  });
  for (const o of appliedOverrides) {
    recorder.event('override_applied', { path: o.path, why: o.why });
  }

  const authority = new ControlAuthority(runId);
  const sink: EscalationSink = opts.sink ?? new UnattendedSink();

  const surface = await PlaywrightSurface.launch({
    policy,
    authority,
    mode: 'replay',
    headful: opts.headful ?? false,
    irreversibleAuthorized,
    onEvent: (e) => recorder.event(`surface_${e.kind}`, e.detail),
  });

  const steps: StepReport[] = [];
  const driftSignals: DriftSignal[] = [];
  const observationByStep = new Map<string, Observation>();
  let recoveryBudget = policy.config.limits.maxRecoveries;
  const humanActions: HumanAction[] = [];

  const token = (): ControlToken => authority.automationToken();

  const envelope = (): ReplayEnvelope => ({
    runId,
    capability: capability.metadata.name,
    capabilityVersion: capability.metadata.version,
    tenant: tenant.id,
    product: profile.product,
    startedAt,
    durationMs: Date.now() - t0,
    steps,
    driftSignals,
    appliedOverrides,
    evidenceDir: recorder.dir,
    blockedNavigations: [...surface.blockedNavigationLog()],
  });

  /* ------------------------------------------------------------- helpers */

  /** Captures the richer failure signal: masked screenshot + AX snapshot. */
  async function captureFailureEvidence(label: string): Promise<string | undefined> {
    try {
      const obs = await surface.observe({ screenshot: true });
      const shot = obs.screenshot ? recorder.screenshot(label, obs.screenshot) : undefined;
      recorder.snapshot(`${label}-elements`, {
        url: obs.signals.url,
        title: obs.signals.title,
        frames: obs.signals.frames,
        // The AX inventory is what the resolver actually looked at. For a
        // locator failure this is more useful than the picture.
        elements: obs.elements.map((e) => ({
          role: e.role,
          name: e.name,
          proximateLabels: e.proximateLabels,
          framePath: e.framePath,
          columnHeader: e.context.columnHeader,
          rowCells: e.context.rowCells,
        })),
      });
      return shot;
    } catch {
      return undefined;
    }
  }

  async function escalateStep(
    step: Step,
    index: number,
    reasonClass: InterventionReasonClass,
    reason: string,
  ): Promise<{ resumed: boolean; result?: ReplayResult; note?: string }> {
    const shot = await captureFailureEvidence(`escalation-${step.id}`);
    const obs = await surface.observe();

    const request: InterventionRequest = {
      id: newInterventionId(),
      runId,
      sessionId: surface.sessionId,
      createdAt: new Date().toISOString(),
      capability: {
        name: capability.metadata.name,
        version: capability.metadata.version,
        title: capability.metadata.title,
      },
      tenant: tenant.id,
      atStep: { id: step.id, intent: step.intent, index: index + 1, total: spec.steps.length },
      reasonClass,
      reason,
      params: safeParams,
      ...(shot ? { screenshotPath: shot } : {}),
      observedText: obs.signals.visibleText.slice(0, 1200),
      resumeContract: {
        describe:
          step.checkpoint?.describe ??
          `step "${step.intent}" has been completed and the flow can continue from step ${index + 2}`,
        ...(step.checkpoint ? { checkpoint: step.checkpoint } : {}),
      },
    };

    recorder.event('escalation_raised', {
      interventionId: request.id,
      step: step.id,
      reasonClass,
      reason,
      resumeContract: request.resumeContract.describe,
      screenshot: shot,
    });

    const outcome = await sink.raise(request, {
      authority,
      surface,
      onHumanAction: (a) => {
        humanActions.push(a);
        recorder.event('human_action', { interventionId: request.id, kind: a.kind, ...a.detail });
      },
    });

    recorder.event('escalation_resolved', {
      interventionId: request.id,
      resolution: outcome.resolution,
      ...(outcome.resolution === 'resumed' ? { operator: outcome.operator, note: outcome.note } : {}),
      ...(outcome.resolution !== 'resumed' ? { reason: outcome.reason } : {}),
      humanActions: outcome.actions.length,
    });

    if (outcome.resolution !== 'resumed') {
      return {
        resumed: false,
        result: {
          status: 'escalated',
          interventionId: request.id,
          reason,
          atStep: step.id,
          resolution: outcome.resolution,
          ...envelope(),
        },
      };
    }

    // A human said they finished. Verify before believing it.
    authority.resumeAutomation(`operator ${outcome.operator} handed back`);
    const after = await surface.observe();
    if (step.checkpoint) {
      const cp = evaluateCheckpoint(step.checkpoint, after);
      if (!cp.ok) {
        recorder.event('resume_contract_unmet', {
          interventionId: request.id,
          step: step.id,
          expected: cp.describe,
          observed: cp.failed.map((f) => f.observed).join('; '),
        });
        return {
          resumed: false,
          result: {
            status: 'escalated',
            interventionId: request.id,
            reason: `operator handed back but the resume contract was not met: ${cp.failed.map((f) => f.observed).join('; ')}`,
            atStep: step.id,
            resolution: 'abandoned',
            operatorNote: outcome.note,
            ...envelope(),
          },
        };
      }
    }
    recorder.event('resume_contract_met', { interventionId: request.id, step: step.id });
    return { resumed: true, note: outcome.note };
  }

  /**
   * The unified settle loop: observe, classify, check, repeat until the
   * checkpoint holds, a condition explains what is happening, or we run out of
   * time. This is where the interesting behaviour lives.
   */
  type Settled =
    | { kind: 'ok'; observation: Observation; checkpoint?: CheckpointResult }
    | { kind: 'business'; code: string; message: string; conditionId: string; observation: Observation }
    | {
        kind: 'fail';
        errorClass: ErrorClass;
        message: string;
        observation: Observation;
        expected: string;
        observed: string;
      }
    | { kind: 'timeout'; checkpoint?: CheckpointResult; observation: Observation }
    | { kind: 'unrecovered'; conditionId: string; note: string; observation: Observation }
    | { kind: 'restart'; conditionId: string; note: string; observation: Observation };

  async function settle(
    conditions: Condition[],
    checkpoint: Checkpoint | undefined,
    recoveries: RecoveryAttemptReport[],
    returnUrl: string,
  ): Promise<Settled> {
    const timeoutMs = checkpoint?.timeoutMs ?? 4000;
    const pollMs = checkpoint?.pollMs ?? 250;
    let deadline = Date.now() + timeoutMs;
    const attemptsByCondition = new Map<string, number>();
    let lastCheckpoint: CheckpointResult | undefined;
    let observation = await surface.observe();

    for (;;) {
      // Classification first, always. An answer beats a wait.
      const c = classify(conditions, observation);

      if (c.kind === 'business') {
        return {
          kind: 'business',
          code: c.code,
          message: c.message,
          conditionId: c.condition.id,
          observation,
        };
      }

      if (c.kind === 'fail') {
        return {
          kind: 'fail',
          errorClass: c.errorClass,
          message: c.message,
          observation,
          expected: c.evidence.expected,
          observed: c.evidence.observed,
        };
      }

      if (c.kind === 'recover' && c.condition.then.kind === 'recover') {
        const action = c.condition.then.action;
        const used = attemptsByCondition.get(c.condition.id) ?? 0;

        if (used >= action.maxAttempts || recoveryBudget <= 0) {
          return {
            kind: 'unrecovered',
            conditionId: c.condition.id,
            note:
              recoveryBudget <= 0
                ? `global recovery budget of ${policy.config.limits.maxRecoveries} exhausted`
                : `"${c.condition.id}" recurred after ${used} recovery attempt(s) (max ${action.maxAttempts})`,
            observation,
          };
        }

        attemptsByCondition.set(c.condition.id, used + 1);
        recoveryBudget -= 1;
        recorder.event('recovery_attempt', {
          condition: c.condition.id,
          handler: action.handler,
          attempt: used + 1,
          why: c.evidence.observed.slice(0, 160),
        });

        const res = await runRecovery(action, { surface, token, profile, tenant, returnUrl });
        recoveries.push({
          conditionId: c.condition.id,
          handler: action.handler,
          attempt: used + 1,
          ok: res.ok,
          note: res.note,
          at: new Date().toISOString(),
        });
        recorder.event('recovery_result', { condition: c.condition.id, ok: res.ok, note: res.note });

        if (!res.ok) {
          return { kind: 'unrecovered', conditionId: c.condition.id, note: res.note, observation };
        }

        if (res.restartFlow) {
          return { kind: 'restart', conditionId: c.condition.id, note: res.note, observation };
        }

        // A recovery is not finished when its action returns — it is finished
        // when the condition it addressed stops holding. Dismissing a dialog
        // posts a form; re-classifying before the response lands sees the dialog
        // still there, counts it as a recurrence, and burns the attempt budget
        // on a recovery that was in fact working.
        const clearBy = Date.now() + 3000;
        observation = await surface.observe();
        while (Date.now() < clearBy && evaluatePredicate(c.condition.when, observation).ok) {
          await sleep(150);
          observation = await surface.observe();
        }

        // A successful recovery consumed time that the step's budget should not
        // pay for — restart the clock.
        deadline = Date.now() + timeoutMs;
        continue;
      }

      // Nothing to explain. Is the checkpoint satisfied?
      if (!checkpoint) return { kind: 'ok', observation };

      lastCheckpoint = evaluateCheckpoint(checkpoint, observation);
      if (lastCheckpoint.ok) return { kind: 'ok', observation, checkpoint: lastCheckpoint };

      if (Date.now() >= deadline) {
        return { kind: 'timeout', ...(lastCheckpoint ? { checkpoint: lastCheckpoint } : {}), observation };
      }

      await sleep(pollMs);
      observation = await surface.observe();
    }
  }

  /* ---------------------------------------------------------- the run */

  try {
    // Bootstrap: get to the capability's declared entry point.
    const entryUrl = new URL(interpolate(capability.metadata.app.entryPoint, opts.params), tenant.baseUrl).toString();
    recorder.event('navigate_entry', { url: entryUrl });
    const entryResult = await surface.act({ type: 'navigate', url: entryUrl }, token());
    if (!entryResult.ok) {
      const shot = await captureFailureEvidence('entry-failure');
      return {
        status: 'failed',
        error: {
          class: entryResult.error?.code === 'POLICY_DENIED' ? 'policy_violation' : 'surface_error',
          stepId: '(entry)',
          stepIntent: `open the capability entry point ${capability.metadata.app.entryPoint}`,
          expected: `entry point ${entryUrl} to load`,
          observed: entryResult.error?.message ?? 'navigation failed',
          attempts: 1,
          recoveriesTried: [],
          message: `${entryResult.error?.message ?? 'navigation failed'}${shot ? ` (screenshot: ${shot})` : ''}`,
        },
        ...envelope(),
      };
    }

    /* ------------------------------------------------ auth precondition */

    // Capabilities never contain credentials or sign-on steps. The flow declares
    // that it needs an authenticated session; establishing one is the runtime's
    // job, using the product profile's field targets and environment-supplied
    // credentials. That keeps every capability replayable under any operator
    // identity, and keeps secrets out of files that get committed.
    if (spec.preconditions.authState === 'authenticated') {
      const res = await ensureAuthenticated({ surface, token, profile, tenant, returnUrl: entryUrl });
      recorder.event('auth_precondition', { ok: res.ok, note: res.note });
      if (!res.ok) {
        return {
          status: 'failed',
          error: {
            class: 'unrecovered_condition',
            stepId: '(precondition)',
            stepIntent: 'establish an authenticated session before the flow begins',
            expected: profile.auth.successCheckpoint.describe,
            observed: res.note,
            attempts: 1,
            recoveriesTried: ['reauthenticate'],
            message: res.note,
          },
          ...envelope(),
        };
      }
    }

    /* -------------------------------------------------------- step loop */

    let restartsUsed = 0;
    /**
     * Set the moment an irreversible step succeeds. From then on the flow can
     * never be silently restarted — re-running a committed account opening would
     * open a second account. Past this point a lost session escalates.
     */
    let irreversibleCommitted = false;

    restartLoop: for (;;) {
    for (let index = 0; index < spec.steps.length; index++) {
      const step = spec.steps[index]!;
      const stepStart = Date.now();
      const conditions = conditionsFor(profile, tenant, step.conditions);
      const recoveries: RecoveryAttemptReport[] = [];
      const returnUrl = await surface.location();

      const report: StepReport = {
        stepId: step.id,
        intent: step.intent,
        actionType: step.action.type,
        status: 'ok',
        startedAt: new Date().toISOString(),
        durationMs: 0,
        recoveries,
      };

      // Optional steps: expected absence, not a fault. Used for screens one
      // tenant added that others don't have.
      if (step.optional && 'target' in step.action) {
        const obs = await surface.observe();
        const probe = resolveDescriptor(step.action.target, obs.elements);
        if (!probe.ok) {
          report.status = 'skipped';
          report.durationMs = Date.now() - stepStart;
          report.note = `optional step skipped: ${describeDescriptor(step.action.target)} is not present`;
          steps.push(report);
          recorder.event('step_skipped', { step: step.id, intent: step.intent });
          continue;
        }
      }

      const action = toAction(step, opts.params);
      const displayValue =
        'value' in step.action
          ? valueForLog(step.action.value, opts.params, sensitivity)
          : undefined;

      recorder.event('step_start', {
        step: step.id,
        index: index + 1,
        of: spec.steps.length,
        intent: step.intent,
        action: step.action.type,
        risk: step.guard.risk,
        ...(displayValue !== undefined ? { value: displayValue } : {}),
      });

      const actResult = await surface.act(action, token());

      // Policy is authoritative about risk; the artifact's `guard.risk` is a
      // declaration a reviewer relied on. If policy considers a step riskier
      // than the artifact claims, the artifact is misleading whoever approved
      // it — surface that, even though the action was already handled correctly.
      const RANK = { safe: 0, mutating: 1, irreversible: 2 } as const;
      const enforced = actResult.risk as keyof typeof RANK | undefined;
      if (enforced && RANK[enforced] > RANK[step.guard.risk]) {
        recorder.event('risk_declaration_mismatch', {
          step: step.id,
          declared: step.guard.risk,
          enforced,
          note: 'the capability under-declares this step; policy classification was applied',
        });
      }

      if (actResult.resolution) {
        report.resolution = {
          score: Number(actResult.resolution.score.toFixed(3)),
          strategy: actResult.resolution.strategy,
          drift: actResult.resolution.drift,
          matched: actResult.resolution.matchedName || actResult.actedOn?.name || '',
        };
        if (actResult.resolution.drift && 'target' in step.action) {
          driftSignals.push({
            stepId: step.id,
            intent: step.intent,
            expected: describeDescriptor(step.action.target),
            matched: actResult.actedOn?.name || actResult.resolution.matchedName,
            score: Number(actResult.resolution.score.toFixed(3)),
            strategy: actResult.resolution.strategy,
          });
        }
      }

      if (!actResult.ok) {
        const code = actResult.error?.code ?? 'SURFACE_ERROR';
        const message = actResult.error?.message ?? 'action failed';

        // Policy refusals are not failures if a human could consent. An
        // irreversible step on an unapproved artifact is exactly that case.
        const policyInfo = (actResult as { policy?: { escalatable?: boolean; risk?: string } }).policy;
        if (code === 'POLICY_DENIED' && policyInfo?.escalatable) {
          const esc = await escalateStep(step, index, 'policy_irreversible', message);
          if (!esc.resumed) {
            report.status = 'escalated';
            report.durationMs = Date.now() - stepStart;
            report.note = message;
            steps.push(report);
            return esc.result!;
          }
          report.note = `completed by operator: ${esc.note ?? ''}`;
          report.status = 'ok';
          report.durationMs = Date.now() - stepStart;
          steps.push(report);
          continue;
        }

        if (code === 'POLICY_DENIED') {
          const shot = await captureFailureEvidence(`policy-denied-${step.id}`);
          report.status = 'failed';
          report.durationMs = Date.now() - stepStart;
          steps.push(report);
          recorder.event('step_failed', { step: step.id, class: 'policy_violation', message, screenshot: shot });
          return {
            status: 'failed',
            error: {
              class: 'policy_violation',
              stepId: step.id,
              stepIntent: step.intent,
              expected: 'an action permitted by the allowlist',
              observed: message,
              attempts: 1,
              recoveriesTried: recoveries.map((r) => r.handler),
              message,
            },
            ...envelope(),
          };
        }

        // Before calling a missing target a failure, let the detectors speak:
        // the control may be missing because an overlay is covering the page or
        // the session expired, both of which are recoverable.
        const settled = await settle(conditions, step.checkpoint, recoveries, returnUrl);
        if (settled.kind === 'business') {
          return finishBusiness(settled, step);
        }
        if (settled.kind === 'ok' && recoveries.some((r) => r.ok)) {
          // Something was in the way and we cleared it — retry this step once.
          recorder.event('step_retry_after_recovery', { step: step.id });
          const retry = await surface.act(action, token());
          if (retry.ok) {
            report.status = 'ok';
            report.durationMs = Date.now() - stepStart;
            steps.push(report);
            observationByStep.set(step.id, await surface.observe());
            continue;
          }
        }

        const reasonClass: InterventionReasonClass =
          code === 'AMBIGUOUS_TARGET' ? 'ambiguous_target' : 'target_not_found';
        const escalatePolicy =
          code === 'AMBIGUOUS_TARGET' ? spec.escalation.onAmbiguous : spec.escalation.onUnrecovered;

        if (escalatePolicy === 'escalate') {
          const esc = await escalateStep(step, index, reasonClass, message);
          if (esc.resumed) {
            report.status = 'ok';
            report.note = `completed by operator: ${esc.note ?? ''}`;
            report.durationMs = Date.now() - stepStart;
            steps.push(report);
            observationByStep.set(step.id, await surface.observe());
            continue;
          }
          report.status = 'escalated';
          report.durationMs = Date.now() - stepStart;
          steps.push(report);
          return esc.result!;
        }

        const shot = await captureFailureEvidence(`step-failed-${step.id}`);
        report.status = 'failed';
        report.durationMs = Date.now() - stepStart;
        steps.push(report);
        recorder.event('step_failed', { step: step.id, class: code, message, screenshot: shot });
        return {
          status: 'failed',
          error: {
            class: code === 'AMBIGUOUS_TARGET' ? 'ambiguous_target' : 'target_not_found',
            stepId: step.id,
            stepIntent: step.intent,
            expected: 'target' in step.action ? describeDescriptor(step.action.target) : step.action.type,
            observed: message,
            attempts: 1,
            recoveriesTried: recoveries.map((r) => r.handler),
            message,
          },
          ...envelope(),
        };
      }

      /* ---------------------- settle: classify + checkpoint ---------------------- */

      const settled = await settle(conditions, step.checkpoint, recoveries, returnUrl);
      report.durationMs = Date.now() - stepStart;

      if (settled.kind === 'business') {
        report.status = 'business';
        steps.push(report);
        return finishBusiness(settled, step);
      }

      if (settled.kind === 'fail') {
        const shot = await captureFailureEvidence(`condition-fail-${step.id}`);
        report.status = 'failed';
        steps.push(report);
        recorder.event('step_failed', {
          step: step.id,
          class: settled.errorClass,
          message: settled.message,
          screenshot: shot,
        });
        return {
          status: 'failed',
          error: {
            class: settled.errorClass,
            stepId: step.id,
            stepIntent: step.intent,
            expected: step.checkpoint?.describe ?? 'the step to complete without an application error',
            observed: settled.observed,
            attempts: 1,
            recoveriesTried: recoveries.map((r) => r.handler),
            message: settled.message,
          },
          ...envelope(),
        };
      }

      // The session was re-established but our place in the flow was not.
      if (settled.kind === 'restart') {
        if (irreversibleCommitted) {
          // Never replay a flow that has already changed the institution's
          // records. We do not know whether the committed step would run again.
          const esc = await escalateStep(
            step,
            index,
            'unrecovered_condition',
            `the session was lost after an irreversible step had already been committed, so this run ` +
              `cannot be safely restarted. A human must confirm the current state before anything else happens. ` +
              `(${settled.note})`,
          );
          report.status = 'escalated';
          steps.push(report);
          if (!esc.resumed) return esc.result!;
          // A human confirmed the state; continue from the next step.
          report.status = 'ok';
          continue;
        }

        if (restartsUsed >= MAX_FLOW_RESTARTS) {
          report.status = 'failed';
          steps.push(report);
          return {
            status: 'failed',
            error: {
              class: 'unrecovered_condition',
              stepId: step.id,
              stepIntent: step.intent,
              expected: 'a stable authenticated session for the duration of the flow',
              observed: settled.note,
              attempts: restartsUsed + 1,
              recoveriesTried: recoveries.map((r) => r.handler),
              message: `the session was lost more than ${MAX_FLOW_RESTARTS} time(s); not retrying further`,
            },
            ...envelope(),
          };
        }

        restartsUsed += 1;
        recorder.event('flow_restart', {
          reason: settled.conditionId,
          note: settled.note,
          atStep: step.id,
          attempt: restartsUsed,
        });
        // Discard the partial run: the steps we recorded describe a session that
        // no longer exists, and keeping them would make the report a fiction.
        steps.length = 0;
        driftSignals.length = 0;
        observationByStep.clear();
        const back = await surface.act({ type: 'navigate', url: entryUrl }, token());
        if (!back.ok) {
          return {
            status: 'failed',
            error: {
              class: 'surface_error',
              stepId: '(restart)',
              stepIntent: 'return to the entry point after re-authenticating',
              expected: `${entryUrl} to load`,
              observed: back.error?.message ?? 'navigation failed',
              attempts: 1,
              recoveriesTried: ['reauthenticate'],
              message: back.error?.message ?? 'navigation failed',
            },
            ...envelope(),
          };
        }
        continue restartLoop;
      }

      if (settled.kind === 'unrecovered' || settled.kind === 'timeout') {
        const failedCheckpoint = settled.kind === 'timeout' ? settled.checkpoint : undefined;
        const reason =
          settled.kind === 'unrecovered'
            ? `condition "${settled.conditionId}" could not be recovered: ${settled.note}`
            : `checkpoint "${step.checkpoint?.describe}" was not met within ${step.checkpoint?.timeoutMs}ms and no known condition explains it`;

        if (spec.escalation.onUnrecovered === 'escalate') {
          const esc = await escalateStep(
            step,
            index,
            settled.kind === 'unrecovered' ? 'unrecovered_condition' : 'checkpoint_failed',
            reason,
          );
          if (esc.resumed) {
            report.status = 'ok';
            report.note = `unblocked by operator: ${esc.note ?? ''}`;
            steps.push(report);
            observationByStep.set(step.id, await surface.observe());
            continue;
          }
          report.status = 'escalated';
          steps.push(report);
          return esc.result!;
        }

        const shot = await captureFailureEvidence(`step-stuck-${step.id}`);
        report.status = 'failed';
        if (failedCheckpoint) {
          report.checkpoint = {
            describe: failedCheckpoint.describe,
            ok: false,
            failed: failedCheckpoint.failed,
          };
        }
        steps.push(report);
        recorder.event('step_failed', { step: step.id, class: 'checkpoint_failed', message: reason, screenshot: shot });
        return {
          status: 'failed',
          error: {
            class: settled.kind === 'unrecovered' ? 'unrecovered_condition' : 'checkpoint_failed',
            stepId: step.id,
            stepIntent: step.intent,
            expected: step.checkpoint?.describe ?? 'the expected screen',
            observed:
              failedCheckpoint?.failed.map((f) => f.observed).join('; ') ||
              settled.observation.signals.visibleText.slice(0, 200),
            attempts: 1,
            recoveriesTried: recoveries.map((r) => r.handler),
            message: reason,
          },
          ...envelope(),
        };
      }

      if (settled.checkpoint) {
        report.checkpoint = { describe: settled.checkpoint.describe, ok: true, failed: [] };
      }
      steps.push(report);
      observationByStep.set(step.id, settled.observation);
      if (step.guard.risk === 'irreversible') irreversibleCommitted = true;
      recorder.event('step_ok', {
        step: step.id,
        durationMs: report.durationMs,
        ...(step.guard.risk === 'irreversible' ? { committed: 'irreversible' } : {}),
        ...(report.resolution ? { score: report.resolution.score, via: report.resolution.strategy } : {}),
        ...(report.checkpoint ? { checkpoint: report.checkpoint.describe } : {}),
      });
    }
    break restartLoop;
    }

    /* -------------------------------------------------- success checkpoint */

    // Polled, not evaluated once. The success checkpoint is where a capability
    // asserts it actually achieved its goal, and it runs at the exact moment the
    // final screen is still materialising — the least settled instant of the
    // whole run. A single evaluation here is how you get an engine that works
    // four times in five.
    const finalConditions = conditionsFor(profile, tenant, []);
    const finalSettled = await settle(finalConditions, spec.successCheckpoint, [], await surface.location());

    if (finalSettled.kind === 'business') {
      return finishBusiness(finalSettled, spec.steps[spec.steps.length - 1]!);
    }

    if (finalSettled.kind !== 'ok') {
      const shot = await captureFailureEvidence('success-checkpoint-failed');
      const observed =
        finalSettled.kind === 'timeout'
          ? (finalSettled.checkpoint?.failed.map((f) => f.observed).join('; ') ?? 'checkpoint not met')
          : finalSettled.kind === 'fail'
            ? finalSettled.observed
            : finalSettled.note;
      recorder.event('success_checkpoint_failed', {
        expected: spec.successCheckpoint.describe,
        observed,
        screenshot: shot,
      });
      return {
        status: 'failed',
        error: {
          class: finalSettled.kind === 'fail' ? finalSettled.errorClass : 'checkpoint_failed',
          stepId: '(success)',
          stepIntent: 'confirm the capability achieved its goal',
          expected: spec.successCheckpoint.describe,
          observed,
          attempts: 1,
          recoveriesTried: [],
          message: 'every step completed but the capability-level success condition was not met',
        },
        ...envelope(),
      };
    }

    const finalObs = finalSettled.observation;

    /* ---------------------------------------------------- output extraction */

    const outputs: Record<string, unknown> = {};
    for (const out of spec.outputs) {
      // Extraction is an assertion about the screen, so it gets the same
      // discipline as a checkpoint: look, and if it isn't there yet, look again
      // within a deadline rather than declaring failure on the first glance.
      // Each retry is logged, so a genuinely wrong descriptor still shows up as
      // a descriptor problem rather than hiding behind a retry loop.
      let obs = observationByStep.get(out.from.afterStep) ?? finalObs;
      let r = resolveDescriptor(out.from.target, obs.elements);

      for (let attempt = 1; !r.ok && attempt <= 3; attempt++) {
        recorder.event('output_extraction_retry', {
          output: out.name,
          attempt,
          reason: r.reason,
          searchedElements: obs.elements.length,
        });
        await sleep(250);
        obs = await surface.observe();
        r = resolveDescriptor(out.from.target, obs.elements);
      }

      if (!r.ok) {
        const shot = await captureFailureEvidence(`output-${out.name}-not-found`);
        recorder.event('output_extraction_failed', {
          output: out.name,
          reason: r.reason,
          // Which snapshot we searched, and what was in it. Without this, an
          // extraction failure is indistinguishable from a bad descriptor.
          searchedObservation: observationByStep.has(out.from.afterStep) ? out.from.afterStep : '(final)',
          observedAt: obs.observedAt,
          elementsSearched: obs.elements.length,
          cellsWithColumnHeader: obs.elements.filter((e) => e.context.columnHeader).length,
          frameUrls: obs.signals.frameUrls,
          screenshot: shot,
        });
        return {
          status: 'failed',
          error: {
            class: r.reason === 'ambiguous' ? 'ambiguous_target' : 'target_not_found',
            stepId: out.from.afterStep,
            stepIntent: `extract declared output "${out.name}"`,
            expected: describeDescriptor(out.from.target),
            observed: r.ranked
              .slice(0, 3)
              .map((c) => `${c.node.role} "${c.node.name}" @${c.score.toFixed(2)}`)
              .join('; '),
            attempts: 1,
            recoveriesTried: [],
            message: `the capability completed but declared output "${out.name}" could not be read from the screen`,
          },
          ...envelope(),
        };
      }
      try {
        outputs[out.name] = applyTransform(elementText(r.node), out.from.transform);
      } catch (err) {
        if (err instanceof TransformError) {
          return {
            status: 'failed',
            error: {
              class: 'checkpoint_failed',
              stepId: out.from.afterStep,
              stepIntent: `extract declared output "${out.name}"`,
              expected: `a value convertible to ${out.type}`,
              observed: elementText(r.node),
              attempts: 1,
              recoveriesTried: [],
              message: err.message,
            },
            ...envelope(),
          };
        }
        throw err;
      }
      if (r.info.drift) {
        driftSignals.push({
          stepId: out.from.afterStep,
          intent: `read output "${out.name}"`,
          expected: describeDescriptor(out.from.target),
          matched: r.node.name,
          score: Number(r.info.score.toFixed(3)),
          strategy: r.info.strategy,
        });
      }
    }

    recorder.event('replay_success', {
      outputs: redactOutputs(outputs, spec.outputs),
      durationMs: Date.now() - t0,
      driftSignals: driftSignals.length,
    });

    return { status: 'success', outputs, ...envelope() };
  } finally {
    await surface.close();
  }

  /* ------------------------------------------------------------ closures */

  function finishBusiness(
    settled: { code: string; message: string; conditionId: string },
    step: Step,
  ): ReplayResult {
    const declared = spec.outcomes.business.find((b) => b.code === settled.code);
    recorder.event('business_outcome', {
      code: settled.code,
      condition: settled.conditionId,
      step: step.id,
      declared: Boolean(declared),
      message: settled.message,
    });
    return {
      status: 'business_outcome',
      code: settled.code,
      message: declared?.meaning ?? settled.message,
      conditionId: settled.conditionId,
      atStep: step.id,
      ...envelope(),
    };
  }
}

/* ---------------------------------------------------------------- helpers */

function toAction(step: Step, params: Record<string, unknown>): Action {
  switch (step.action.type) {
    case 'navigate':
      return { type: 'navigate', url: interpolate(step.action.url, params) };
    case 'click':
      return { type: 'click', target: { kind: 'descriptor', descriptor: step.action.target } };
    case 'type':
      return {
        type: 'type',
        target: { kind: 'descriptor', descriptor: step.action.target },
        value: interpolate(step.action.value, params),
      };
    case 'select':
      return {
        type: 'select',
        target: { kind: 'descriptor', descriptor: step.action.target },
        value: interpolate(step.action.value, params),
      };
    case 'press':
      return { type: 'press', key: step.action.key };
  }
}

/**
 * What a typed value looks like in the log. A step that types `{{memberId}}`
 * logs the *reference*, not the member's identifier, unless the input was
 * explicitly declared public.
 */
function valueForLog(
  template: string,
  params: Record<string, unknown>,
  sensitivity: Record<string, string>,
): string {
  const refs = [...template.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map((m) => m[1]!);
  if (refs.length === 0) return template;
  if (refs.every((r) => sensitivity[r] === 'public')) return interpolate(template, params);
  return template; // keep the {{reference}} form
}

function redactOutputs(
  outputs: Record<string, unknown>,
  declared: Array<{ name: string; sensitivity: string }>,
): Record<string, unknown> {
  const byName = new Map(declared.map((d) => [d.name, d.sensitivity]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(outputs)) {
    out[k] = byName.get(k) === 'public' ? v : '[declared-sensitive]';
  }
  return out;
}
