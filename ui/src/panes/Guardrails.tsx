/**
 * The guardrails, read live from the same config the engine enforces.
 *
 * Rendering policy from a second, hand-maintained copy would be worse than not
 * showing it at all: a safety page that can drift out of agreement with the
 * safety layer is an actively misleading artifact. So everything below is
 * `GET /api/policy`, which returns `policy.config` verbatim.
 */

import { useEffect, useState } from 'react';

interface RiskRule {
  name: string;
  description?: string;
  when: { actionType?: string; namePattern?: string; routePattern?: string };
}

interface PolicyConfig {
  version: number;
  description?: string;
  origins: string[];
  routes: { allow: string[]; deny: string[] };
  actions: string[];
  risk?: { irreversible?: RiskRule[]; mutating?: RiskRule[] };
  limits: { maxSteps: number; maxRuntimeMs: number; maxRecoveries: number };
}

export function Guardrails(): JSX.Element {
  const [policy, setPolicy] = useState<PolicyConfig | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void fetch('/api/policy')
      .then((r) => r.json())
      .then((p: PolicyConfig) => setPolicy(p))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <p className="hint">{error}</p>;
  if (!policy) return <p className="hint">Loading…</p>;

  const rules = (title: string, list: RiskRule[] | undefined, note: string): JSX.Element => (
    <>
      <h3 className="sec">{title}</h3>
      <p className="hint">{note}</p>
      {list?.length ? (
        <table className="kv">
          <thead>
            <tr>
              <th>rule</th>
              <th>matches</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.name}>
                <td className="mono">{r.name}</td>
                <td>
                  {r.when.actionType && (
                    <div className="mono">action = {r.when.actionType}</div>
                  )}
                  {r.when.namePattern && <div className="mono">name ~ {r.when.namePattern}</div>}
                  {r.when.routePattern && <div className="mono">route ~ {r.when.routePattern}</div>}
                  {r.description && <div className="hint">{r.description}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="hint">None declared.</p>
      )}
    </>
  );

  return (
    <div>
      <h2>Guardrails</h2>
      <p className="hint">
        Read live from the policy file this process is enforcing — not a copy. Everything here is the
        config the engine actually checks against on every action.
      </p>

      <h3 className="sec">Origins — the containment boundary</h3>
      <p className="hint">
        Exact string match. A hallucinated URL or an unexpected redirect stops the run, and a human
        cannot consent us out of this one: origin and route refusals are not escalatable.
      </p>
      <ul>
        {policy.origins.map((o) => (
          <li key={o} className="mono">
            {o}
          </li>
        ))}
      </ul>

      <h3 className="sec">Routes</h3>
      <table className="kv">
        <thead>
          <tr>
            <th>allow</th>
            <th>deny — wins over allow</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              {policy.routes.allow.map((r) => (
                <div key={r} className="mono">
                  {r}
                </div>
              ))}
            </td>
            <td>
              {policy.routes.deny.length ? (
                policy.routes.deny.map((r) => (
                  <div key={r} className="mono">
                    {r}
                  </div>
                ))
              ) : (
                <span className="hint">none</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      <h3 className="sec">Action types</h3>
      <p className="hint">The model is offered no tool outside this set.</p>
      <p>
        {policy.actions.map((a) => (
          <span key={a} className="tag">
            {a}
          </span>
        ))}
      </p>

      {rules(
        'Irreversible',
        policy.risk?.irreversible,
        'Refused outright during discovery — exploring by pressing "Post Transfer" in a bank is not acceptable at any confidence level. During replay these need explicit authorisation, or the run stops for a human.',
      )}
      {rules(
        'Mutating',
        policy.risk?.mutating,
        'Permitted, recorded, and visible in the evidence. Changing a form field is not the same kind of act as committing a transaction.',
      )}

      <h3 className="sec">Limits</h3>
      <table className="kv">
        <tbody>
          <tr>
            <th>max runtime</th>
            <td className="mono">{policy.limits.maxRuntimeMs} ms</td>
          </tr>
          <tr>
            <th>max recoveries</th>
            <td className="mono">{policy.limits.maxRecoveries}</td>
          </tr>
        </tbody>
      </table>

      <h3 className="sec">Redaction</h3>
      <p className="hint">
        Enforced at the write boundary, not at the reader: every event, snapshot and summary is
        redacted by the recorder before it reaches disk or this page. Secrets are never written — not
        even hashed. PII is replaced by a per-run salted hash, so occurrences correlate within a run
        and not across runs. Regions containing PII are blacked out <i>before</i> a screenshot is
        taken.
      </p>
    </div>
  );
}
