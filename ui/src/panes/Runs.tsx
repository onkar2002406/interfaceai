/**
 * Run history — every run this process has launched, whichever door it came in by.
 *
 * The panel form, the agent-facing API and the chatbot all funnel through one
 * launcher, so they all appear here. That is worth showing rather than just
 * being true: a run started by `curl` and a run started by typing a sentence are
 * the same kind of event, with the same evidence directory and the same
 * guardrails, and a history that only listed the ones started from a form would
 * quietly suggest otherwise.
 */

import { useState } from 'react';
import { api, type RunSummary, type ReplayResult, type RunEvent } from '../lib/api';
import { StepLog } from '../components/StepLog';
import { Verdict } from '../components/Verdict';

export interface RunsProps {
  runs: RunSummary[];
  onOpenEvidence: (dir: string) => void;
}

export function Runs({ runs, onOpenEvidence }: RunsProps): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    events: RunEvent[];
    result: ReplayResult | null;
    crash: string | null;
    evidenceDir: string;
  } | null>(null);

  const select = async (id: string): Promise<void> => {
    setOpen(id);
    setDetail(null);
    try {
      const d = await api.run(id);
      setDetail({ events: d.events, result: d.result, crash: d.crash, evidenceDir: d.evidenceDir });
    } catch {
      setDetail(null);
    }
  };

  const badge = (r: RunSummary): string =>
    r.state === 'running'
      ? ''
      : r.status === 'success'
        ? 'good'
        : r.status === 'business_outcome'
          ? 'warn'
          : r.status === 'failed' || r.state === 'error'
            ? 'bad'
            : '';

  return (
    <div>
      <h2>Run history</h2>
      <p className="hint">
        {runs.length} run{runs.length === 1 ? '' : 's'} this session. Chat-driven, API-driven and
        form-driven runs are the same runs.
      </p>

      <div className="grid2">
        <div>
          {open && detail ? (
            <>
              <h3 className="mono">{open}</h3>
              <StepLog events={detail.events} />
              <Verdict
                result={detail.result}
                crash={detail.crash}
                evidenceDir={detail.evidenceDir}
                onOpenEvidence={onOpenEvidence}
              />
            </>
          ) : (
            <p className="hint">{open ? 'Loading…' : 'Choose a run.'}</p>
          )}
        </div>

        <div>
          {runs.length === 0 && <p className="hint">Nothing yet.</p>}
          {runs.map((r) => (
            <div
              key={r.id}
              className={`card clickable${open === r.id ? ' sel' : ''}`}
              onClick={() => void select(r.id)}
            >
              <h3>{r.capability}</h3>
              <div>
                <span className="tag">{r.kind}</span>
                {r.state === 'running' ? (
                  <span className="tag">running…</span>
                ) : (
                  <span className={`badge ${badge(r)}`}>{r.status ?? r.state}</span>
                )}
                {r.code && <span className="tag">{r.code}</span>}
                {r.viaChat && <span className="tag">via chat</span>}
                {r.fault && <span className="tag risk">?inject={r.fault}</span>}
                {r.identity && <span className="tag">{r.identity}</span>}
              </div>
              {r.goal && <p className="why">{r.goal}</p>}
              <p className="hint mono">{r.startedAt}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
