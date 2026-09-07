/**
 * The chatbot — a conversational front door over the capability API.
 *
 * Deliberately thin. It is a demo driver, not a second product: it turns a
 * sentence into the right capability invocation, calls the same API an agent
 * would, and reports what came back in plain language beside the structured
 * result. Everything load-bearing — validation, guardrails, evidence,
 * escalation — happens underneath it, unchanged.
 *
 * ## It reuses the discovery LLM seam rather than adding a second one
 *
 * `LlmProvider.decide()` already does exactly what a tool-calling chatbot needs:
 * given a situation and a bounded set of tools, choose one and say why. So the
 * chatbot's tool set is the capability catalog **plus two synthetic tools**,
 * `reply_to_user` and `discover_capability`, and the loop runs until the model
 * calls the first of them.
 *
 * That is not a trick to avoid writing code — it is the same framing the rest of
 * the system uses. A model is a decision-maker over a bounded, declared set of
 * actions, in the chatbot exactly as in discovery. It also means there is one
 * provider abstraction to keep working, one place that handles a host answering
 * in prose, and one place that counts tokens.
 *
 * ## Two loops behind one door
 *
 * `discover_capability` is what the model reaches for when nothing recorded does
 * what was asked. It runs the *same* goal-driven observe → decide → act loop the
 * panel's goal form runs, against the same policy, and compiles the result with
 * the same deterministic compiler. So a request the system has never seen is
 * answered by working it out live, and a request it has seen is answered by
 * replaying a reviewed recording with no model in the decision loop. Which of
 * the two happened is visible in the transcript, never blurred.
 *
 * ## The safety properties that make the wrapper acceptable
 *
 * **The chatbot cannot authorise an irreversible action.** It composes a request
 * body; authorisation lives in a header the API reads (see `server.ts`). There
 * is no argument the model can emit, and no phrasing a user can type, that sets
 * it. So "transfer $50 from A to B" drives the flow right up to `Post Transfer`,
 * and then the run parks and escalates to a human.
 *
 * **The discovery fallback cannot become a way around that.** Discovery runs
 * under `mode: 'discovery'`, where the policy refuses every irreversible action
 * unconditionally and at any confidence — exploring by pressing "Post Transfer"
 * in a bank is not acceptable even once. A model that decides to discover its
 * way to a transfer gets refused by the same rule that refuses it a shortcut.
 *
 * That is the demo, not a limitation. A natural-language front door that could
 * talk its way past the irreversible gate would have made the gate decorative.
 *
 * ## Why this streams
 *
 * A capability invocation drives a real browser for tens of seconds. The first
 * version of this endpoint awaited the whole thing and returned a blob, which
 * meant the most interesting part of the system — the steps, and the moment a
 * run stops for a human — was invisible to the person who asked for it. With
 * `Accept: text/event-stream` the same loop reports as it goes, and the run ids
 * it emits let the client subscribe to the step stream that already existed.
 * The JSON response is kept verbatim for programmatic callers.
 */

import type { Express, Request, Response } from 'express';
import { CapabilityInputError, validateInputs } from '../replay/executor.js';
import type { Catalog } from '../capability/catalog.js';
import type { CapabilityCard } from '../capability/catalog.js';
import type { AppProfile } from '../capability/application-profile.js';
import type { RunEvent } from '../observability/run-recorder.js';
import type { LlmProvider, ModelTurn, ToolDefinition } from '../discovery/llm/llm-provider.js';
import type { SwitchLog } from '../discovery/llm/failover-provider.js';
import { plainLanguage, sliceForAgent, type AgentInvocationResult } from './contract.js';
import type { CapabilityApiDeps } from './server.js';

/** The tool the model calls when it has something to say rather than something to do. */
const REPLY_TOOL = 'reply_to_user';

/** The tool the model calls when nothing recorded does what was asked. */
const DISCOVER_TOOL = 'discover_capability';

/**
 * How many capability calls one message may trigger.
 *
 * Bounded because an agent that misreads a business outcome as a transient
 * failure will otherwise retry the same call until the tokens run out. Six is
 * enough for the realistic chains here — find a member, then read their
 * balance, then answer — and small enough that a loop is obvious rather than
 * expensive.
 */
const MAX_TURNS = 6;

/**
 * Step budget for a discovery run started from chat.
 *
 * Lower than the panel's default of 20. A person waiting on a chat reply is in a
 * different situation from someone who deliberately opened a goal form and
 * pressed Discover: they asked a question, and a model wandering a banking
 * console for twenty turns is not an answer. If the flow cannot be worked out in
 * twelve, saying so is more useful than continuing.
 */
const DISCOVERY_MAX_STEPS = 12;

/** Keys the model adds for its own narration, which are not capability inputs. */
const META_ARG_KEYS = new Set(['why', 'reasoning', 'thought']);

/**
 * The system prompt, built per product rather than written once.
 *
 * It used to name MERIDIAN CORE in its first line, which was true of the only
 * panel that existed and false of the CoreBank one the moment there were two:
 * the model was told it was answering for a console it was not pointed at, and
 * the vocabularies genuinely differ ("share" and a compound share id here, a
 * five-digit member number and a "sub-account" there).
 *
 * The product name and the `audience` sentence both come from the profile, so
 * adding a third target means editing that product's YAML rather than this file.
 * Everything below the first paragraph is a property of the *system* — the
 * result contract, the irreversibility rule, the discovery fallback — and is
 * identical for every product by design.
 */
function systemPromptFor(profile: AppProfile): string {
  const audience = profile.chat.audience?.trim();
  return `
You are the front desk of an automation system for ${profile.product}.
${profile.description.trim()}

You do not operate the console yourself. You call capabilities, which are
recorded automations that drive it deterministically.
${audience ? `\nWho you are answering, and the vocabulary they use:\n${audience}\n` : ''}
Rules:
- Respond by calling exactly one tool, every time.
- To do work, call the capability that does it. To speak to the person, call
  ${REPLY_TOOL}.
- Supply every required argument. If the person has not given you one, do not
  guess it — call ${REPLY_TOOL} and ask for it.
- If NO capability does what was asked, and the request is a real task on this
  console, call ${DISCOVER_TOOL} with a precise one-sentence goal. That starts a
  live agent that works the flow out in a browser and records it. Use it only
  when nothing recorded fits — never as a retry for a capability that failed,
  and never for a request that is outside this console entirely.
- A business outcome is an ANSWER, not a failure. MEMBER_NOT_FOUND means there is
  no such member; SUPERVISOR_OVERRIDE_REQUIRED means the operator lacks the
  entitlement; VALIDATION_ERROR means the application rejected the values.
  Report these plainly and do NOT retry them — the answer will not change.
- An escalated result means the run stopped for a human, which is correct
  behaviour for an irreversible action. Say so, and say what the human needs to
  do. Never present it as an error.
- You cannot authorise an irreversible action. Do not claim you can, and do not
  offer to.
- Be brief and concrete. Quote confirmation numbers, balances and outcome codes
  exactly as they came back.
`.trim();
}

const NUDGE =
  `You did not call a tool. Respond by calling exactly one of the available tools. ` +
  `If you have nothing to execute, call ${REPLY_TOOL} with your message.`;

/**
 * A validated discovery request, ready to launch.
 *
 * Named because it travels between two of the panel's functions and this file,
 * and an inline shape repeated in three places is the sort of thing that drifts
 * by one optional field and then only fails at runtime.
 */
export interface PreparedDiscovery {
  goal: string;
  tenantId: string;
  params: Record<string, string>;
  entryUrl: string;
  provider: LlmProvider;
  /**
   * Carries provider failovers across the gap between validating a request and
   * starting the run, so they reach the run's evidence rather than only stderr.
   */
  switchLog?: SwitchLog;
}

export interface ChatDeps extends CapabilityApiDeps {
  catalog: Catalog;
  profile: AppProfile;
  /** Built per request, so a missing key is reported rather than crashing boot. */
  createProvider: () => LlmProvider;
  providerConfigured: () => boolean;
  /** Validates a discovery request — goal, target URL, provider. */
  prepareDiscovery: (body: {
    goal?: string;
    tenant?: string;
    params?: Record<string, string>;
    targetUrl?: string;
  }) => PreparedDiscovery;
  /** The one place a discovery run is started, shared with the panel's goal form. */
  beginDiscovery: (args: PreparedDiscovery & { maxSteps?: number; viaChat?: boolean }) => {
    id: string;
    evidenceDir: string;
    done: Promise<{
      discovered: { card: CapabilityCard; path: string; steps: number; modelCalls: number } | null;
      outcome: unknown;
      crash?: string;
    }>;
  };
  /** Watch a run's events in-process. Returns an unsubscribe. */
  watchRun: (runId: string, onEvent: (e: RunEvent) => void) => () => void;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** One capability invocation or discovery run the chatbot made while answering. */
interface ChatAction {
  capability: string;
  arguments: Record<string, unknown>;
  reasoning: string;
  result: AgentInvocationResult | { status: string; [k: string]: unknown };
  runId?: string;
  kind?: 'replay' | 'discovery';
}

/**
 * A live escalation the chat surfaced, so the client can open the modal on it.
 *
 * Carried on the action and emitted as its own event, because the two consumers
 * want it at different moments: the transcript wants it when the run finishes,
 * and the modal wants it the instant the run parks — which is minutes earlier.
 */
interface ChatEscalation {
  runId: string;
  interventionId: string;
  step: string;
  reason: string;
  reasonClass: string;
  resumeContract: string;
}

export function mountChat(app: Express, deps: ChatDeps): void {
  app.post('/api/chat', async (req: Request, res: Response) => {
    const body = req.body as {
      messages?: ChatMessage[];
      tenant?: string;
      identity?: string;
    };
    const messages = (body.messages ?? []).filter((m) => m.content?.trim());

    // Streaming is opt-in by Accept header rather than by a body flag: it is a
    // property of the transport the caller can handle, not of the request.
    const wantsStream = String(req.get('accept') ?? '').includes('text/event-stream');
    const out = wantsStream ? sseWriter(res) : jsonWriter(res);

    if (!messages.length) {
      out.fail(400, { error: 'send at least one message' });
      return;
    }

    if (!deps.providerConfigured()) {
      out.fail(503, {
        error:
          'the chatbot needs a language model, and no provider key is configured. ' +
          'Set GROQ_API_KEY (free tier) or OPENAI_API_KEY in .env. ' +
          'The capability API, the dashboard and deterministic replay all work without one.',
      });
      return;
    }

    let provider: LlmProvider;
    try {
      provider = deps.createProvider();
    } catch (err) {
      out.fail(503, { error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const tools: ToolDefinition[] = [...deps.catalog.tools(), replyTool(), discoverTool()];
    const actions: ChatAction[] = [];
    const system = systemPromptFor(deps.profile);

    // The conversation so far, rendered into the seam's history shape. Prior
    // turns are the user's and the assistant's words; what this request adds is
    // the tool calls the model makes now.
    const history: Array<{ turn: ModelTurn; result: string }> = [];
    for (const m of messages.slice(0, -1)) {
      if (m.role === 'user') {
        history.push({
          turn: { reasoning: '', toolName: '(user said)', arguments: {} },
          result: m.content,
        });
      } else {
        history.push({
          turn: { reasoning: '', toolName: REPLY_TOOL, arguments: { message: m.content } },
          result: '(delivered)',
        });
      }
    }

    const userText = messages[messages.length - 1]!.content;

    try {
      for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const decision = await provider.decide({
          system,
          userText,
          history,
          tools,
          nudge: NUDGE,
          // Safe to force here in a way it is not in discovery: the worst this
          // can produce is the model talking to the person. A request that no
          // recorded capability covers — "the balance of a *checking* account",
          // when only a savings lookup exists — is exactly where an open-weight
          // model stalls into prose, and answering "I can't do that yet" beats
          // failing the request with a transport error.
          forceToolOnLastAttempt: REPLY_TOOL,
        });

        if (decision.toolName === REPLY_TOOL) {
          out.finish({
            reply: String(decision.arguments.message ?? '').trim() || '(the model replied with nothing)',
            actions,
            turnsUsed: turn,
            usage: provider.usage(),
          });
          return;
        }

        const action =
          decision.toolName === DISCOVER_TOOL
            ? await discoverFromModel(deps, decision, body, out)
            : await invokeFromModel(deps, decision, body, out);
        actions.push(action);

        // What the model sees next is the SAME structured result an agent would
        // get from the API — not a prose summary of it. If the contract is good
        // enough for an agent to branch on, it is good enough here, and it keeps
        // the chatbot from becoming a place where results get reinterpreted.
        history.push({ turn: decision, result: JSON.stringify(action.result) });
      }

      // Out of turns. Report the results we do have rather than inventing a
      // conclusion — the runs happened and the person needs to know what they did.
      out.finish({
        reply:
          `I stopped after ${MAX_TURNS} steps without reaching a conclusion. ` +
          (actions.length
            ? `What did happen: ${actions
                .map((a) => `${a.capability} -> ${describeAction(a)}`)
                .join('; ')}`
            : 'No capability was invoked.'),
        actions,
        turnsUsed: MAX_TURNS,
        exhausted: true,
        usage: provider.usage(),
      });
    } catch (err) {
      out.fail(502, {
        error: err instanceof Error ? err.message : String(err),
        actions,
      });
    }
  });
}

/* ------------------------------------------------------------- transport */

/**
 * The two response shapes, behind one interface.
 *
 * `emit` is a no-op for the JSON writer: a caller that asked for one object gets
 * one object, and progress events it never subscribed to are not its business.
 * Both writers refuse to send twice, because a handler that has already
 * committed a status code and then hits an error path would otherwise crash the
 * process on `ERR_HTTP_HEADERS_SENT` — mid-run, with a browser still open.
 */
interface ChatWriter {
  emit: (type: string, data: unknown) => void;
  finish: (payload: Record<string, unknown>) => void;
  fail: (status: number, payload: Record<string, unknown>) => void;
}

function jsonWriter(res: Response): ChatWriter {
  let sent = false;
  return {
    emit: () => undefined,
    finish: (payload) => {
      if (sent) return;
      sent = true;
      res.json(payload);
    },
    fail: (status, payload) => {
      if (sent) return;
      sent = true;
      res.status(status).json(payload);
    },
  };
}

function sseWriter(res: Response): ChatWriter {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Without this, a reverse proxy buffers the stream and delivers the whole
    // conversation at the end — which is precisely the behaviour streaming
    // exists to avoid, failing invisibly.
    'X-Accel-Buffering': 'no',
  });
  let sent = false;
  const write = (type: string, data: unknown): void => {
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client went away mid-run; the run itself continues and is still recorded */
    }
  };
  return {
    emit: write,
    finish: (payload) => {
      if (sent) return;
      sent = true;
      write('reply', payload);
      res.end();
    },
    fail: (status, payload) => {
      if (sent) return;
      sent = true;
      // The status line is long gone by now — an SSE stream committed 200 the
      // moment it opened. The error is a framed event, and carries the status
      // it would have been so a client can tell a 503 from a 502.
      write('error', { status, ...payload });
      res.end();
    },
  };
}

/* ---------------------------------------------------------------- helpers */

function replyTool(): ToolDefinition {
  return {
    name: REPLY_TOOL,
    description:
      'Say something to the person. Use this to deliver an answer, to report an outcome, ' +
      'or to ask for an argument you are missing. This ends your turn.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to say, in plain language.' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  };
}

function discoverTool(): ToolDefinition {
  return {
    name: DISCOVER_TOOL,
    description:
      'Work out how to do something no recorded capability covers, by driving the live ' +
      'application in a browser and recording what worked. Slow (tens of seconds) and it ' +
      'may fail. Use it ONLY when no capability in this list does what was asked. It cannot ' +
      'perform irreversible actions such as posting a transfer or applying a hold — policy ' +
      'refuses those during discovery — so use it for lookups and read-only flows. ' +
      'On success a draft capability is saved for a human to review.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description:
            'One sentence naming the task and its concrete values, e.g. ' +
            '"Read the address on file for member 103001". Not a question.',
        },
        why: {
          type: 'string',
          description: 'Why no existing capability covers this.',
        },
      },
      required: ['goal'],
      additionalProperties: false,
    },
  };
}

/** One line about what an action did, for the exhausted-turns summary. */
function describeAction(a: ChatAction): string {
  if (a.kind === 'discovery') return String(a.result.status);
  return plainLanguage(a.result as AgentInvocationResult);
}

/**
 * Watches a run for the moment it parks for a human.
 *
 * Emitted as its own event the instant it happens rather than with the finished
 * result, because those are minutes apart: the run then blocks until somebody
 * acts, and telling the person only afterwards would mean the UI sat silent
 * through exactly the interval where it had the most to say.
 */
function watchForEscalation(
  deps: ChatDeps,
  runId: string,
  out: ChatWriter,
  onFound: (e: ChatEscalation) => void,
): () => void {
  return deps.watchRun(runId, (e) => {
    if (e.kind !== 'escalation_raised') return;
    const d = e.detail as Record<string, unknown>;
    const escalation: ChatEscalation = {
      runId,
      interventionId: String(d.interventionId ?? ''),
      step: String(d.step ?? ''),
      reason: String(d.reason ?? ''),
      reasonClass: String(d.reasonClass ?? ''),
      resumeContract: String(d.resumeContract ?? ''),
    };
    onFound(escalation);
    out.emit('escalation', { ...escalation, operatorUrl: deps.operatorUrl });
  });
}

/**
 * Runs the capability the model chose.
 *
 * Note what is NOT passed through: `authorizeIrreversible` and `fault`. Neither
 * is reachable from a chat message by construction — one is a header on the API
 * and the other is a harness control. A model that decides it would like to post
 * a transfer unattended, or to inject a maintenance page, has nowhere to say so.
 */
async function invokeFromModel(
  deps: ChatDeps,
  decision: ModelTurn,
  body: { tenant?: string; identity?: string },
  out: ChatWriter,
): Promise<ChatAction> {
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(decision.arguments)) {
    if (META_ARG_KEYS.has(k)) continue;
    if (v === undefined || v === null) continue;
    args[k] = String(v);
  }

  const base = {
    capability: decision.toolName,
    arguments: args,
    reasoning: decision.reasoning,
    kind: 'replay' as const,
  };

  let prepared;
  try {
    prepared = deps.prepareInvocation({
      capability: decision.toolName,
      ...(body.tenant ? { tenant: body.tenant } : {}),
      ...(body.identity ? { identity: body.identity } : {}),
    });
    validateInputs(prepared.capability, args);
  } catch (err) {
    // Handed straight back to the model as a result rather than thrown. A
    // missing argument is a thing it can fix on the next turn — usually by
    // asking the person for it — and turning that into a 500 would make the
    // chatbot brittle in exactly the situation it exists to handle.
    const problems =
      err instanceof CapabilityInputError
        ? err.problems
        : [err instanceof Error ? err.message : String(err)];
    const result = { status: 'invalid_arguments', problems };
    out.emit('action_result', { capability: decision.toolName, result });
    return { ...base, result };
  }

  const started = deps.beginReplay({
    ...prepared,
    params: args,
    authorizeIrreversible: false,
    viaChat: true,
  });

  // Before awaiting: the run id is what lets the client subscribe to the step
  // stream that already exists, so the person watches the browser work rather
  // than a spinner.
  out.emit('action_started', {
    capability: decision.toolName,
    arguments: args,
    reasoning: decision.reasoning,
    runId: started.id,
    evidenceDir: started.evidenceDir,
    kind: 'replay',
  });

  let escalation: ChatEscalation | undefined;
  const unwatch = watchForEscalation(deps, started.id, out, (e) => {
    escalation = e;
  });

  try {
    const result = await started.done;
    const sliced = sliceForAgent(result);
    out.emit('action_result', { runId: started.id, capability: decision.toolName, result: sliced });
    return {
      ...base,
      result: sliced,
      runId: started.id,
      ...(escalation ? { escalation } : {}),
    };
  } finally {
    unwatch();
  }
}

/**
 * Works the goal out live, because nothing recorded does it.
 *
 * The result handed back to the model is deliberately a *summary*, not the
 * artifact: what it needs to know next is whether a capability now exists and
 * what it is called, not the twelve steps and their locators. The full card goes
 * to the client, where a person can read and approve it.
 */
async function discoverFromModel(
  deps: ChatDeps,
  decision: ModelTurn,
  body: { tenant?: string; identity?: string },
  out: ChatWriter,
): Promise<ChatAction> {
  const goal = String(decision.arguments.goal ?? '').trim();
  const base = {
    capability: DISCOVER_TOOL,
    arguments: { goal },
    reasoning: decision.reasoning || String(decision.arguments.why ?? ''),
    kind: 'discovery' as const,
  };

  let prepared;
  try {
    prepared = deps.prepareDiscovery({
      goal,
      ...(body.tenant ? { tenant: body.tenant } : {}),
    });
  } catch (err) {
    const problems =
      err instanceof CapabilityInputError
        ? err.problems
        : [err instanceof Error ? err.message : String(err)];
    const result = { status: 'invalid_arguments', problems };
    out.emit('action_result', { capability: DISCOVER_TOOL, result });
    return { ...base, result };
  }

  const started = deps.beginDiscovery({
    ...prepared,
    maxSteps: DISCOVERY_MAX_STEPS,
    viaChat: true,
  });

  out.emit('action_started', {
    capability: DISCOVER_TOOL,
    arguments: { goal, targetUrl: prepared.entryUrl },
    reasoning: base.reasoning,
    runId: started.id,
    evidenceDir: started.evidenceDir,
    kind: 'discovery',
    provider: `${prepared.provider.name}:${prepared.provider.model}`,
  });

  let escalation: ChatEscalation | undefined;
  const unwatch = watchForEscalation(deps, started.id, out, (e) => {
    escalation = e;
  });

  try {
    const outcome = await started.done;

    /**
     * A discovery run that ended in a declared business outcome is an ANSWER.
     *
     * Reported with the same `business_outcome` status and the same `code` an
     * ordinary replay would return, so the model's instruction — "a business
     * outcome is an answer, do not retry it" — applies without the model having
     * to learn a second vocabulary for the discovery door. No capability is
     * compiled, because nothing was proven to work.
     */
    const answered =
      !outcome.discovered &&
      (outcome.outcome as { kind?: string; code?: string; message?: string } | undefined)?.kind ===
        'business_outcome'
        ? (outcome.outcome as { code: string; message: string })
        : null;

    const result = answered
      ? {
          status: 'business_outcome',
          code: answered.code,
          message: answered.message,
          note:
            'The application answered the question and the answer was not the goal. This is a ' +
            'result, not a failure. Report the code and its meaning plainly and do NOT retry — ' +
            'the answer will not change, and no capability was recorded because nothing was proven.',
          evidence: started.evidenceDir,
        }
      : outcome.discovered
      ? {
          status: 'discovered',
          capability: `${outcome.discovered.card.name}@${outcome.discovered.card.version}`,
          summary: outcome.discovered.card.summary,
          steps: outcome.discovered.steps,
          modelCalls: outcome.discovered.modelCalls,
          approval: 'draft',
          // Said plainly so the model reports it rather than claiming the task
          // is now done. Discovery proves a flow works; it does not perform it
          // on the person's behalf, and a draft has not been reviewed.
          note:
            'A draft capability was recorded and saved. It has NOT been approved by a human ' +
            'and the task itself was not performed on the caller\'s behalf. Tell the person ' +
            'what was learned and that the new capability is waiting for review.',
          evidence: started.evidenceDir,
        }
      : {
          status: 'discovery_failed',
          outcome: outcome.outcome,
          ...(outcome.crash ? { error: outcome.crash } : {}),
          note:
            'The agent could not complete the goal, so no capability was recorded. ' +
            'Do not retry it — say what was attempted and stop.',
          evidence: started.evidenceDir,
        };

    out.emit('action_result', {
      runId: started.id,
      capability: DISCOVER_TOOL,
      result,
      ...(outcome.discovered ? { card: outcome.discovered.card, path: outcome.discovered.path } : {}),
    });

    return {
      ...base,
      result,
      runId: started.id,
      ...(escalation ? { escalation } : {}),
    };
  } finally {
    unwatch();
  }
}
