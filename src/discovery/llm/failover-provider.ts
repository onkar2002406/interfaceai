/**
 * One provider that is really several, tried in order.
 *
 * The motivating case is a free tier. Groq's free plan allows 8,000 tokens per
 * minute on the models that support tool calling, and a single discovery run
 * spends 7k-31k prompt tokens across 4-10 calls — so a run that starts fine
 * gets a 429 partway through, and the whole thing dies holding a browser open.
 * A paid OpenAI key sitting unused in the same `.env` is the obvious answer,
 * and it should not require noticing the failure and re-running by hand.
 *
 * This wrapper is deliberately thin. It does not retry, back off, or reason
 * about HTTP — each concrete provider already does all of that internally, with
 * knowledge of its own host. The only judgement here is *when to stop asking
 * this host and ask the next one*, which is exactly one decision and is made
 * from a typed `ProviderFailure.kind` rather than by matching message text.
 */

import { ProviderFailure } from './openai-compatible-provider.js';
import type { DecideRequest, LlmProvider, ModelTurn } from './llm-provider.js';

export interface ProviderSwitch {
  from: string;
  to: string;
  /** The `ProviderFailure.kind` that caused it, for the evidence log. */
  kind: string;
  reason: string;
}

/**
 * Buffers switches until there is somewhere to put them.
 *
 * The provider has to exist before the run does — the CLI and the panel both
 * build it while validating the request, and only create the `RunRecorder`
 * once the run actually starts. Without a buffer, a provider that failed over
 * on its very first call would have nowhere to report it, and the one switch
 * most worth seeing (the primary was already exhausted when the run began)
 * would be the one that never reached the evidence log.
 */
export class SwitchLog {
  private readonly entries: ProviderSwitch[] = [];
  private sink: ((s: ProviderSwitch) => void) | undefined;

  record(s: ProviderSwitch): void {
    this.entries.push(s);
    this.sink?.(s);
  }

  /** Attach the real destination, replaying anything recorded before it existed. */
  pipeTo(sink: (s: ProviderSwitch) => void): void {
    this.sink = sink;
    for (const e of this.entries) sink(e);
  }

  all(): readonly ProviderSwitch[] {
    return this.entries;
  }
}

export class FailoverProvider implements LlmProvider {
  /**
   * Index of the provider currently in use.
   *
   * Sticky: once a run has fallen through to the fallback it stays there. The
   * alternative — retrying the primary on every turn — spends a doomed request
   * against an exhausted quota before each real one, doubles the wall-clock
   * cost of every remaining step, and produces an event log that alternates
   * between two providers for reasons no reader can reconstruct. A rate limit
   * that just tripped is not going to have cleared by the next turn.
   */
  private active = 0;

  constructor(
    private readonly chain: LlmProvider[],
    private readonly onSwitch?: (s: ProviderSwitch) => void,
  ) {
    if (chain.length === 0) throw new Error('FailoverProvider needs at least one provider');
  }

  /**
   * Reported from the *active* provider, so a compiled artifact's
   * `provenance.model` names the model that actually drove the run rather than
   * the one that was tried first and failed.
   */
  get name(): string {
    return this.chain[this.active]!.name;
  }

  get model(): string {
    return this.chain[this.active]!.model;
  }

  /**
   * Also the active provider's, and that is load-bearing rather than lazy.
   *
   * The screenshot is attached inside each concrete provider, guarded by its own
   * `supportsVision`. So a chain of text-only Groq then vision-capable OpenAI
   * needs no special case here: before the switch nothing sends an image, after
   * it the fallback may. Trying to compute one answer for the whole chain would
   * either send images to a host that rejects them or withhold them from one
   * that wants them.
   */
  get supportsVision(): boolean {
    return this.chain[this.active]!.supportsVision;
  }

  async decide(req: DecideRequest): Promise<ModelTurn> {
    let lastError: unknown;

    for (let i = this.active; i < this.chain.length; i++) {
      const provider = this.chain[i]!;
      try {
        const turn = await provider.decide(req);
        this.active = i;
        return turn;
      } catch (err) {
        lastError = err;

        // Our own schema is the problem, not the host's. The next provider gets
        // the identical tool definitions and fails identically, so falling
        // through would spend a second quota to arrive at the same error.
        if (err instanceof ProviderFailure && !err.failoverWorthwhile) throw err;

        const next = this.chain[i + 1];
        if (!next) break;

        const kind = err instanceof ProviderFailure ? err.kind : 'unknown';
        this.active = i + 1;
        // Announced rather than silent: a run that quietly moved onto a paid key
        // because a free one ran out is exactly the kind of thing that should be
        // visible in the evidence log before it is visible on an invoice.
        this.onSwitch?.({
          from: `${provider.name}:${provider.model}`,
          to: `${next.name}:${next.model}`,
          kind,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    throw lastError instanceof Error
      ? new Error(
          `every configured model provider failed. Last error, from ` +
            `${this.chain[this.chain.length - 1]!.name}: ${lastError.message}`,
        )
      : new Error(`every configured model provider failed: ${String(lastError)}`);
  }

  /**
   * Summed across the whole chain, because a run that switched genuinely spent
   * tokens on both. Reporting only the active provider's usage would understate
   * a failed-over run by however much the primary burned before it gave up.
   */
  usage(): { promptTokens: number; completionTokens: number; calls: number } {
    return this.chain.reduce(
      (acc, p) => {
        const u = p.usage();
        return {
          promptTokens: acc.promptTokens + u.promptTokens,
          completionTokens: acc.completionTokens + u.completionTokens,
          calls: acc.calls + u.calls,
        };
      },
      { promptTokens: 0, completionTokens: 0, calls: 0 },
    );
  }

  /** The chain as configured, for the panel's provider badge and CLI output. */
  describe(): string {
    return this.chain.map((p, i) => `${i === this.active ? '*' : ''}${p.name}:${p.model}`).join(' → ');
  }
}
