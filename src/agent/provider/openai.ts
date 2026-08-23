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
import type { DecideRequest, LlmProvider, ModelTurn } from './types.js';

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
          'or use `--provider mock` to exercise the pipeline offline.',
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

    const res = await this.client.chat.completions.create({
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

  usage(): { promptTokens: number; completionTokens: number; calls: number } {
    return { promptTokens: this.promptTokens, completionTokens: this.completionTokens, calls: this.calls };
  }
}
