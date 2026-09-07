/**
 * The four arms of the result contract, rendered as four distinct things.
 *
 * This is the most important component in the interface and the one most worth
 * resisting the urge to simplify. `success | business_outcome | escalated |
 * failed` is a union, not a status string with a colour attached, and the
 * rendering keeps them apart on purpose:
 *
 *   - **success** carries outputs. Nothing else does.
 *   - **business_outcome** is an ANSWER. "No such member" is what the caller
 *     asked about, correctly determined. Rendering it in the failure colour, or
 *     collapsing it into an `error` field, would undo the single distinction the
 *     whole engine is built around.
 *   - **escalated** means a person is needed, or was. It is the expected result
 *     of asking for an irreversible action without authorisation — not a bug.
 *   - **failed** is the only arm that is a defect, and it is the only one that
 *     gets the debugging apparatus: step, expected, observed, screenshot.
 */

import type { ReplayResult } from '../lib/api';

export interface VerdictProps {
  result: ReplayResult | null;
  crash?: string | null;
  evidenceDir?: string;
  /** Rendered when a run parked and the intervention may still be open. */
  onOpenEscalation?: (interventionId: string) => void;
  onOpenEvidence?: (dir: string) => void;
}

export function Verdict({ result, crash, evidenceDir, onOpenEscalation, onOpenEvidence }: VerdictProps): JSX.Element {
  const evidence = evidenceDir ? (
    <p className="hint">
      Evidence: <span className="mono">{evidenceDir}</span>
      {onOpenEvidence && (
        <>
          {' — '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onOpenEvidence(evidenceDir.replace(/^evidence\//, ''));
            }}
          >
            open
          </a>
        </>
      )}
    </p>
  ) : null;

  if (crash || !result) {
    return (
      <div className="verdict failed">
        <h3>Run crashed</h3>
        <p className="hint">
          The automation itself threw, rather than returning one of the four result arms. That is a
          different thing from the flow failing, and it is reported as such.
        </p>
        <pre>{crash || 'no result returned'}</pre>
        {evidence}
      </div>
    );
  }

  switch (result.status) {
    case 'success':
      return (
        <div className="verdict success">
          <h3>Success</h3>
          <p>Outputs returned to the caller:</p>
          <pre>{JSON.stringify(result.outputs ?? {}, null, 2)}</pre>
          {!!result.driftSignals?.length && (
            <p className="hint">
              {result.driftSignals.length} drift signal(s) — the locators resolved, but not cleanly.
              This install may need an override.
            </p>
          )}
          {evidence}
        </div>
      );

    case 'business_outcome':
      return (
        <div className="verdict business">
          <h3>
            Business outcome — <span className="mono">{result.code}</span>
          </h3>
          <p>{result.message}</p>
          <p className="hint">
            A legitimate answer, not a failure. The application was asked a question and this is what
            it said. Nothing was retried, because the answer will not change.
          </p>
          {result.outputs && Object.keys(result.outputs).length > 0 && (
            <pre>{JSON.stringify(result.outputs, null, 2)}</pre>
          )}
          {evidence}
        </div>
      );

    case 'escalated':
      return (
        <div className="verdict escalated">
          <h3>Escalated to a human</h3>
          <p>{result.reason}</p>
          <p>
            Resolution: <span className="mono">{result.resolution ?? 'pending'}</span>
            {result.operatorNote ? ` — “${result.operatorNote}”` : ''}
          </p>
          {result.resolution === 'unattended' && (
            <p className="hint">
              Nobody was attached to take it. Reported as such rather than as a failure — "needed a
              person, none available" is a different fact from "the flow does not work".
            </p>
          )}
          {result.interventionId && onOpenEscalation && (
            <p>
              <button className="mini" onClick={() => onOpenEscalation(result.interventionId!)}>
                Open the live session
              </button>
            </p>
          )}
          {evidence}
        </div>
      );

    case 'failed': {
      const e = result.error ?? {};
      return (
        <div className="verdict failed">
          <h3>
            Failed — <span className="mono">{e.class ?? 'error'}</span>
          </h3>
          <table className="kv">
            <tbody>
              {e.message && (
                <tr>
                  <th>What</th>
                  <td>{e.message}</td>
                </tr>
              )}
              {e.step && (
                <tr>
                  <th>Step</th>
                  <td className="mono">{e.step}</td>
                </tr>
              )}
              {e.expected && (
                <tr>
                  <th>Expected</th>
                  <td>{e.expected}</td>
                </tr>
              )}
              {e.observed && (
                <tr>
                  <th>Observed</th>
                  <td>{e.observed}</td>
                </tr>
              )}
            </tbody>
          </table>
          {e.screenshot && (
            <img className="shot" src={`/api/evidence-file?path=${encodeURIComponent(e.screenshot)}`} alt="failure" />
          )}
          {evidence}
        </div>
      );
    }

    default:
      return (
        <div className="verdict failed">
          <h3>Unrecognised result</h3>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </div>
      );
  }
}
