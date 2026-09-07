/**
 * The discovery loop: observe -> decide -> act, until the goal is met or a
 * stopping condition fires.
 *
 * This is the only place a model is in the loop, and it is deliberately the
 * cheapest part of the system to throw away. What it produces is not the
 * capability — it produces a *trace*, and the trace is compiled into the
 * capability by deterministic code (see compile.ts). The model never writes a
 * locator, never writes a checkpoint, and never chooses an error taxonomy.
 *
 * Stopping conditions, all of them hard:
 *   - the model calls finish (and the surface agrees the goal state is reached)
 *   - the model calls give_up
 *   - max steps
 *   - wall-clock timeout
 *   - the policy blocks an action, which for an irreversible action means the
 *     model tried something it was told not to — that ends the run
 *   - the model names an element that does not exist (twice in a row)
 *
 * Note what the loop does NOT do: retry, back off, or reason about errors. All
 * of that belongs to replay, where it is declarative and reviewable. A discovery
 * run that hits trouble should stop and be looked at, not improvise.
 */

import { randomUUID } from 'node:crypto';
import type { LlmProvider, ModelTurn } from './llm/llm-provider.js';
import { renderObservation, systemPrompt, toolsPermittedBy } from './model-prompt.js';
import type { Action, ElementNode, Observation } from '../surface/types.js';
import type { PlaywrightSurface } from '../surface/web/playwright-surface.js';
import { captureDescriptor, type ElementDescriptor } from '../surface/element-descriptor.js';
import type { RunRecorder } from '../observability/run-recorder.js';
import type { ControlAuthority } from '../escalation/control-authority.js';
import type { EscalationSink } from '../escalation/intervention-broker.js';
import { newInterventionId } from '../escalation/intervention-broker.js';
import { ensureAuthenticated } from '../replay/recovery.js';
import { evaluatePredicate } from '../replay/checkpoints.js';
import { conditionsFor, type AppProfile, type TenantProfile } from '../capability/application-profile.js';

export interface TraceStep {
  index: number;
  /** The model's own words. Becomes the compiled step's `intent`. */
  intent: string;
  toolName: string;
  arguments: Record<string, unknown>;
  /** Everything needed to rebuild a durable locator, captured at record time. */
  descriptor?: ElementDescriptor;
  actedOn?: { role: string; name: string; framePath: string[]; proximateLabels: string[] };
  /** Surface state *after* the action — the raw material for the checkpoint. */
  after: {
    url: string;
    frameUrls: string[];
    title: string;
    heading?: string;
    textSample: string;
  };
  ok: boolean;
  error?: string;
  at: string;
}

export interface DiscoveryTrace {
  runId: string;
  goal: string;
  goalTemplate: string;
  params: Record<string, string>;
  product: string;
  tenant: string;
  entryPoint: string;
  model: string;
  provider: string;
  startedAt: string;
  finishedAt: string;
  steps: TraceStep[];
  outcome:
    | { kind: 'success'; summary: string; outputs: Array<{ name: string; description: string; descriptor: ElementDescriptor; sampleText: string }> }
    /**
     * The application answered, and the answer was not the goal.
     *
     * This arm exists because of a real defect. A goal naming a member who does
     * not exist used to end as `gave_up`, and every `gave_up` raised an
     * escalation — so asking a live agent to look up member 999999 parked a
     * browser and paged a human to come and look at a screen that said, in
     * words, RECORD NOT FOUND. Replay had classified that correctly as a
     * business outcome since the beginning; discovery simply never consulted
     * the same taxonomy.
     *
     * `why` is present so every existing consumer that reports on a non-success
     * outcome keeps working unchanged.
     */
    | { kind: 'business_outcome'; code: string; message: string; why: string }
    | { kind: 'gave_up'; why: string }
    | { kind: 'stopped'; why: string };
  usage: { promptTokens: number; completionTokens: number; calls: number };
}

export interface DiscoveryOptions {
  goalTemplate: string;
  params: Record<string, string>;
  entryUrl: string;
  product: string;
  tenant: string;
  profile: AppProfile;
  tenantProfile: TenantProfile;
  /**
   * Which operator identity to record under. It never reaches the artifact —
   * the compiled capability declares that it needs a session, not whose — but
   * it decides what the model is allowed to SEE, and a flow behind a restricted
   * function cannot be discovered by an operator without the entitlement.
   */
  identity?: string;
  provider: LlmProvider;
  surface: PlaywrightSurface;
  authority: ControlAuthority;
  recorder: RunRecorder;
  allowedOrigins: string[];
  /** Action types policy permits. The model is offered no tool outside this set. */
  allowedActions: string[];
  /**
   * Human-readable names of the controls policy treats as irreversible, so the
   * prompt can say which ones will be refused instead of leaving the model to
   * infer it. Derived from the policy, never authored twice.
   */
  irreversibleControls?: string[];
  maxSteps?: number;
  timeoutMs?: number;
  sink?: EscalationSink;
}

export async function discover(opts: DiscoveryOptions): Promise<DiscoveryTrace> {
  const {
    goalTemplate,
    params,
    provider,
    surface,
    authority,
    recorder,
    maxSteps = 20,
    timeoutMs = 180_000,
  } = opts;

  const goal = interpolateGoal(goalTemplate, params);
  const runId = recorder.runId;
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;

  const system = systemPrompt({
    product: opts.product,
    allowedOrigins: opts.allowedOrigins,
    irreversibleControls: opts.irreversibleControls ?? [],
  });
  const tools = toolsPermittedBy(opts.allowedActions);
  const history: Array<{ turn: ModelTurn; result: string }> = [];
  const steps: TraceStep[] = [];

  recorder.event('discovery_start', {
    goal,
    entryUrl: opts.entryUrl,
    product: opts.product,
    tenant: opts.tenant,
    provider: provider.name,
    model: provider.model,
    // Recorded so a run report says plainly whether the model could see the
    // screenshots, rather than leaving a reader to infer it.
    vision: provider.supportsVision ? 'screenshot sent to model' : 'text inventory only',
    maxSteps,
  });

  const finish = (outcome: DiscoveryTrace['outcome']): DiscoveryTrace => ({
    runId,
    goal,
    goalTemplate,
    params,
    product: opts.product,
    tenant: opts.tenant,
    entryPoint: new URL(opts.entryUrl).pathname,
    model: provider.model,
    provider: provider.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps,
    outcome,
    usage: provider.usage(),
  });

  await surface.act({ type: 'navigate', url: opts.entryUrl }, authority.automationToken());

  // Same precondition as replay, and for the same reason: the model must never
  // see a sign-on screen, because a flow that begins by typing credentials is a
  // flow that would have to store them.
  const auth = await ensureAuthenticated({
    surface,
    token: () => authority.automationToken(),
    profile: opts.profile,
    tenant: opts.tenantProfile,
    returnUrl: opts.entryUrl,
    ...(opts.identity ? { identity: opts.identity } : {}),
  });
  recorder.event('auth_precondition', {
    ok: auth.ok,
    ...(opts.identity ? { identity: opts.identity } : {}),
    note: auth.note,
  });
  if (!auth.ok) {
    return finish({ kind: 'stopped', why: `could not establish an authenticated session: ${auth.note}` });
  }

  let consecutiveBadIds = 0;

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    if (Date.now() > deadline) {
      recorder.event('discovery_stopped', { why: 'timeout' });
      return finish({ kind: 'stopped', why: `wall-clock timeout after ${timeoutMs}ms` });
    }

    // The screenshot is always captured — it is run evidence, and a human
    // debugging a discovery run wants to see what the screen looked like. It is
    // only *sent to the model* when the model can see images.
    const obs = await surface.observe({ screenshot: true });
    if (obs.screenshot) recorder.screenshot(`step-${String(stepIndex + 1).padStart(2, '0')}`, obs.screenshot);

    const userText = renderObservation(obs, goal, stepIndex, maxSteps);
    recorder.snapshot(`observation-${String(stepIndex + 1).padStart(2, '0')}`, {
      url: obs.signals.url,
      rendered: userText,
    });

    let turn: ModelTurn;
    try {
      turn = await provider.decide({
        system,
        userText,
        ...(obs.screenshot && provider.supportsVision ? { screenshot: obs.screenshot } : {}),
        history,
        tools,
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      recorder.event('model_error', { why });
      return finish({ kind: 'stopped', why: `model call failed: ${why}` });
    }

    recorder.event('model_decision', {
      step: stepIndex + 1,
      tool: turn.toolName,
      reasoning: turn.reasoning,
      args: redactArgs(turn.arguments, params),
    });

    /* ---------------------------------------------------- terminal tools */

    if (turn.toolName === 'give_up') {
      const why = String(turn.arguments.why ?? 'no reason given');

      /**
       * Before escalating, ask the product's own taxonomy what is on screen.
       *
       * A model that stops because the screen says RECORD NOT FOUND has not got
       * stuck — it has received an answer, and the product profile already
       * declares that screen as `MEMBER_NOT_FOUND`. Replay has classified it
       * that way since the beginning; discovery used to escalate it, which
       * parked a browser and paged a human to read a message the system could
       * read itself.
       *
       * Only `business` conditions short-circuit here. A `recover` condition
       * means the run hit something replay would have fixed and discovery does
       * not attempt, and a `fail` condition is a genuine breakage — both of
       * those still deserve a human.
       */
      const answered = businessAnswerOn(obs, opts);
      if (answered) {
        recorder.event('discovery_business_outcome', { code: answered.code, why });
        return finish({ kind: 'business_outcome', code: answered.code, message: answered.message, why });
      }

      recorder.event('discovery_gave_up', { why });
      // Genuinely stuck: the goal may simply not be achievable with these
      // inputs, and a human is the right thing to ask.
      if (opts.sink) await raiseStuck(opts, why, obs, stepIndex, steps.length);
      return finish({ kind: 'gave_up', why });
    }

    if (turn.toolName === 'finish') {
      const declared = (turn.arguments.outputs ?? []) as Array<{
        name: string;
        elementId: string;
        description: string;
      }>;
      const outputs: Extract<DiscoveryTrace['outcome'], { kind: 'success' }>['outputs'] = [];
      for (const d of declared) {
        const node = obs.elements.find((e) => e.id === d.elementId);
        if (!node) {
          recorder.event('output_element_missing', { output: d.name, elementId: d.elementId });
          continue;
        }
        outputs.push({
          name: d.name,
          description: d.description,
          descriptor: captureDescriptor(node, `the ${d.name} value on the final screen`),
          sampleText: node.value?.trim() || node.name.trim(),
        });
      }
      const summary = String(turn.arguments.summary ?? goal);
      recorder.event('discovery_success', { summary, outputs: outputs.map((o) => o.name), steps: steps.length });
      return finish({ kind: 'success', summary, outputs });
    }

    /* ------------------------------------------------------ acting tools */

    const built = buildAction(turn, obs);
    if ('error' in built) {
      consecutiveBadIds += 1;
      history.push({ turn, result: `REJECTED: ${built.error}` });
      recorder.event('model_bad_reference', { why: built.error, consecutive: consecutiveBadIds });
      if (consecutiveBadIds >= 2) {
        return finish({
          kind: 'stopped',
          why: `the model named elements that do not exist on two consecutive turns (${built.error})`,
        });
      }
      continue;
    }
    consecutiveBadIds = 0;

    const { action, node } = built;
    const result = await surface.act(action, authority.automationToken());

    const after = await surface.observe();
    const step: TraceStep = {
      index: steps.length + 1,
      intent: String(turn.arguments.why ?? turn.reasoning),
      toolName: turn.toolName,
      arguments: turn.arguments,
      ...(node ? { descriptor: captureDescriptor(node, String(turn.arguments.why ?? turn.reasoning)) } : {}),
      ...(node
        ? {
            actedOn: {
              role: node.role,
              name: node.name,
              framePath: node.framePath,
              proximateLabels: node.proximateLabels,
            },
          }
        : {}),
      after: {
        url: after.signals.url,
        frameUrls: after.signals.frameUrls,
        title: after.signals.title,
        ...(headingOf(after) ? { heading: headingOf(after)! } : {}),
        textSample: after.signals.visibleText.slice(0, 600),
      },
      ok: result.ok,
      ...(result.error ? { error: result.error.message } : {}),
      at: new Date().toISOString(),
    };
    steps.push(step);

    if (!result.ok) {
      const why = result.error?.message ?? 'action failed';
      recorder.event('discovery_action_failed', { step: step.index, code: result.error?.code, why });

      // A policy refusal during discovery is not a bug to route around — the
      // model was told not to do that. Stop, and let a human decide.
      if (result.error?.code === 'POLICY_DENIED') {
        if (opts.sink) await raiseStuck(opts, why, after, stepIndex, steps.length);
        return finish({ kind: 'stopped', why: `blocked by policy: ${why}` });
      }
      history.push({ turn, result: `FAILED: ${why}` });
      continue;
    }

    recorder.event('discovery_step', {
      step: step.index,
      tool: turn.toolName,
      target: node ? node.name || node.proximateLabels[0] || node.role : undefined,
      url: step.after.url,
    });
    history.push({ turn, result: `OK. Now at ${step.after.url}. ${step.after.textSample.slice(0, 220)}` });
  }

  recorder.event('discovery_stopped', { why: 'max steps' });
  return finish({ kind: 'stopped', why: `reached the maximum of ${maxSteps} steps without finishing` });
}

/* ------------------------------------------------------------------ helpers */

function buildAction(
  turn: ModelTurn,
  obs: Observation,
): { action: Action; node?: ElementNode } | { error: string } {
  const byId = (id: unknown): ElementNode | undefined =>
    obs.elements.find((e) => e.id === String(id ?? '').trim());

  switch (turn.toolName) {
    case 'click': {
      const node = byId(turn.arguments.elementId);
      if (!node) return { error: `no element "${String(turn.arguments.elementId)}" on this screen` };
      return { action: { type: 'click', target: { kind: 'observed', elementId: node.id } }, node };
    }
    case 'type': {
      const node = byId(turn.arguments.elementId);
      if (!node) return { error: `no element "${String(turn.arguments.elementId)}" on this screen` };
      return {
        action: {
          type: 'type',
          target: { kind: 'observed', elementId: node.id },
          value: String(turn.arguments.text ?? ''),
        },
        node,
      };
    }
    case 'select': {
      const node = byId(turn.arguments.elementId);
      if (!node) return { error: `no element "${String(turn.arguments.elementId)}" on this screen` };
      return {
        action: {
          type: 'select',
          target: { kind: 'observed', elementId: node.id },
          value: String(turn.arguments.value ?? ''),
        },
        node,
      };
    }
    case 'press':
      return { action: { type: 'press', key: String(turn.arguments.key ?? 'Enter') } };
    default:
      return { error: `unknown tool "${turn.toolName}"` };
  }
}

function headingOf(obs: Observation): string | undefined {
  return obs.elements.find((e) => e.role === 'heading' && e.name.trim())?.name.trim();
}

function interpolateGoal(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (whole, k: string) => params[k] ?? whole);
}

/** Keeps supplied parameter values out of the model-decision log. */
function redactArgs(args: Record<string, unknown>, params: Record<string, string>): Record<string, unknown> {
  const values = new Set(Object.values(params));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' && values.has(v) ? `{{${keyFor(params, v)}}}` : v;
  }
  return out;
}

function keyFor(params: Record<string, string>, value: string): string {
  return Object.entries(params).find(([, v]) => v === value)?.[0] ?? 'param';
}

/**
 * Does the product's condition taxonomy say this screen is a business answer?
 *
 * Reuses `conditionsFor()` and `evaluatePredicate()` — the same two functions
 * replay uses, in the same order — rather than re-implementing the match here.
 * That is the whole point: the taxonomy is authored once per product, and
 * "member not found" must mean the same thing whichever loop is looking at it.
 * A second implementation would be a second thing to keep in agreement.
 */
function businessAnswerOn(
  obs: Observation,
  opts: DiscoveryOptions,
): { code: string; message: string } | undefined {
  for (const c of conditionsFor(opts.profile, opts.tenantProfile, [])) {
    if (c.then.kind !== 'business') continue;
    if (!evaluatePredicate(c.when, obs).ok) continue;
    // `message` is optional on a condition — the code is the contract and the
    // wording is a courtesy. Fall back to the condition's own description
    // rather than emitting an empty string a caller would have to handle.
    return { code: c.then.code, message: c.then.message ?? c.description };
  }
  return undefined;
}

/**
 * Discovery has its own escalation path. A model that cannot finish is exactly
 * the "stuck during discovery" case the brief names, and it routes through the
 * same broker and the same control-transfer model as a stuck replay.
 */
async function raiseStuck(
  opts: DiscoveryOptions,
  why: string,
  obs: Observation,
  stepIndex: number,
  totalSteps: number,
): Promise<void> {
  if (!opts.sink) return;
  await opts.sink.raise(
    {
      id: newInterventionId(),
      runId: opts.recorder.runId,
      sessionId: opts.surface.sessionId,
      createdAt: new Date().toISOString(),
      capability: {
        name: '(discovery)',
        version: '—',
        title: `Discovery: ${interpolateGoal(opts.goalTemplate, opts.params)}`,
      },
      tenant: opts.tenant,
      atStep: { id: `discovery-${stepIndex + 1}`, intent: why, index: stepIndex + 1, total: totalSteps },
      reasonClass: 'agent_stuck',
      reason: why,
      params: opts.params,
      observedText: obs.signals.visibleText.slice(0, 1200),
      resumeContract: {
        describe:
          'a human has inspected the session and decided whether this goal is achievable; discovery does not ' +
          'resume automatically',
      },
    },
    { authority: opts.authority, surface: opts.surface },
  );
}

export function newRunId(): string {
  return randomUUID().slice(0, 8);
}
