/**
 * A capability's contract, rendered straight from its schemas.
 *
 * Nothing here is hand-written per capability, and that is the point: the
 * inputs, the outputs and the declared business outcomes are all *derived* from
 * the artifact a human reviewed and approved. A front end with its own idea of
 * what `funds_transfer` takes is a second source of truth, and the first time it
 * disagrees with the YAML it will be the UI that is believed.
 */

import type { CapabilityCard, JsonSchema } from '../lib/api';

function SchemaRows({ schema, markRequired }: { schema: JsonSchema; markRequired?: boolean }): JSX.Element {
  const names = Object.keys(schema.properties ?? {});
  if (!names.length) {
    return (
      <tr>
        <td colSpan={3} className="hint">
          none
        </td>
      </tr>
    );
  }
  return (
    <>
      {names.map((n) => {
        const p = schema.properties[n]!;
        return (
          <tr key={n}>
            <td className="mono">
              {n}
              {/* Only meaningful for inputs. JSON Schema calls an output
                  "required" too, but there it means the caller can rely on it —
                  a different claim, and rendering both as `*` reads as a form
                  field somebody forgot to fill in. */}
              {markRequired && schema.required?.includes(n) ? ' *' : ''}
            </td>
            <td className="mono">{p.type ?? '—'}</td>
            <td>
              {p.description ?? ''}
              {p.pattern && (
                <>
                  <br />
                  <span className="hint mono">pattern {p.pattern}</span>
                </>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}

export function ContractTable({ card }: { card: CapabilityCard }): JSX.Element {
  return (
    <>
      <h2>Contract</h2>
      <div className="card">
        <h3>
          {card.name}@{card.version}
        </h3>
        <p className="why">{card.summary}</p>
        <div>
          <span className={`tag ${card.approval === 'approved' ? 'safe' : 'draft'}`}>{card.approval}</span>
          {card.hasIrreversibleStep ? (
            <span className="tag risk">irreversible step</span>
          ) : (
            <span className="tag safe">read-only</span>
          )}
        </div>
      </div>

      <h3 className="sec">Inputs — supplied per invocation</h3>
      <table className="kv">
        <thead>
          <tr>
            <th>name</th>
            <th>type</th>
            <th>meaning</th>
          </tr>
        </thead>
        <tbody>
          <SchemaRows schema={card.inputSchema} markRequired />
        </tbody>
      </table>

      <h3 className="sec">Outputs — returned to the caller</h3>
      <table className="kv">
        <thead>
          <tr>
            <th>name</th>
            <th>type</th>
            <th>meaning</th>
          </tr>
        </thead>
        <tbody>
          <SchemaRows schema={card.outputSchema} />
        </tbody>
      </table>

      <h3 className="sec">Business outcomes — answers, not errors</h3>
      {card.businessOutcomes.length ? (
        <table className="kv">
          <thead>
            <tr>
              <th>code</th>
              <th>means</th>
            </tr>
          </thead>
          <tbody>
            {card.businessOutcomes.map((b) => (
              <tr key={b.code}>
                <td className="mono">{b.code}</td>
                <td>{b.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="hint">None declared.</p>
      )}
    </>
  );
}
