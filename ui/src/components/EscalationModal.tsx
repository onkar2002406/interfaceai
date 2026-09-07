/**
 * Taking over a parked run, without leaving the conversation.
 *
 * The control transfer is the moment this system is most likely to be
 * abandoned: a run has stopped, a person is needed, and every extra hop between
 * "I see that it stopped" and "I am driving it" is a chance to lose them. So the
 * modal opens over whatever the person was already looking at — usually the chat
 * message that triggered it — and the same broker, the same session and the same
 * control-authority token back it that back the standalone console on port 4100.
 * Either door reaches the same live browser; neither is a simulation of the other.
 *
 * The three actions are not symmetrical and the wording says so:
 *
 *   - **Hand back** returns control and the executor then *re-checks its resume
 *     contract* before it acts again. It does not resume blindly on trust; if
 *     the screen is not where the automation needs it, the run reports
 *     `escalated / abandoned` with the reason rather than continuing into a
 *     state nobody verified.
 *   - **Give up** ends the run as escalated/abandoned. An honest outcome.
 *   - **Close** does neither. The session stays parked and the queue still holds
 *     it — closing a window is not a decision about a banking transaction.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type InterventionRequest } from '../lib/api';
import { LiveSession } from './LiveSession';

export interface EscalationModalProps {
  interventionId: string;
  /** What the run said when it stopped, if the caller already knows it. */
  reason?: string;
  resumeContract?: string;
  operatorUrl?: string;
  onClose: () => void;
}

export function EscalationModal({
  interventionId,
  reason,
  resumeContract,
  operatorUrl,
  onClose,
}: EscalationModalProps): JSX.Element {
  const [detail, setDetail] = useState<{ request: InterventionRequest; state: string; operator: string | null } | null>(
    null,
  );
  const [operator, setOperator] = useState('operator');
  const [note, setNote] = useState('');
  const [claimed, setClaimed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const addLog = (line: string): void => setLog((l) => [...l.slice(-60), line]);

  // Poll the queue rather than push: the state can change from the other
  // console, and 1.5s is well inside human reaction time for a queue of this
  // size. The screencast is the part that needed a socket, and it has one.
  useEffect(() => {
    let live = true;
    const tick = async (): Promise<void> => {
      try {
        const d = await api.intervention(interventionId);
        if (!live) return;
        setDetail(d);
        setClaimed(d.state === 'HUMAN');
        setGone(false);
      } catch (err) {
        if (!live) return;
        // A 404 means resolved or abandoned — by this window, by the other
        // console, or by the ten-minute timeout. That is an outcome, not an error.
        if (err instanceof ApiError && err.status === 404) setGone(true);
      }
    };
    void tick();
    const h = setInterval(() => void tick(), 1500);
    return () => {
      live = false;
      clearInterval(h);
    };
  }, [interventionId]);

  const act = async (fn: () => Promise<unknown>, said: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      addLog(said);
    } catch (err) {
      addLog(`refused: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const req = detail?.request;
  const state = gone ? 'RESOLVED' : (detail?.state ?? 'PENDING_HUMAN');

  return (
    <div className="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>
          <div>
            <h2>A person is needed</h2>
            <p className="hint" style={{ margin: '.2rem 0 0' }}>
              The browser session is parked and still open. Nothing has been rolled back and nothing
              has been posted.
            </p>
          </div>
          <span className={`state ${state}`}>{state}</span>
          <button className="mini close" onClick={onClose}>
            Close
          </button>
        </header>

        {gone ? (
          <div className="banner">
            <h3>This intervention is no longer open.</h3>
            <p className="hint">
              It was handed back, given up, or it timed out. The run has reported its own outcome —
              look for it in the transcript or in Run history.
            </p>
          </div>
        ) : (
          <>
            <table className="kv">
              <tbody>
                {req && (
                  <>
                    <tr>
                      <th>Capability</th>
                      <td className="mono">
                        {req.capability.name}@{req.capability.version}
                      </td>
                    </tr>
                    <tr>
                      <th>Stopped at</th>
                      <td>
                        step <span className="mono">{req.atStep.id}</span> ({req.atStep.index} of{' '}
                        {req.atStep.total}) — {req.atStep.intent}
                      </td>
                    </tr>
                    <tr>
                      <th>Why</th>
                      <td>
                        <span className="mono">{req.reasonClass}</span> — {req.reason}
                      </td>
                    </tr>
                  </>
                )}
                {!req && reason && (
                  <tr>
                    <th>Why</th>
                    <td>{reason}</td>
                  </tr>
                )}
                <tr>
                  <th>To resume</th>
                  <td>
                    {req?.resumeContract.describe ?? resumeContract ?? '—'}
                    <div className="hint">
                      Handing back does not resume blindly — the executor re-checks this before it
                      acts again.
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>

            <div className="grid2">
              <div>
                <LiveSession interventionId={interventionId} claimed={claimed} onLog={addLog} />
                <p className="hint" style={{ marginTop: '.4rem' }}>
                  {claimed
                    ? 'You hold control. Click and type on the screen above — it is the same live session the automation was driving.'
                    : 'Read-only. Watching needs no claim; acting does, and an un-claimed click is refused.'}
                </p>
                <div className="log">
                  {log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <div>—</div>}
                </div>
              </div>

              <div>
                <label htmlFor="opname">
                  Your name
                  <span className="hint">Recorded against every action you take.</span>
                </label>
                <input
                  id="opname"
                  type="text"
                  value={operator}
                  onChange={(e) => setOperator(e.target.value)}
                  disabled={claimed}
                />

                <label htmlFor="opnote">
                  Note
                  <span className="hint">What you did, or why you could not.</span>
                </label>
                <textarea id="opnote" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />

                <div className="row">
                  <button
                    className="go"
                    disabled={busy || claimed}
                    onClick={() =>
                      void act(async () => {
                        await api.claim(interventionId, operator || 'operator');
                        setClaimed(true);
                      }, `you hold control as "${operator || 'operator'}"`)
                    }
                  >
                    Take control
                  </button>
                  <button
                    className="mini"
                    disabled={busy || !claimed}
                    onClick={() =>
                      void act(async () => {
                        await api.handBack(interventionId, note || 'completed manually');
                        setClaimed(false);
                      }, 'handed back — the automation will re-check its resume contract')
                    }
                  >
                    Hand back
                  </button>
                  <button
                    className="mini"
                    disabled={busy || !claimed}
                    onClick={() =>
                      void act(async () => {
                        await api.abandon(interventionId, note || 'operator could not resolve');
                        setClaimed(false);
                      }, 'gave up — the run will report escalated / abandoned')
                    }
                  >
                    Give up
                  </button>
                </div>

                {req && Object.keys(req.params).length > 0 && (
                  <>
                    <h3 className="sec">Inputs</h3>
                    <pre>{JSON.stringify(req.params, null, 2)}</pre>
                    <p className="hint">Already redacted — this is what the evidence log holds.</p>
                  </>
                )}

                {operatorUrl && (
                  <p className="hint sec">
                    The standalone console is at{' '}
                    <a href={operatorUrl} target="_blank" rel="noopener noreferrer">
                      {operatorUrl}
                    </a>{' '}
                    — same broker, same session.
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
