/**
 * Deterministic replay, driven by a form.
 *
 * The production path: a reviewed artifact, concrete arguments, and no model
 * anywhere in the decision loop. The form fields are generated from the
 * capability's own input schema, so the UI cannot drift from the contract — add
 * an input to the YAML and a field appears, with its description and its pattern.
 *
 * This pane is also the only place in the interface that can authorise an
 * irreversible action, and the checkbox only exists when the artifact declares
 * such a step. That asymmetry with the chat is the point: authorising a funds
 * transfer should require a person who read the contract, typed the arguments,
 * and ticked a box that names what it permits — not a sentence a model
 * interpreted.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type CapabilityCard, type Catalog } from '../lib/api';
import { useRunStream } from '../lib/useRunStream';
import { ContractTable } from '../components/ContractTable';
import { StepLog } from '../components/StepLog';
import { Verdict } from '../components/Verdict';
import type { ChatEscalation } from './Chat';

export interface ReplayProps {
  catalog: Catalog;
  selected: CapabilityCard | null;
  tenant: string;
  identity: string;
  onOpenEscalation: (e: ChatEscalation) => void;
  onOpenEvidence: (dir: string) => void;
  onRunsChanged: () => void;
}

export function Replay({
  catalog,
  selected,
  tenant,
  identity,
  onOpenEscalation,
  onOpenEvidence,
  onRunsChanged,
}: ReplayProps): JSX.Element {
  const [params, setParams] = useState<Record<string, string>>({});
  const [fault, setFault] = useState('');
  const [authorize, setAuthorize] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [evidenceDir, setEvidenceDir] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const stream = useRunStream(runId);

  // Reset the whole form when the selection changes. Carrying a previous
  // capability's arguments across would be a plausible-looking way to invoke the
  // wrong thing with the right-looking values.
  useEffect(() => {
    if (!selected) return;
    const next: Record<string, string> = {};
    for (const [name, prop] of Object.entries(selected.inputSchema.properties ?? {})) {
      next[name] = prop.examples?.length ? String(prop.examples[0]) : '';
    }
    setParams(next);
    setAuthorize(false);
    setRunId(null);
    setProblems([]);
    setEvidenceDir('');
  }, [selected?.name, selected?.version]);

  // An escalation that arrives on the stream should reach the person the same
  // way it does in chat: as something they can act on, not a line in a log.
  const escalationEvent = stream.events.find((e) => e.kind === 'escalation_raised');

  if (!selected) {
    return <p className="hint">Choose a capability on the left.</p>;
  }

  async function run(): Promise<void> {
    setBusy(true);
    setProblems([]);
    setRunId(null);
    try {
      const r = await api.replay({
        capability: `${selected!.name}@${selected!.version}`,
        tenant,
        ...(identity ? { identity } : {}),
        params,
        authorizeIrreversible: authorize,
        ...(fault ? { fault } : {}),
      });
      setRunId(r.runId);
      setEvidenceDir(r.evidenceDir);
      onRunsChanged();
    } catch (err) {
      setProblems(
        err instanceof ApiError && err.problems?.length
          ? err.problems
          : [err instanceof Error ? err.message : String(err)],
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ContractTable card={selected} />

      <h2 className="sec">Invoke</h2>
      {Object.keys(selected.inputSchema.properties ?? {}).length === 0 ? (
        <p className="hint">This capability takes no inputs.</p>
      ) : (
        Object.entries(selected.inputSchema.properties).map(([name, prop]) => (
          <div key={name}>
            <label htmlFor={`in-${name}`}>
              {name}
              {selected.inputSchema.required?.includes(name) ? ' *' : ''}
              <span className="hint">{prop.description ?? ''}</span>
            </label>
            <input
              id={`in-${name}`}
              type="text"
              value={params[name] ?? ''}
              placeholder={prop.pattern ?? ''}
              onChange={(e) => setParams((p) => ({ ...p, [name]: e.target.value }))}
            />
          </div>
        ))
      )}

      {catalog.faults.length > 0 && (
        <>
          <label htmlFor="fault">
            Inject a fault
            <span className="hint">
              Armed by the harness from outside the agent loop — the automation cannot reach its own
              test hooks, and the target's fault console is on the policy deny list.
            </span>
          </label>
          <select id="fault" value={fault} onChange={(e) => setFault(e.target.value)}>
            <option value="">none — run normally</option>
            {catalog.faults.map((f) => (
              <option key={f} value={f}>
                ?inject={f}
              </option>
            ))}
          </select>
        </>
      )}

      {selected.hasIrreversibleStep && (
        <p style={{ marginTop: '.9rem' }}>
          <label style={{ display: 'inline', fontWeight: 400 }}>
            <input type="checkbox" checked={authorize} onChange={(e) => setAuthorize(e.target.checked)} />
            Authorise the irreversible step
          </label>
          <span className="hint" style={{ display: 'block' }}>
            Without this the run drives the whole flow and then stops for a human at the posting step.
            The chatbot has no way to set it.
          </span>
        </p>
      )}

      <div className="row">
        <button className="go" onClick={() => void run()} disabled={busy}>
          Replay
        </button>
        <span className="hint">
          No model in the loop — the recorded steps, resolved against this screen.
        </span>
      </div>

      {problems.length > 0 && (
        <div className="verdict failed">
          <h3>Not started</h3>
          <ul>
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          <p className="hint">Validated before a browser launched — a bad argument costs milliseconds.</p>
        </div>
      )}

      {runId && (
        <>
          <h2 className="sec">Live</h2>
          <StepLog events={stream.events} />

          {escalationEvent && !stream.done && (
            <div className="banner">
              <h3>
                Waiting for a person — step{' '}
                <span className="mono">{String(escalationEvent.detail.step ?? '')}</span>
              </h3>
              <p>{String(escalationEvent.detail.reason ?? '')}</p>
              <p className="hint">
                The session is parked and still open. Viewing needs no claim; acting does.
              </p>
              <button
                className="mini"
                onClick={() =>
                  onOpenEscalation({
                    runId,
                    interventionId: String(escalationEvent.detail.interventionId ?? ''),
                    step: String(escalationEvent.detail.step ?? ''),
                    reason: String(escalationEvent.detail.reason ?? ''),
                    reasonClass: String(escalationEvent.detail.reasonClass ?? ''),
                    resumeContract: String(escalationEvent.detail.resumeContract ?? ''),
                  })
                }
              >
                Take control
              </button>
            </div>
          )}

          {stream.done && (
            <Verdict
              result={stream.result}
              crash={stream.crash}
              evidenceDir={evidenceDir}
              onOpenEvidence={onOpenEvidence}
              onOpenEscalation={(id) =>
                onOpenEscalation({
                  runId,
                  interventionId: id,
                  step: '',
                  reason: stream.result?.reason ?? '',
                  reasonClass: '',
                  resumeContract: '',
                })
              }
            />
          )}
        </>
      )}
    </div>
  );
}
