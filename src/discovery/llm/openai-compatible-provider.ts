/**
 * A provider for any service that speaks the OpenAI chat-completions API.
 *
 * That is more services than the name suggests: Groq, Together, Fireworks,
 * OpenRouter, vLLM and llama.cpp all implement the same wire format, and OpenAI
 * itself is simply one entry in the registry. Writing one implementation and
 * configuring it per host is honest about that, and it means adding a provider
 * is a few lines of configuration rather than a new class.
 *
 * Two things this deliberately handles rather than ignores:
 *
 * **Vision is optional.** Not every host offers a model that accepts images, and
 * the ones that do often cannot combine images with tool calling. So a provider
 * declares whether it supports vision, and the discovery loop attaches the
 * screenshot only when it does. This costs nothing, because the model acts by
 * element id from the text inventory — the screenshot was always corroboration,
 * never the action space. It is a good test of that design decision that the
 * loop works unchanged against a text-only model.
 *
 * **The two different 429s.** `rate_limit_exceeded` means "slow down" and is
 * worth retrying with backoff; a discovery run makes a burst of calls and will
 * hit it, especially on a free tier. `insufficient_quota` is the *same status
 * code* but means "this account has no credit", which no amount of retrying will
 * fix — retrying it turns a clear billing problem into a slow, confusing one.
 */

import OpenAI from 'openai';
import type { DecideRequest, LlmProvider, ModelTurn } from './llm-provider.js';

export interface ProviderConfig {
  /** Short name used on the command line and in run reports, e.g. "groq". */
  id: string;
  /** Human-readable service name for error messages. */
  label: string;
  /** OpenAI-compatible endpoint. Omit for OpenAI itself. */
  baseUrl?: string;
  /** Environment variable holding the key. Never the key itself. */
  apiKeyEnv: string;
  /** Environment variable that can override the model. */
  modelEnv: string;
  defaultModel: string;
  /** Whether the configured model accepts images alongside text. */
  supportsVision: boolean;
  /** Where to go when the key is missing or the account is unfunded. */
  consoleUrl: string;
}

/** How many times to ask again when the model answers in prose. */
const TOOL_CALL_ATTEMPTS = 3;

const NUDGE =
  'You did not call a tool. You must respond by calling exactly one of the available tools, naming elements by ' +
  'the id in square brackets. If the goal is already achieved, call finish. If you are stuck or the screen has ' +
  'answered in the negative, call give_up. Do not reply with prose.';

/**
 * The model answered in prose when a tool call was required.
 *
 * Given its own class because it arrives differently depending on the host —
 * some return the prose with an empty `tool_calls`, others (Groq) reject their
 * own response with a 400. Both are the same situation, both are retryable, and
 * neither should be confused with a real transport failure.
 */
class NoToolCallError extends Error {
  constructor(detail: string) {
    super(`model answered in prose instead of calling a tool: ${detail}`);
    this.name = 'NoToolCallError';
  }
}

function looksLikeNoToolCall(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e.status === 400 && /did not call a tool|tool_choice/i.test(e.message ?? '');
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly supportsVision: boolean;

  private readonly client: OpenAI;
  private readonly config: ProviderConfig;
  private promptTokens = 0;
  private completionTokens = 0;
  private calls = 0;

  constructor(config: ProviderConfig, overrides: { apiKey?: string; model?: string } = {}) {
    const apiKey = overrides.apiKey ?? process.env[config.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `${config.apiKeyEnv} is not set. Add it to .env to run discovery against ${config.label} ` +
          `(${config.consoleUrl}), or use \`--provider scripted\` to exercise the pipeline offline.`,
      );
    }

    this.config = config;
    this.name = config.id;
    this.model = overrides.model ?? process.env[config.modelEnv] ?? config.defaultModel;
    this.supportsVision = config.supportsVision;
    this.client = new OpenAI({
      apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async decide(req: DecideRequest): Promise<ModelTurn> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: req.system }];

    // History is replayed as plain text rather than as real tool-call messages.
    // It costs a little fidelity and buys a lot: the loop stays provider-shaped
    // rather than OpenAI-shaped, a malformed historical call can never wedge the
    // conversation, and hosts differ in how strictly they validate tool-call
    // history.
    for (const h of req.history) {
      messages.push({
        role: 'assistant',
        content: `${h.turn.reasoning}\nACTION: ${h.turn.toolName}(${JSON.stringify(h.turn.arguments)})`,
      });
      messages.push({ role: 'user', content: `RESULT: ${h.result}` });
    }

    if (req.screenshot && this.supportsVision) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: req.userText },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${req.screenshot.toString('base64')}`, detail: 'high' },
          },
        ],
      });
    } else {
      messages.push({ role: 'user', content: req.userText });
    }

    const tools = req.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    // Open-weight models occasionally answer in prose despite
    // `tool_choice: "required"` — some hosts then reject their own response with
    // a 400 rather than returning it. It is intermittent rather than systematic:
    // the same screen succeeds on a retry. Aborting a whole discovery run over
    // one flaky turn would be the wrong trade, so nudge and ask again, and only
    // give up if the model keeps refusing.
    for (let attempt = 1; attempt <= TOOL_CALL_ATTEMPTS; attempt++) {
      const attemptMessages =
        attempt === 1 ? messages : [...messages, { role: 'user' as const, content: NUDGE }];

      let res: OpenAI.Chat.ChatCompletion;
      try {
        res = await this.completeWithRetry({
          model: this.model,
          messages: attemptMessages,
          tools,
          tool_choice: 'required',
          temperature: 0,
        });
      } catch (err) {
        if (err instanceof NoToolCallError && attempt < TOOL_CALL_ATTEMPTS) continue;
        throw err;
      }

      this.calls += 1;
      this.promptTokens += res.usage?.prompt_tokens ?? 0;
      this.completionTokens += res.usage?.completion_tokens ?? 0;

      const choice = res.choices[0];
      const call = choice?.message.tool_calls?.[0];
      if (!call || call.type !== 'function') {
        if (attempt < TOOL_CALL_ATTEMPTS) continue;
        throw new Error(
          `${this.config.label} returned prose instead of a tool call after ${TOOL_CALL_ATTEMPTS} attempts: ` +
            `${choice?.message.content ?? '(empty response)'}`,
        );
      }

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        if (attempt < TOOL_CALL_ATTEMPTS) continue;
        throw new Error(`${this.config.label} returned unparseable tool arguments: ${call.function.arguments}`);
      }

      return {
        reasoning: String(args.why ?? choice?.message.content ?? '').trim() || `call ${call.function.name}`,
        toolName: call.function.name,
        arguments: args,
      };
    }

    // Unreachable: the loop either returns or throws on its final attempt.
    throw new Error(`${this.config.label} produced no usable tool call`);
  }

  /**
   * Wraps the API call so the loop sees an actionable error rather than a raw
   * HTTP status. "Your key is wrong", "your account is unfunded" and "you cannot
   * reach that model" are the three things people actually hit, and telling them
   * apart is the difference between a five-second fix and an afternoon.
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

        // Surface this as its own type so `decide` can nudge and retry rather
        // than treating a flaky turn as a dead run.
        if (looksLikeNoToolCall(err)) {
          throw new NoToolCallError(e.message ?? 'the host rejected its own response');
        }

        if (e.status === 401 || e.status === 403) {
          throw new Error(
            `${this.config.label} rejected the API key (${e.status}). Check ${this.config.apiKeyEnv} in .env — ` +
              `it may be mistyped, revoked, or belong to a different account. Keys are managed at ` +
              `${this.config.consoleUrl}.`,
          );
        }

        if (e.code === 'insufficient_quota') {
          throw new Error(
            `The ${this.config.label} key is valid but the account has no available quota ` +
              `(429 insufficient_quota). This is a billing state, not a rate limit, so retrying will not help: ` +
              `add credit at ${this.config.consoleUrl}. To exercise the pipeline meanwhile, run discovery with ` +
              '`--provider scripted`.',
          );
        }

        if (e.status === 404) {
          throw new Error(
            `The model "${this.model}" is not available on ${this.config.label} (404). Set ${this.config.modelEnv} ` +
              'in .env to a model this account can reach.',
          );
        }

        const transient = e.status === 429 || (e.status !== undefined && e.status >= 500);
        if (!transient || attempt >= MAX_ATTEMPTS) {
          throw new Error(
            `${this.config.label} request failed (${e.status ?? 'no status'}): ${e.message ?? String(err)}`,
          );
        }

        // Exponential backoff with jitter: 1s, 2s, 4s. Free tiers rate-limit
        // aggressively, and a discovery run is a burst of calls.
        const waitMs = 2 ** (attempt - 1) * 1000 + Math.random() * 250;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  usage(): { promptTokens: number; completionTokens: number; calls: number } {
    return { promptTokens: this.promptTokens, completionTokens: this.completionTokens, calls: this.calls };
  }
}
