/**
 * Subscribes to a run's live step stream.
 *
 * The panel's `/api/runs/:id/stream` replays everything already buffered before
 * it starts sending live frames, so a component that mounts halfway through a
 * run still sees the whole thing. That property is what makes this safe to use
 * from the chat, where a bubble is created only once the model has decided to
 * invoke something — several hundred milliseconds after the run began.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReplayResult, RunEvent } from './api';

export interface RunStream {
  events: RunEvent[];
  done: boolean;
  result: ReplayResult | null;
  crash: string | null;
  discovered: unknown;
}

const EMPTY: RunStream = { events: [], done: false, result: null, crash: null, discovered: null };

export function useRunStream(runId: string | null): RunStream {
  const [state, setState] = useState<RunStream>(EMPTY);
  // The last run this hook opened a stream for. Without it, React 18's
  // development StrictMode double-effect opens two EventSources per run and the
  // step log renders every event twice — which looks exactly like a retry bug.
  const opened = useRef<string | null>(null);

  useEffect(() => {
    if (!runId) {
      setState(EMPTY);
      opened.current = null;
      return;
    }
    if (opened.current === runId) return;
    opened.current = runId;
    setState(EMPTY);

    const es = new EventSource(`/api/runs/${runId}/stream`);

    es.addEventListener('step', (e) => {
      const event = JSON.parse((e as MessageEvent).data) as RunEvent;
      setState((s) => ({ ...s, events: [...s.events, event] }));
    });

    es.addEventListener('done', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as {
        result?: ReplayResult | null;
        crash?: string | null;
        discovered?: unknown;
      };
      setState((s) => ({
        ...s,
        done: true,
        result: d.result ?? null,
        crash: d.crash ?? null,
        discovered: d.discovered ?? null,
      }));
      es.close();
    });

    // An EventSource reconnects on error by default, which for a stream the
    // server has deliberately ended means a reconnect loop against a finished
    // run. Close it and let the `done` frame be the only end condition.
    es.onerror = () => es.close();

    return () => es.close();
  }, [runId]);

  return state;
}
