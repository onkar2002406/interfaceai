/**
 * Control transfer.
 *
 * The central question in the human-in-the-loop requirement is not "how do we
 * show a human the screen" — it's "who is allowed to act on this session right
 * now, and how do we make that unambiguous". Answering it with a boolean flag
 * that the executor is trusted to check is how you get a race where automation
 * clicks Submit while an operator is mid-keystroke on the same page.
 *
 * So control is a *capability token*, not a flag. `Surface.act()` demands a
 * token and compares it to the authority's current holder. An executor holding
 * a stale token cannot act, even if it never checks the state machine. This is
 * the same chokepoint the allowlist uses, so one mechanism enforces both
 * "may this actor act at all" and "is this action permitted".
 *
 *   AUTOMATION ─request_intervention→ PENDING_HUMAN ─claim→ HUMAN
 *        ↑                                  │                 │
 *        └──────── RESUMING ←───────────────┴── abandon ──────┘ hand_back
 */

import { randomUUID } from 'node:crypto';

export type ControlState = 'AUTOMATION' | 'PENDING_HUMAN' | 'HUMAN' | 'RESUMING';

export type Holder = 'automation' | 'human' | 'nobody';

export interface ControlToken {
  readonly id: string;
  readonly holder: Holder;
  readonly sessionId: string;
}

export class ControlViolation extends Error {
  constructor(
    message: string,
    readonly detail: { expected: Holder; presented: Holder; state: ControlState },
  ) {
    super(message);
    this.name = 'ControlViolation';
  }
}

export interface ControlTransition {
  at: string;
  from: ControlState;
  to: ControlState;
  reason: string;
}

export class ControlAuthority {
  private state: ControlState = 'AUTOMATION';
  private token: ControlToken;
  private readonly log: ControlTransition[] = [];

  constructor(readonly sessionId: string) {
    this.token = { id: randomUUID(), holder: 'automation', sessionId };
  }

  currentState(): ControlState {
    return this.state;
  }

  history(): readonly ControlTransition[] {
    return this.log;
  }

  /**
   * The token the automation executor should carry. Returns the live token only
   * while automation actually holds control — otherwise it hands back a token
   * whose holder no longer matches, which `assert` will reject.
   */
  automationToken(): ControlToken {
    return this.token;
  }

  /** Rotates the token so any previously issued copy becomes unusable. */
  private rotate(holder: Holder): ControlToken {
    this.token = { id: randomUUID(), holder, sessionId: this.sessionId };
    return this.token;
  }

  private transition(to: ControlState, reason: string): void {
    this.log.push({ at: new Date().toISOString(), from: this.state, to, reason });
    this.state = to;
  }

  /**
   * Throws unless `token` is the live token AND its holder matches who the
   * state machine believes is in control. Called on every single action.
   */
  assert(token: ControlToken, actor: Holder): void {
    const expected: Holder =
      this.state === 'AUTOMATION' ? 'automation' : this.state === 'HUMAN' ? 'human' : 'nobody';

    if (token.id !== this.token.id || token.holder !== actor || expected !== actor) {
      throw new ControlViolation(
        `${actor} attempted to act while control state is ${this.state} (holder: ${expected})`,
        { expected, presented: actor, state: this.state },
      );
    }
  }

  /** Automation gives up control and parks the session awaiting a human. */
  requestIntervention(reason: string): void {
    if (this.state !== 'AUTOMATION') {
      throw new ControlViolation(`cannot request intervention from ${this.state}`, {
        expected: 'automation',
        presented: 'automation',
        state: this.state,
      });
    }
    this.rotate('nobody');
    this.transition('PENDING_HUMAN', reason);
  }

  /** An operator picks up the request and receives a token that lets them act. */
  claim(operator: string): ControlToken {
    if (this.state !== 'PENDING_HUMAN') {
      throw new ControlViolation(`cannot claim control from ${this.state}`, {
        expected: 'nobody',
        presented: 'human',
        state: this.state,
      });
    }
    const t = this.rotate('human');
    this.transition('HUMAN', `claimed by ${operator}`);
    return t;
  }

  /**
   * The human is done. Control moves to RESUMING — deliberately NOT straight
   * back to AUTOMATION: the executor must first re-observe and re-verify the
   * resume contract before it is allowed to act again.
   */
  handBack(note: string): void {
    if (this.state !== 'HUMAN') {
      throw new ControlViolation(`cannot hand back from ${this.state}`, {
        expected: 'human',
        presented: 'human',
        state: this.state,
      });
    }
    this.rotate('nobody');
    this.transition('RESUMING', note);
  }

  /** Nobody claimed the request in time; automation reclaims to fail cleanly. */
  abandon(reason: string): void {
    if (this.state !== 'PENDING_HUMAN' && this.state !== 'HUMAN') {
      throw new ControlViolation(`cannot abandon from ${this.state}`, {
        expected: 'nobody',
        presented: 'automation',
        state: this.state,
      });
    }
    this.rotate('nobody');
    this.transition('RESUMING', `abandoned: ${reason}`);
  }

  /**
   * Called by the executor once it has re-observed the surface and confirmed the
   * resume contract holds. Only then does it get a usable token back.
   */
  resumeAutomation(reason: string): ControlToken {
    if (this.state !== 'RESUMING') {
      throw new ControlViolation(`cannot resume automation from ${this.state}`, {
        expected: 'nobody',
        presented: 'automation',
        state: this.state,
      });
    }
    const t = this.rotate('automation');
    this.transition('AUTOMATION', reason);
    return t;
  }
}
