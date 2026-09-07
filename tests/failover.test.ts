/**
 * Provider failover.
 *
 * The behaviour worth pinning is not "it tries the next one" — it is the three
 * rules that make failover safe to leave switched on by default:
 *
 *   1. It does NOT fall through on `bad_arguments`, because that failure is our
 *      own tool schema and the next host fails identically. Falling through
 *      there spends a second quota to reach the same error.
 *   2. It is sticky. A rate limit that just tripped has not cleared by the next
 *      turn, so retrying the primary every step would spend a doomed request
 *      before each real one.
 *   3. It reports the *active* provider and the *summed* usage, so a compiled
 *      artifact's provenance names the model that actually drove the run and a
 *      failed-over run does not under-report what it spent.
 *
 * These are cheap to get wrong and expensive to notice: every one of them shows
 * up as a slightly-too-large bill or a slightly-wrong artifact rather than as a
 * crash.
 */

import { describe, expect, it } from 'vitest';
import { FailoverProvider, SwitchLog, type ProviderSwitch } from '../src/discovery/llm/failover-provider.js';
import { ProviderFailure } from '../src/discovery/llm/openai-compatible-provider.js';
import type { DecideRequest, LlmProvider, ModelTurn } from '../src/discovery/llm/llm-provider.js';

/* ------------------------------------------------------------- fixtures */

const REQ: DecideRequest = { system: 's', userText: 'u', history: [], tools: [] };

/** A provider that fails a fixed number of times, then answers. */
function stub(opts: {
  name: string;
  model?: string;
  failWith?: ProviderFailure | Error;
  failTimes?: number;
  supportsVision?: boolean;
}): LlmProvider & { calls: number } {
  let seen = 0;
  const failTimes = opts.failTimes ?? (opts.failWith ? Infinity : 0);
  return {
    name: opts.name,
    model: opts.model ?? `${opts.name}-model`,
    supportsVision: opts.supportsVision ?? false,
    calls: 0,
    async decide(): Promise<ModelTurn> {
      this.calls += 1;
      if (seen++ < failTimes && opts.failWith) throw opts.failWith;
      return { reasoning: `from ${opts.name}`, toolName: 'noop', arguments: {} };
    },
    usage: () => ({ promptTokens: 100, completionTokens: 10, calls: 1 }),
  };
}

const rateLimited = (id: string) => new ProviderFailure('429 rate limit', 'rate_limit', id);
const badArgs = (id: string) => new ProviderFailure('unparseable tool arguments', 'bad_arguments', id);

/* ---------------------------------------------------------------- tests */

describe('failing over to the next provider', () => {
  it('falls through to the fallback when the primary rate-limits', async () => {
    const primary = stub({ name: 'groq', failWith: rateLimited('groq') });
    const fallback = stub({ name: 'openai' });

    const turn = await new FailoverProvider([primary, fallback]).decide(REQ);

    expect(turn.reasoning).toBe('from openai');
    expect(fallback.calls).toBe(1);
  });

  it('falls through on prose-instead-of-a-tool-call, the case that killed real runs', async () => {
    // Groq's gpt-oss-120b rejects its own prose with a 400. Before failover
    // this ended the run; the whole point is that a paid key already in .env
    // should rescue it.
    const primary = stub({ name: 'groq', failWith: new ProviderFailure('prose', 'no_tool_call', 'groq') });
    const fallback = stub({ name: 'openai' });

    await expect(new FailoverProvider([primary, fallback]).decide(REQ)).resolves.toMatchObject({
      reasoning: 'from openai',
    });
  });

  it('does NOT fall through when our own tool schema is the problem', async () => {
    const primary = stub({ name: 'groq', failWith: badArgs('groq') });
    const fallback = stub({ name: 'openai' });

    await expect(new FailoverProvider([primary, fallback]).decide(REQ)).rejects.toThrow(
      /unparseable tool arguments/,
    );
    // The fallback would have failed identically, so it must not have been asked.
    expect(fallback.calls).toBe(0);
  });

  it('reports every provider failing, naming the last error', async () => {
    const primary = stub({ name: 'groq', failWith: rateLimited('groq') });
    const fallback = stub({ name: 'openai', failWith: rateLimited('openai') });

    await expect(new FailoverProvider([primary, fallback]).decide(REQ)).rejects.toThrow(
      /every configured model provider failed/,
    );
  });
});

describe('stickiness', () => {
  it('stays on the fallback for the rest of the run', async () => {
    // Primary fails only once. A non-sticky implementation would go back to it
    // on the second call and succeed, which is what we do not want: the retry
    // costs a doomed request against a quota that has not recovered.
    const primary = stub({ name: 'groq', failWith: rateLimited('groq'), failTimes: 1 });
    const fallback = stub({ name: 'openai' });
    const provider = new FailoverProvider([primary, fallback]);

    await provider.decide(REQ);
    await provider.decide(REQ);
    await provider.decide(REQ);

    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(3);
  });
});

describe('what the run reports afterwards', () => {
  it('names the active provider, so provenance records what actually drove the run', async () => {
    const provider = new FailoverProvider([
      stub({ name: 'groq', model: 'gpt-oss-120b', failWith: rateLimited('groq') }),
      stub({ name: 'openai', model: 'gpt-4o' }),
    ]);

    expect(provider.model).toBe('gpt-oss-120b');
    await provider.decide(REQ);
    expect(provider.name).toBe('openai');
    expect(provider.model).toBe('gpt-4o');
  });

  it('follows the active provider for vision, so a text-only primary is never sent an image', async () => {
    const provider = new FailoverProvider([
      stub({ name: 'groq', supportsVision: false, failWith: rateLimited('groq') }),
      stub({ name: 'openai', supportsVision: true }),
    ]);

    expect(provider.supportsVision).toBe(false);
    await provider.decide(REQ);
    expect(provider.supportsVision).toBe(true);
  });

  it('sums usage across the chain, because a failed-over run really spent both', async () => {
    const provider = new FailoverProvider([
      stub({ name: 'groq', failWith: rateLimited('groq') }),
      stub({ name: 'openai' }),
    ]);

    await provider.decide(REQ);

    // 100 prompt tokens from each stub — reporting only the active one would
    // understate the run by whatever the primary burned before giving up.
    expect(provider.usage().promptTokens).toBe(200);
  });

  it('announces the switch with both models and the reason', async () => {
    const seen: ProviderSwitch[] = [];
    await new FailoverProvider(
      [stub({ name: 'groq', model: 'gpt-oss-120b', failWith: rateLimited('groq') }), stub({ name: 'openai', model: 'gpt-4o' })],
      (s) => seen.push(s),
    ).decide(REQ);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ from: 'groq:gpt-oss-120b', to: 'openai:gpt-4o', kind: 'rate_limit' });
  });
});

describe('SwitchLog', () => {
  it('replays switches recorded before the run recorder existed', () => {
    // The ordering this defends: the provider is built while a request is being
    // validated, and the RunRecorder only exists once the run starts. A
    // failover on the very first call is the one most worth seeing, and is
    // exactly the one that would be lost without buffering.
    const log = new SwitchLog();
    log.record({ from: 'groq:a', to: 'openai:b', kind: 'rate_limit', reason: '429' });

    const delivered: ProviderSwitch[] = [];
    log.pipeTo((s) => delivered.push(s));

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.from).toBe('groq:a');
  });

  it('keeps delivering after the sink is attached', () => {
    const log = new SwitchLog();
    const delivered: ProviderSwitch[] = [];
    log.pipeTo((s) => delivered.push(s));
    log.record({ from: 'groq:a', to: 'openai:b', kind: 'server', reason: '503' });

    expect(delivered).toHaveLength(1);
    expect(log.all()).toHaveLength(1);
  });
});
