/**
 * A run's events as they arrive.
 *
 * Renders the recorder's own event stream rather than a prettified narration of
 * it, because the value of watching a run is seeing what the engine actually
 * decided — including the boring frames. What it does do is pick the few fields
 * worth reading per event kind, since the raw details include full observations.
 */

import type { RunEvent } from '../lib/api';

/** Fields worth surfacing, in the order a reader wants them. */
const INTERESTING = [
  'step',
  'intent',
  'action',
  'target',
  'code',
  'condition',
  'reason',
  'recovery',
  'attempt',
  'url',
  'name',
  'score',
  'outcome',
  'tool',
];

function summarise(e: RunEvent): string {
  const bits: string[] = [];
  for (const k of INTERESTING) {
    const v = e.detail[k];
    if (v === undefined || v === null) continue;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (!s || s === '{}') continue;
    bits.push(`${k}=${s.length > 90 ? `${s.slice(0, 90)}…` : s}`);
  }
  return bits.join(' ');
}

export function StepLog({ events }: { events: RunEvent[] }): JSX.Element {
  return (
    <div className="steps">
      {events.map((e) => (
        <div key={e.seq}>
          <span className="mono">[{String(e.seq).padStart(3, '0')}]</span>{' '}
          <span className="k mono">{e.kind}</span> <span className="mono">{summarise(e)}</span>
        </div>
      ))}
    </div>
  );
}
