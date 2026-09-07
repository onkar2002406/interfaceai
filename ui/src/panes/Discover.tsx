/**
 * The goal-driven agent loop, started by hand.
 *
 * `(goal, target_url)` in, a compiled capability artifact out. The model drives
 * a real browser through observe → decide → act; what it produces is a *trace*,
 * and deterministic code compiles that into the artifact. The model never writes
 * a locator, never writes a checkpoint and never chooses an error taxonomy.
 *
 * The target URL field is validated against the policy allowlist *server-side*
 * before a browser launches. It is a convenience, not a way out of the
 * containment boundary — pointing the agent at a new origin is a policy change,
 * which is a file, not a text box.
 *
 * Compiling never approves. A successful run saves a draft and shows it here for
 * a person to read; approval is a separate, deliberate action, because it is half
 * of what later permits an unattended irreversible step.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type Catalog } from '../lib/api';
import { useRunStream } from '../lib/useRunStream';
import { StepLog } from '../components/StepLog';

export interface DiscoverProps {
  catalog: Catalog;
  tenant: string;
  onRunsChanged: () => void;
  onCatalogChanged: () => void;
}

interface Param {
  name: string;
  value: string;
}

export function Discover({ catalog, tenant, onRunsChanged, onCatalogChanged }: DiscoverProps): JSX.Element {
  const [goal, setGoal] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [params, setParams] = useState<Param[]>([]);
  const [maxSteps, setMaxSteps] = useState('20');
  const [name, setName] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState(false);

  const stream = useRunStream(runId);
  const discovered = stream.discovered as
    | { card: { name: string; version: string; summary: string; approval: string }; path: string; steps: number; modelCalls: number }
    | null;

  /**
   * Keeps the value rows in step with the {{references}} in the goal.
   *
   * Adds a row for a reference that has none, and never removes one that was
   * typed: deleting a row because a word was momentarily mid-edit would throw
   * away something already filled in.
   */
  useEffect(() => {
    const refs = [...goal.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map((m) => m[1]!);
    setParams((prev) => {
      const have = new Set(prev.map((p) => p.name));
      const add = refs.filter((r) => !have.has(r)).map((r) => ({ name: r, value: '' }));
      return add.length ? [...prev, ...add] : prev;
    });
  }, [goal]);

  const tenantProfile = catalog.tenants.find((t) => t.id === tenant);

  async function run(): Promise<void> {
    setBusy(true);
    setProblems([]);
    setRunId(null);
    try {
      const body: Parameters<typeof api.discover>[0] = {
        goal,
        tenant,
        params: Object.fromEntries(params.filter((p) => p.name).map((p) => [p.name, p.value])),
        maxSteps: Number(maxSteps) || 20,
      };
      if (targetUrl.trim()) body.targetUrl = targetUrl.trim();
      if (name.trim()) body.name = name.trim();

      const r = await api.discover(body);
      setRunId(r.runId);
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
      <h2>Discover a capability</h2>
      <p className="hint">
        {catalog.provider.live ? (
          <>
            A model drives a real browser: <span className="mono">{catalog.provider.name}</span>.
          </>
        ) : (
          <>
            <b>No model key configured.</b> This will use the <span className="mono">scripted</span>{' '}
            fixture — real browser, real perception, real compiler, but a canned decision-maker that
            only knows the screens it was taught. Set <span className="mono">GROQ_API_KEY</span> for
            live discovery.
          </>
        )}
      </p>

      <label htmlFor="goal">
        Goal
        <span className="hint">
          Plain language. Use <span className="mono">{'{{references}}'}</span> for the values that
          change per invocation — those become the capability's typed inputs.
        </span>
      </label>
      <textarea
        id="goal"
        rows={3}
        spellCheck={false}
        value={goal}
        placeholder="Read the current balance of share {{shareId}} for member {{memberId}}"
        onChange={(e) => setGoal(e.target.value)}
      />

      <label htmlFor="targetUrl">
        Target URL
        <span className="hint">
          Where the agent starts. Leave blank for the tenant's own entry point
          {tenantProfile ? ` (${tenantProfile.baseUrl})` : ''}. Must be on the policy allowlist —
          checked before a browser launches.
        </span>
      </label>
      <input
        id="targetUrl"
        type="text"
        value={targetUrl}
        placeholder={tenantProfile ? new URL('/', tenantProfile.baseUrl).toString() : 'https://…'}
        onChange={(e) => setTargetUrl(e.target.value)}
      />

      {params.length > 0 && (
        <>
          <label>
            Values for this run
            <span className="hint">
              Supplied so the model has something concrete to type. The artifact records the
              reference, never the value.
            </span>
          </label>
          {params.map((p, i) => (
            <div key={i} className="row" style={{ marginTop: '.3rem' }}>
              <input
                type="text"
                className="mono"
                style={{ flex: '0 0 12rem' }}
                value={p.name}
                onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <input
                type="text"
                style={{ flex: 1 }}
                value={p.value}
                onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              />
              <button className="mini" onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
        </>
      )}

      <div className="row">
        <div style={{ flex: '0 0 8rem' }}>
          <label htmlFor="maxSteps">Step budget</label>
          <input id="maxSteps" type="text" value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="capName">
            Name override <span className="hint">optional</span>
          </label>
          <input id="capName" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>

      <div className="row">
        <button className="go" onClick={() => void run()} disabled={busy || !goal.trim()}>
          Discover
        </button>
        <span className="hint">Irreversible actions are refused during discovery, at any confidence.</span>
      </div>

      {problems.length > 0 && (
        <div className="verdict failed">
          <h3>Not started</h3>
          <ul>
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {runId && (
        <>
          <h2 className="sec">Live</h2>
          <StepLog events={stream.events} />

          {stream.done && discovered && (
            <div className="verdict success">
              <h3>
                Compiled <span className="mono">{discovered.card.name}@{discovered.card.version}</span>
              </h3>
              <p>{discovered.card.summary}</p>
              <p className="hint">
                {discovered.steps} steps, {discovered.modelCalls} model calls. Written to{' '}
                <span className="mono">{discovered.path}</span>. Saved as a <b>draft</b> — compiling
                never approves.
              </p>
              <div className="row">
                <button
                  className="mini"
                  disabled={approving}
                  onClick={async () => {
                    setApproving(true);
                    try {
                      await api.approve(`${discovered.card.name}@${discovered.card.version}`, true);
                      onCatalogChanged();
                    } finally {
                      setApproving(false);
                    }
                  }}
                >
                  Approve it
                </button>
                <span className="hint">Read the artifact first — approval is half of what permits an unattended irreversible step.</span>
              </div>
            </div>
          )}

          {stream.done && !discovered && (
            <div className="verdict failed">
              <h3>{stream.crash ? 'Discovery crashed' : 'Did not reach the goal'}</h3>
              <p className="hint">
                No capability was compiled. An artifact is a promise that a flow works, and this run
                is not evidence that it does.
              </p>
              {stream.crash && <pre>{stream.crash}</pre>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
