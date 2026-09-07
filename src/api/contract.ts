/**
 * What a calling agent actually receives back from an invocation.
 *
 * Defined once, here, and used by the HTTP API, the CLI's `catalog invoke`, and
 * the chatbot. That is deliberate: the agent-facing contract is the product, and
 * three surfaces each projecting the run envelope slightly differently is how a
 * contract quietly stops being one.
 *
 * The shape is a *narrowing* of `ReplayResult`, not a rename of it. The full
 * envelope carries per-step reports, drift signals, resolution scores and
 * blocked navigations — everything a human debugging a run wants and nothing a
 * calling agent should be making decisions on. What crosses the boundary is the
 * four-arm status, the values, and a pointer to the evidence for anyone who
 * needs the rest.
 *
 * Note there is no `error` arm for a business outcome and no `outputs` arm for a
 * failure. The union is the contract: an agent that handles `business_outcome`
 * cannot accidentally read a balance that was never produced.
 */

import type { ReplayResult } from '../replay/replay-result.js';

export interface AgentInvocationResult {
  status: ReplayResult['status'];
  capability: string;
  tenant: string;
  /** Which operator identity ran it, where the product declares them. */
  identity?: string;
  runId: string;
  /** Where the steps, screenshots and structured log for this run were written. */
  evidence: string;
  durationMs: number;
  [arm: string]: unknown;
}

export function sliceForAgent(r: ReplayResult): AgentInvocationResult {
  const base: AgentInvocationResult = {
    status: r.status,
    capability: `${r.capability}@${r.capabilityVersion}`,
    tenant: r.tenant,
    ...(r.identity ? { identity: r.identity } : {}),
    runId: r.runId,
    evidence: r.evidenceDir,
    durationMs: r.durationMs,
  };

  switch (r.status) {
    case 'success':
      return { ...base, outputs: r.outputs };

    case 'business_outcome':
      // `code` is the machine-readable answer an agent branches on; `message` is
      // the declared meaning from the artifact, so the caller gets the reviewed
      // wording rather than whatever text happened to be on the screen.
      return { ...base, code: r.code, message: r.message, ...(r.outputs ? { outputs: r.outputs } : {}) };

    case 'escalated':
      return {
        ...base,
        resolution: r.resolution,
        reason: r.reason,
        atStep: r.atStep,
        interventionId: r.interventionId,
        ...(r.operatorNote ? { operatorNote: r.operatorNote } : {}),
      };

    case 'failed':
      return { ...base, error: r.error };
  }
}

/**
 * One sentence a person can read, derived from the structured result.
 *
 * Lives beside the contract rather than in the chatbot because the phrasing is
 * a property of the four arms — in particular that a business outcome is an
 * *answer*. A front door that renders `SUPERVISOR_OVERRIDE_REQUIRED` as
 * "something went wrong" has undone the most important distinction the engine
 * makes, and that should not be re-decided per surface.
 */
export function plainLanguage(r: AgentInvocationResult): string {
  switch (r.status) {
    case 'success':
      return `Done. ${r.capability} completed in ${r.durationMs}ms.`;
    case 'business_outcome':
      return `The application answered: ${String(r.code)}. ${String(r.message ?? '')}`.trim();
    case 'escalated':
      return r.resolution === 'resumed'
        ? `A person completed a step and the run continued.`
        : `Stopped and handed to a person: ${String(r.reason ?? '')}`.trim();
    case 'failed': {
      const e = r.error as { message?: string; class?: string } | undefined;
      return `The run could not complete (${e?.class ?? 'error'}): ${e?.message ?? 'no detail'}`;
    }
    default:
      return `Unrecognised result status "${String(r.status)}".`;
  }
}
