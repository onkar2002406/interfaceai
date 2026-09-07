/**
 * What a calling agent sees.
 *
 * The capability set as function-calling tool definitions — the exact objects
 * handed to a model, derived from the same artifacts everything else reads. The
 * descriptions spell out declared business outcomes on purpose: a tool
 * description is the only thing many agents read before choosing, and
 * "returns MEMBER_NOT_FOUND if no such member exists" prevents a whole class of
 * pointless retry loops before it starts.
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Tool {
  name: string;
  description: string;
  parameters: unknown;
}

export function AgentView({ operatorUrl }: { operatorUrl: string }): JSX.Element {
  const [tools, setTools] = useState<Tool[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void api
      .tools()
      .then((r) => setTools(r.tools))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <p className="hint">{error}</p>;

  return (
    <div>
      <h2>Agent view</h2>
      <p className="hint">
        <span className="mono">GET /api/v1/tools</span> — hand these to a model.{' '}
        <span className="mono">POST /api/v1/invoke</span> runs one and returns the four-arm contract
        synchronously. A business outcome comes back <b>200</b>: the application answered, and
        returning 4xx for "no such member" would re-introduce at the transport layer exactly the
        conflation the result contract exists to prevent.
      </p>
      <p className="hint">
        Authorising an irreversible action is the header{' '}
        <span className="mono">x-authorize-irreversible: true</span> — never a body field, so a model
        composing JSON arguments structurally cannot set it. Runs that stop for a human return an{' '}
        <span className="mono">operatorUrl</span> pointing at{' '}
        <a href={operatorUrl} target="_blank" rel="noopener noreferrer">
          {operatorUrl}
        </a>
        .
      </p>

      {tools.map((t) => (
        <div key={t.name} className="card">
          <h3>{t.name}</h3>
          <p className="why">{t.description}</p>
          <details>
            <summary className="hint">Parameters (JSON Schema)</summary>
            <pre>{JSON.stringify(t.parameters, null, 2)}</pre>
          </details>
        </div>
      ))}
    </div>
  );
}
