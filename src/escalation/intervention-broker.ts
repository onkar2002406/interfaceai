/**
 * Intervention routing.
 *
 * When automation cannot safely continue, it does not fail — it *parks*. The
 * broker is where a parked run waits, and it is the only thing that knows how
 * to wake it up.
 *
 * The shape that matters:
 *
 *   - Raising an intervention **cedes control** (via ControlAuthority) before
 *     the request is visible to anyone. There is no window in which both a
 *     human and the executor believe they may act.
 *   - The request carries enough context to act on *without* reading the code:
 *     which capability, which step and its plain-English intent, why we stopped,
 *     the current screen, and — critically — the **resume contract**: the
 *     condition that must hold before automation is allowed to take over again.
 *   - Handing back does not resume anything. It moves to RESUMING and lets the
 *     executor re-observe and check the resume contract itself. A human saying
 *     "done" is a claim, not a fact; the executor verifies it.
 *   - Everything the human does is recorded as evidence against the same run.
 *
 * The unattended default is deliberate: with no operator console running, a run
 * that needs a human returns `unattended` promptly rather than hanging forever.
 * A production deployment would swap that for a queue with an on-call rota; the
 * seam is this interface.
 */

import { randomUUID } from 'node:crypto';
import type { Checkpoint } from '../capability/schema.js';
import type { ControlAuthority, ControlToken } from './control-authority.js';
import type { Surface } from '../surface/types.js';

export type InterventionReasonClass =
  | 'policy_irreversible'
  | 'ambiguous_target'
  | 'target_not_found'
  | 'unrecovered_condition'
  | 'checkpoint_failed'
  | 'agent_stuck';

export interface InterventionRequest {
  id: string;
  runId: string;
  sessionId: string;
  createdAt: string;
  capability: { name: string; version: string; title: string };
  tenant: string;
  atStep: { id: string; intent: string; index: number; total: number };
  reasonClass: InterventionReasonClass;
  reason: string;
  /** Already redacted by the caller. */
  params: Record<string, unknown>;
  screenshotPath?: string;
  /** Redacted excerpt of what is on screen, for operators without the screenshot. */
  observedText: string;
  resumeContract: { describe: string; checkpoint?: Checkpoint };
}

export interface HumanAction {
  at: string;
  kind: 'click' | 'key' | 'navigate' | 'note';
  detail: Record<string, unknown>;
}

export type InterventionOutcome =
  | { resolution: 'resumed'; operator: string; note: string; actions: HumanAction[] }
  | { resolution: 'abandoned'; reason: string; actions: HumanAction[] }
  | { resolution: 'unattended'; reason: string; actions: [] };

export interface EscalationSink {
  raise(req: InterventionRequest, ctx: EscalationContext): Promise<InterventionOutcome>;
}

export interface EscalationContext {
  authority: ControlAuthority;
  surface: Surface;
  /** Called with each human action so the run log records it live. */
  onHumanAction?: (a: HumanAction) => void;
}

/* --------------------------------------------------------- unattended sink */

/**
 * Default when nobody is watching. Cedes and immediately reclaims control so the
 * authority's history still records that an intervention was needed — the run
 * report should show "this required a human and none was available", which is
 * operationally different from "this failed".
 */
export class UnattendedSink implements EscalationSink {
  async raise(req: InterventionRequest, ctx: EscalationContext): Promise<InterventionOutcome> {
    // Cede first, then abandon. Going straight to abandon would skip the
    // PENDING_HUMAN transition, and the authority correctly refuses that — the
    // state machine is not decoration, and the unattended path has to obey it
    // like everything else.
    ctx.authority.requestIntervention(`${req.reasonClass}: ${req.reason}`);
    ctx.authority.abandon('no operator console attached');
    return {
      resolution: 'unattended',
      reason:
        `intervention ${req.id} required a human operator but no operator console is attached. ` +
        `Re-run with --operator to start one and take control of the live session.`,
      actions: [],
    };
  }
}

/* -------------------------------------------------------------- live broker */

interface Pending {
  request: InterventionRequest;
  ctx: EscalationContext;
  actions: HumanAction[];
  operator?: string;
  operatorToken?: ControlToken;
  settle: (o: InterventionOutcome) => void;
  timer: NodeJS.Timeout;
  claimedAt?: string;
}

export interface BrokerOptions {
  /** How long a request waits for a human before it is abandoned. */
  waitMs?: number;
}

/**
 * In-process broker shared by the executor and the operator console.
 *
 * Single process is a deliberate simplification, not an oversight: a real
 * deployment needs a durable queue so a request survives a worker restart, but
 * building that here would be scaling infrastructure the brief explicitly says
 * not to build. The interface (`EscalationSink`) is the seam where it goes.
 */
export class InterventionBroker implements EscalationSink {
  private readonly pending = new Map<string, Pending>();
  private readonly history: Array<{ request: InterventionRequest; outcome: InterventionOutcome }> = [];
  private readonly waitMs: number;
  private readonly listeners = new Set<() => void>();

  constructor(opts: BrokerOptions = {}) {
    this.waitMs = opts.waitMs ?? 10 * 60 * 1000;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* a broken listener must not break the run */
      }
    }
  }

  raise(request: InterventionRequest, ctx: EscalationContext): Promise<InterventionOutcome> {
    // Cede control BEFORE the request becomes visible. No overlap window.
    ctx.authority.requestIntervention(`${request.reasonClass}: ${request.reason}`);

    return new Promise<InterventionOutcome>((resolveOuter) => {
      const entry: Pending = {
        request,
        ctx,
        actions: [],
        settle: (o) => {
          clearTimeout(entry.timer);
          this.pending.delete(request.id);
          this.history.push({ request, outcome: o });
          this.notify();
          resolveOuter(o);
        },
        timer: setTimeout(() => {
          try {
            ctx.authority.abandon('operator did not respond in time');
          } catch {
            /* already moved on */
          }
          entry.settle({
            resolution: 'abandoned',
            reason: `no operator claimed intervention ${request.id} within ${Math.round(this.waitMs / 1000)}s`,
            actions: entry.actions,
          });
        }, this.waitMs),
      };
      this.pending.set(request.id, entry);
      this.notify();
    });
  }

  /* --------------------------- operator-facing API --------------------------- */

  list(): InterventionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  detail(id: string): (Pending & { state: string }) | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    return { ...p, state: p.ctx.authority.currentState() };
  }

  /** Transfers control of the LIVE session to a named operator. */
  claim(id: string, operator: string): { token: ControlToken; request: InterventionRequest } {
    const p = this.pending.get(id);
    if (!p) throw new Error(`No open intervention "${id}"`);
    if (p.operator) throw new Error(`Intervention "${id}" is already held by ${p.operator}`);
    const token = p.ctx.authority.claim(operator);
    p.operator = operator;
    p.operatorToken = token;
    p.claimedAt = new Date().toISOString();
    this.record(id, { at: p.claimedAt, kind: 'note', detail: { claimedBy: operator } });
    this.notify();
    return { token, request: p.request };
  }

  /** The token the operator console must present to drive the live surface. */
  operatorToken(id: string): ControlToken {
    const p = this.pending.get(id);
    if (!p?.operatorToken) throw new Error(`Intervention "${id}" has not been claimed`);
    return p.operatorToken;
  }

  surfaceFor(id: string): Surface {
    const p = this.pending.get(id);
    if (!p) throw new Error(`No open intervention "${id}"`);
    return p.ctx.surface;
  }

  record(id: string, action: HumanAction): void {
    const p = this.pending.get(id);
    if (!p) return;
    p.actions.push(action);
    p.ctx.onHumanAction?.(action);
  }

  /**
   * The human says they are done. Control moves to RESUMING — NOT to
   * AUTOMATION. The executor re-observes and checks the resume contract before
   * it is allowed to act again.
   */
  handBack(id: string, note: string): void {
    const p = this.pending.get(id);
    if (!p) throw new Error(`No open intervention "${id}"`);
    if (!p.operator) throw new Error(`Intervention "${id}" was never claimed`);
    p.ctx.authority.handBack(note || 'handed back by operator');
    this.record(id, { at: new Date().toISOString(), kind: 'note', detail: { handBack: note } });
    p.settle({ resolution: 'resumed', operator: p.operator, note, actions: p.actions });
  }

  abandon(id: string, reason: string): void {
    const p = this.pending.get(id);
    if (!p) throw new Error(`No open intervention "${id}"`);
    p.ctx.authority.abandon(reason);
    p.settle({ resolution: 'abandoned', reason, actions: p.actions });
  }

  resolved(): ReadonlyArray<{ request: InterventionRequest; outcome: InterventionOutcome }> {
    return this.history;
  }
}

export function newInterventionId(): string {
  return `int_${randomUUID().slice(0, 8)}`;
}
