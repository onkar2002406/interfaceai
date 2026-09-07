/**
 * The result contract, and the classifier that decides which arm of it applies.
 *
 * This is the part of the system the brief is most pointed about: "no such
 * member" is a legitimate answer the caller needs, not a crash, and conflating
 * the two is the most common design mistake. So the return type makes the
 * distinction impossible to fudge — a business outcome is a *different arm of
 * the union* from a failure, not a failure with a nicer message.
 *
 * Four arms, and each means something operationally different to the AI agent
 * that invoked the capability:
 *
 *   success          — got what you asked for, here are the typed outputs.
 *   business_outcome — the app answered, and the answer is "no". Act on it.
 *                      Retrying will produce the same answer.
 *   escalated        — a human is or was involved. Includes what they did.
 *   failed           — the automation is broken or the app is broken. Retrying
 *                      might help; a human should look at the evidence.
 *
 * The classifier runs after *every* step, not only when something looks wrong.
 * That matters: "No records found" appears on a page that loaded perfectly and
 * returned HTTP 200. Nothing failed. If you only classify on failure, you never
 * see it, and you report a checkpoint timeout thirty seconds later instead of
 * the answer the caller wanted immediately.
 */

import type { Condition, ErrorClass } from '../capability/schema.js';
import type { Observation } from '../surface/types.js';
import { evaluatePredicate, type PredicateResult } from './checkpoints.js';

/* ------------------------------------------------------------ classifier */

export type Classification =
  | { kind: 'none' }
  | { kind: 'business'; condition: Condition; code: string; message: string; evidence: PredicateResult }
  | { kind: 'recover'; condition: Condition; evidence: PredicateResult }
  | { kind: 'fail'; condition: Condition; errorClass: ErrorClass; message: string; evidence: PredicateResult };

/**
 * First match wins, so the ORDER of `conditions` is the taxonomy.
 *
 * Callers assemble that order as step-local -> tenant -> product-wide, and the
 * product profile itself lists business before recoverable before fatal. The
 * ordering is data, not code, so a product team can express "on this screen,
 * that banner means something different" without a code change.
 */
export function classify(conditions: Condition[], obs: Observation): Classification {
  for (const condition of conditions) {
    const evidence = evaluatePredicate(condition.when, obs);
    if (!evidence.ok) continue;

    switch (condition.then.kind) {
      case 'business':
        return {
          kind: 'business',
          condition,
          code: condition.then.code,
          message: condition.then.message ?? condition.description,
          evidence,
        };
      case 'recover':
        return { kind: 'recover', condition, evidence };
      case 'fail':
        return {
          kind: 'fail',
          condition,
          errorClass: condition.then.errorClass,
          message: condition.then.message,
          evidence,
        };
    }
  }
  return { kind: 'none' };
}

/* --------------------------------------------------------------- reports */

export interface RecoveryAttemptReport {
  conditionId: string;
  handler: string;
  attempt: number;
  ok: boolean;
  note: string;
  at: string;
}

export interface StepReport {
  stepId: string;
  intent: string;
  actionType: string;
  status: 'ok' | 'skipped' | 'business' | 'escalated' | 'failed';
  startedAt: string;
  durationMs: number;
  /** How the descriptor matched — the raw material for the drift signal. */
  resolution?: { score: number; strategy: string; drift: boolean; matched: string };
  checkpoint?: { describe: string; ok: boolean; failed: PredicateResult[] };
  recoveries: RecoveryAttemptReport[];
  note?: string;
}

/**
 * A per-tenant drift signal.
 *
 * The honest answer to "how do you detect UI drift without re-recording
 * everything": you don't diff screenshots, you watch *how* your locators are
 * winning. A descriptor that used to match on accessible name and now only
 * matches structurally still works — and that degradation is the earliest,
 * cheapest signal that this tenant has moved. It costs nothing to collect
 * because the resolver already computed it.
 */
export interface DriftSignal {
  stepId: string;
  intent: string;
  expected: string;
  matched: string;
  score: number;
  strategy: string;
}

export interface ReplayEnvelope {
  runId: string;
  capability: string;
  capabilityVersion: string;
  tenant: string;
  /**
   * Which operator identity the run signed on as, where the product declares
   * named identities. Part of the contract because entitlement changes the
   * answer: SUPERVISOR_OVERRIDE_REQUIRED is only interpretable if the caller
   * knows who was asking.
   */
  identity?: string;
  product: string;
  startedAt: string;
  durationMs: number;
  steps: StepReport[];
  driftSignals: DriftSignal[];
  appliedOverrides: Array<{ tenant: string; path: string; why: string }>;
  evidenceDir: string;
  /** Navigations the allowlist refused during this run. Should normally be empty. */
  blockedNavigations: string[];
}

export interface ReplayFailure {
  /** Stable machine-readable class. Distinct from a business outcome code. */
  class: ErrorClass;
  stepId: string;
  /** The prose intent, so a failure reads like a sentence, not a stack trace. */
  stepIntent: string;
  expected: string;
  observed: string;
  attempts: number;
  recoveriesTried: string[];
  message: string;
}

export type ReplayResult =
  | ({ status: 'success'; outputs: Record<string, unknown> } & ReplayEnvelope)
  | ({
      status: 'business_outcome';
      code: string;
      message: string;
      conditionId: string;
      atStep: string;
      /** Present only if the capability declares outputs survive this outcome. */
      outputs?: Record<string, unknown>;
    } & ReplayEnvelope)
  | ({
      status: 'escalated';
      interventionId: string;
      reason: string;
      atStep: string;
      resolution: 'resumed' | 'abandoned' | 'unattended';
      operatorNote?: string;
    } & ReplayEnvelope)
  | ({ status: 'failed'; error: ReplayFailure } & ReplayEnvelope);

/** One-line summary for a CLI or a log line. */
export function summarize(r: ReplayResult): string {
  switch (r.status) {
    case 'success':
      return `SUCCESS ${r.capability}@${r.capabilityVersion} [${r.tenant}] in ${r.durationMs}ms — outputs: ${JSON.stringify(r.outputs)}`;
    case 'business_outcome':
      return `BUSINESS_OUTCOME ${r.code} at ${r.atStep} — ${r.message}`;
    case 'escalated':
      return `ESCALATED (${r.resolution}) at ${r.atStep} — ${r.reason}`;
    case 'failed':
      return `FAILED ${r.error.class} at ${r.error.stepId} ("${r.error.stepIntent}") — expected ${r.error.expected}; observed ${r.error.observed}`;
  }
}
