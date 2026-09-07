/**
 * The chat front door.
 *
 * A person types what they want; the system decides whether a recorded
 * capability does it, or whether the goal-driven agent has to work it out live.
 * Both are visible as they happen — each invocation gets its own block in the
 * transcript with the run's real step stream inside it, so "the recording is
 * replaying" and "a model is exploring" are legible as the different things they
 * are, rather than both being a spinner.
 *
 * Two behaviours here are load-bearing rather than decorative:
 *
 *   **The escalation modal opens from the transcript.** When a run parks for a
 *   human the server emits an `escalation` event the instant it happens — minutes
 *   before the run finishes — and the person can take control without leaving
 *   the page they are already on.
 *
 *   **There is no authorisation control anywhere in this pane.** Authorising an
 *   irreversible action is a header on the capability API, and the chat composes
 *   bodies. That is not an oversight to be fixed by adding a checkbox: it is the
 *   reason a natural-language front door over a banking console is defensible at
 *   all. The Replay pane, where a person types the arguments themselves and
 *   ticks the box themselves, is where that lives.
 *
 * The transcript is client-side state and the server is stateless about it. That
 * keeps "clear the conversation" honest, and it means the durable record of a
 * chat-driven run is its evidence directory rather than a log of what was said.
 */

import { useEffect, useRef, useState } from 'react';
import { streamChat } from '../lib/chatStream';
import { useRunStream } from '../lib/useRunStream';
import { StepLog } from '../components/StepLog';
import { Verdict } from '../components/Verdict';
import type { Catalog, CapabilityCard, ReplayResult } from '../lib/api';

export interface ChatEscalation {
  runId: string;
  interventionId: string;
  step: string;
  reason: string;
  reasonClass: string;
  resumeContract: string;
  operatorUrl?: string;
}

/** One capability invocation or discovery run inside an assistant turn. */
interface Action {
  capability: string;
  arguments: Record<string, unknown>;
  reasoning: string;
  runId?: string;
  kind: 'replay' | 'discovery';
  provider?: string;
  result?: Record<string, unknown>;
  card?: CapabilityCard;
  escalation?: ChatEscalation;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
  actions?: Action[];
}

export interface ChatProps {
  catalog: Catalog;
  tenant: string;
  identity: string;
  onOpenEscalation: (e: ChatEscalation) => void;
  onRunsChanged: () => void;
}

export function Chat({ catalog, tenant, identity, onOpenEscalation, onRunsChanged }: ChatProps): JSX.Element {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const live = catalog.provider.live;

  /**
   * The openers, and where they come from.
   *
   * Both control panels — CoreBank on 4200, MERIDIAN on 4300 — serve this same
   * bundle, so a constant here would offer one product's identifiers to the
   * other product's operators. A CoreBank clerk asked for a share id like
   * `103001-MMKT-11` has nothing to click, and the model would have to invent a
   * member number to make progress.
   *
   * So the server sends them, out of the `chat:` block of the product profile,
   * where they sit beside the tenants and the identities as one more thing that
   * is true about this console and the people who use it. Empty is a legal
   * answer (a profile need not declare any) and simply shows no chips.
   */
  const suggestions = catalog.chat?.suggestions ?? [];

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    setInput('');
    setBusy(true);

    // The transcript sent to the server is the settled history — the pending
    // bubble is a rendering concern and must not become a turn the model reads.
    const history: Message[] = [...messages.filter((m) => !m.pending), { role: 'user', content: trimmed }];
    setMessages([...history, { role: 'assistant', content: 'working…', pending: true, actions: [] }]);

    /** Mutates the trailing pending bubble in place. */
    const patch = (fn: (m: Message) => Message): void =>
      setMessages((ms) => {
        const last = ms[ms.length - 1];
        if (!last || !last.pending) return ms;
        return [...ms.slice(0, -1), fn(last)];
      });

    const patchAction = (runId: string | undefined, fn: (a: Action) => Action): void =>
      patch((m) => ({
        ...m,
        actions: (m.actions ?? []).map((a) => (runId && a.runId === runId ? fn(a) : a)),
      }));

    try {
      await streamChat({
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        tenant,
        ...(identity ? { identity } : {}),
        onEvent: (e) => {
          const d = e.data;
          switch (e.type) {
            case 'action_started':
              patch((m) => ({
                ...m,
                content: 'working…',
                actions: [
                  ...(m.actions ?? []),
                  {
                    capability: String(d.capability ?? ''),
                    arguments: (d.arguments as Record<string, unknown>) ?? {},
                    reasoning: String(d.reasoning ?? ''),
                    runId: d.runId ? String(d.runId) : undefined,
                    kind: d.kind === 'discovery' ? 'discovery' : 'replay',
                    ...(d.provider ? { provider: String(d.provider) } : {}),
                  },
                ],
              }));
              onRunsChanged();
              break;

            case 'action_result':
              patchAction(d.runId ? String(d.runId) : undefined, (a) => ({
                ...a,
                result: (d.result as Record<string, unknown>) ?? {},
                ...(d.card ? { card: d.card as CapabilityCard } : {}),
              }));
              onRunsChanged();
              break;

            case 'escalation': {
              const esc = d as unknown as ChatEscalation;
              patchAction(esc.runId, (a) => ({ ...a, escalation: esc }));
              // Bring the person to it. A parked banking transaction waiting on
              // a human is the one thing in this interface that should interrupt.
              onOpenEscalation(esc);
              break;
            }

            case 'reply':
              patch((m) => ({ ...m, content: String(d.reply ?? ''), pending: false }));
              onRunsChanged();
              break;

            case 'error':
              patch((m) => ({
                ...m,
                content: String(d.error ?? 'the request failed'),
                pending: false,
              }));
              break;
          }
        },
      });
    } catch (err) {
      patch((m) => ({ ...m, content: err instanceof Error ? err.message : String(err), pending: false }));
    } finally {
      // Any bubble still marked pending means the stream ended without a reply
      // frame — the connection dropped, or the process died. Say so rather than
      // leaving "working…" on screen forever.
      setMessages((ms) =>
        ms.map((m) =>
          m.pending
            ? { ...m, pending: false, content: m.content === 'working…' ? 'The stream ended without a reply.' : m.content }
            : m,
        ),
      );
      setBusy(false);
      onRunsChanged();
    }
  }

  return (
    <div>
      <p className="hint">
        Ask for something in plain language. The system calls a recorded capability if one fits, and
        starts the live discovery agent if none does. It <b>cannot</b> authorise an irreversible
        action — authorisation is a header on the capability API, and this composes bodies — so a
        flow that commits money or creates a record runs right up to the commit control and then
        stops for a person. The <b>Guardrails</b> tab lists which controls this product treats that
        way, read live from the policy file this process is enforcing.
      </p>
      {catalog.chat?.audience && <p className="hint">{catalog.chat.audience}</p>}

      <div className="chatlog" ref={logRef}>
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}${m.pending ? ' pending' : ''}`}>
            <div className="who">{m.role === 'user' ? 'You' : 'Assistant'}</div>
            {(m.actions ?? []).map((a, j) => (
              <ActionBlock key={j} action={a} onOpenEscalation={onOpenEscalation} />
            ))}
            <div className="body">{m.content}</div>
          </div>
        ))}
      </div>

      <label htmlFor="chatInput">Message</label>
      <textarea
        id="chatInput"
        rows={2}
        spellCheck={false}
        value={input}
        disabled={!live}
        placeholder={
          // The first opener doubles as the placeholder, so the example in the
          // empty box is a sentence that works on the console in front of you.
          live ? (suggestions[0] ?? 'Ask for something in plain language.') : 'No model key configured.'
        }
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send(input);
          }
        }}
      />

      <div className="row">
        <button className="go" disabled={!live || busy} onClick={() => void send(input)}>
          Send
        </button>
        <button className="mini" disabled={busy} onClick={() => setMessages([])}>
          Clear conversation
        </button>
        <span className="hint">
          {live
            ? `Enter sends. ${catalog.provider.name} decides which capability to call.`
            : 'No model key configured, so the chatbot is unavailable. Set GROQ_API_KEY in .env — the dashboard, the API and deterministic replay all work without one.'}
        </span>
      </div>

      {live && !messages.length && suggestions.length > 0 && (
        <div className="suggest">
          {suggestions.map((s) => (
            <button key={s} onClick={() => void send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- one action */

function ActionBlock({
  action,
  onOpenEscalation,
}: {
  action: Action;
  onOpenEscalation: (e: ChatEscalation) => void;
}): JSX.Element {
  const stream = useRunStream(action.runId ?? null);
  const finished = !!action.result;
  const status = String(action.result?.status ?? (finished ? '' : 'running'));

  const badge =
    status === 'success' || status === 'discovered'
      ? 'good'
      : status === 'business_outcome'
        ? 'warn'
        : status === 'failed' || status === 'invalid_arguments' || status === 'discovery_failed'
          ? 'bad'
          : '';

  return (
    <details className="action" open={!finished}>
      <summary>
        <span className="label">{action.capability}</span>{' '}
        <span className={`badge ${badge}`}>{status || 'running'}</span>{' '}
        {action.kind === 'discovery' && <span className="hint">live discovery{action.provider ? ` · ${action.provider}` : ''}</span>}
      </summary>
      <div className="inner">
        {action.reasoning && <p className="hint">{action.reasoning}</p>}

        {Object.keys(action.arguments).length > 0 && (
          <table className="kv">
            <tbody>
              {Object.entries(action.arguments).map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td className="mono">{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {action.runId && <StepLog events={stream.events} />}

        {action.escalation && (
          <div className="banner">
            <h3>Waiting for a person — step <span className="mono">{action.escalation.step}</span></h3>
            <p>{action.escalation.reason}</p>
            <p className="hint">
              The browser session is parked and still open. Handing back does not resume blindly: the
              executor re-checks that <i>{action.escalation.resumeContract}</i> before it acts again.
            </p>
            <button className="mini" onClick={() => onOpenEscalation(action.escalation!)}>
              Take control
            </button>
          </div>
        )}

        {action.result && <ChatResult result={action.result} />}
      </div>
    </details>
  );
}

/**
 * A finished action's result.
 *
 * Replay results go through the same `Verdict` the Replay pane uses, so the four
 * arms cannot come out looking different depending on which door you came in by.
 * Discovery results are their own shape and rendered as their own thing.
 */
function ChatResult({ result }: { result: Record<string, unknown> }): JSX.Element {
  const status = String(result.status ?? '');

  if (status === 'invalid_arguments') {
    return (
      <div className="verdict failed">
        <h3>Missing or invalid arguments</h3>
        <ul>
          {((result.problems as string[]) ?? []).map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
        <p className="hint">Caught before a browser started — the assistant will normally just ask for the value.</p>
      </div>
    );
  }

  if (status === 'discovered') {
    return (
      <div className="verdict success">
        <h3>
          Recorded a new capability — <span className="mono">{String(result.capability ?? '')}</span>
        </h3>
        <p>{String(result.summary ?? '')}</p>
        <p className="hint">
          {String(result.steps ?? '?')} steps, {String(result.modelCalls ?? '?')} model calls. Saved as
          a <b>draft</b>: it has not been reviewed, and discovery proves a flow works rather than
          performing it on anyone's behalf. Approve it in the capability list on the left.
        </p>
      </div>
    );
  }

  // A discovery run that ended in a declared business outcome. Rendered as the
  // answer it is, in the same warn colour a replay's business outcome gets —
  // the arm must not look like a different kind of thing depending on which
  // door the caller came in by.
  if (status === 'business_outcome' && result.note) {
    return (
      <div className="verdict business">
        <h3>
          The application answered — <span className="mono">{String(result.code ?? '')}</span>
        </h3>
        <p>{String(result.message ?? '')}</p>
        <p className="hint">
          No capability was recorded: discovery proves a flow works, and this run found that the
          application has a different answer to the question. Nothing is broken and retrying will
          not change it.
        </p>
      </div>
    );
  }

  if (status === 'discovery_failed') {
    return (
      <div className="verdict failed">
        <h3>Discovery did not reach the goal</h3>
        <p className="hint">
          No capability was compiled. An artifact is a promise that a flow works, and this run is not
          evidence that it does.
        </p>
        <pre>{JSON.stringify(result.outcome ?? result.error ?? {}, null, 2)}</pre>
      </div>
    );
  }

  return <Verdict result={result as unknown as ReplayResult} evidenceDir={String(result.evidence ?? '')} />;
}
