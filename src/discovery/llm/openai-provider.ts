/**
 * OpenAI provider.
 *
 * Uses function calling with `tool_choice: "required"`, so the model must
 * answer with a tool call rather than prose. The loop needs a decision on every
 * turn; letting the model reply with an essay is a failure mode we can simply
 * remove by construction.
 *
 * The screenshot is attached alongside the text inventory. It is not what the
 * model acts on — actions are always by element id — but it disambiguates layout
 * in a way a flat list cannot ("the box at the top of the form" versus "the one
 * in the results table"), and it is what a person would look at.
 */

import OpenAI from 'openai';
import type { DecideRequest, LlmProvider, ModelTurn } from './llm-provider.js';

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  readonly model: string;
  private readonly client: OpenAI;
  private promptTokens = 0;
  private completionTokens = 0;
  private calls = 0;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY is not set. Add it to .env to run discovery against a live model, ' +
          'or use `--provider scripted` to exercise the pipeline offline.',
      );
    }
    this.client = new OpenAI({ apiKey });
    this.model = opts.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o';
  }

  async decide(req: DecideRequest): Promise<ModelTurn> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: req.system }];

    // History is replayed as plain text rather than as real tool-call messages.
    // It costs a little fidelity and buys a lot: the loop stays provider-shaped
    // rather than OpenAI-shaped, and a malformed historical call can never
    // wedge the conversation.
    for (const h of req.history) {
      messages.push({
        role: 'assistant',
        content: `${h.turn.reasoning}\nACTION: ${h.turn.toolName}(${JSON.stringify(h.turn.arguments)})`,
      });
      messages.push({ role: 'user', content: `RESULT: ${h.result}` });
    }

    const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: 'text', text: req.userText }];
    if (req.screenshot) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${req.screenshot.toString('base64')}`, detail: 'high' },
      });
    }
    messages.push({ role: 'user', content });

    const res = await this.completeWithRetry({
      model: this.model,
      messages,
      tools: req.tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'required',
      temperature: 0,
    });

    this.calls += 1;
    this.promptTokens += res.usage?.prompt_tokens ?? 0;
    this.completionTokens += res.usage?.completion_tokens ?? 0;

    const choice = res.choices[0];
    const call = choice?.message.tool_calls?.[0];
    if (!call || call.type !== 'function') {
      throw new Error(`model did not return a tool call: ${choice?.message.content ?? '(empty response)'}`);
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      throw new Error(`model returned unparseable tool arguments: ${call.function.arguments}`);
    }

    return {
      reasoning: String(args.why ?? choice?.message.content ?? '').trim() || `call ${call.function.name}`,
      toolName: call.function.name,
      arguments: args,
    };
  }

  /**
   * Wraps the API call so the loop sees an actionable error rather than a raw
   * HTTP status.
   *
   * The distinction that matters most in practice is between the two 429s.
   * `rate_limit_exceeded` means "you are going too fast" and is worth retrying
   * with backoff — a discovery run makes a burst of calls and will hit it.
   * `insufficient_quota` is the *same status code* but means "this account has
   * no credit", which no amount of retrying will fix; retrying it just turns a
   * clear billing problem into a slow, confusing one.
   *
   * A 401 gets its own message too, because "your key is wrong" and "your
   * account is unfunded" are the two things people actually hit, and telling
   * them apart is the difference between a five-second fix and an afternoon.
   */
  private async completeWithRetry(
    body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.ChatCompletion> {
    const MAX_ATTEMPTS = 4;

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.client.chat.completions.create(body);
      } catch (err) {
        const e = err as { status?: number; code?: string; message?: string };

        if (e.status === 401) {
          throw new Error(
            'OpenAI rejected the API key (401). Check OPENAI_API_KEY in .env — it may be mistyped, revoked, ' +
              'or belong to a different organisation than the one you expect.',
          );
        }

        if (e.code === 'insufficient_quota') {
          throw new Error(
            'The OpenAI API key is valid but the account has no available quota (429 insufficient_quota). ' +
              'This is a billing state, not a rate limit, so retrying will not help: add a payment method or ' +
              'credits at https://platform.openai.com/settings/organization/billing. A discovery run costs a ' +
              'few cents. To exercise the pipeline meanwhile, run discovery with `--provider scripted`.',
          );
        }

        if (e.status === 404) {
          throw new Error(
            `The model "${this.model}" is not available to this account (404). Set OPENAI_MODEL in .env to a ` +
              'model your organisation can access.',
          );
        }

        const transient = e.status === 429 || (e.status !== undefined && e.status >= 500);
        if (!transient || attempt >= MAX_ATTEMPTS) {
          throw new Error(`OpenAI request failed (${e.status ?? 'no status'}): ${e.message ?? String(err)}`);
        }

        // Exponential backoff with jitter: 1s, 2s, 4s.
        const waitMs = 2 ** (attempt - 1) * 1000 + Math.random() * 250;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  usage(): { promptTokens: number; completionTokens: number; calls: number } {
    return { promptTokens: this.promptTokens, completionTokens: this.completionTokens, calls: this.calls };
  }
}
