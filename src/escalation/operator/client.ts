/**
 * Attaches a run to an operator console.
 *
 * The console runs **in the same process as the run**. That is a deliberate
 * simplification and worth being explicit about: it means the console can hand
 * the operator the actual live browser session with no cross-process plumbing,
 * which is the part of the handoff that had to be real. What it gives up is
 * durability — kill the run and the pending intervention goes with it.
 *
 * A production deployment inverts this: the broker becomes a durable queue, the
 * console is a long-lived service, and workers register their sessions with it.
 * `EscalationSink` is the seam where that swap happens, and nothing in the
 * executor changes.
 */

import { InterventionBroker } from '../broker.js';
import { startOperatorConsole, type OperatorConsole } from './server.js';

export interface AttachedConsole {
  sink: InterventionBroker;
  console: OperatorConsole;
  close: () => Promise<void>;
}

export async function connectToOperatorConsole(opts: { port?: number; waitMs?: number } = {}): Promise<AttachedConsole> {
  const broker = new InterventionBroker({
    // Generous by default: a human has to notice, open the console, read the
    // context and act. Ten minutes is the difference between a real handoff and
    // a demo that times out while you are reading it.
    waitMs: opts.waitMs ?? 10 * 60 * 1000,
  });

  const consoleServer = await startOperatorConsole(broker, opts.port);

  broker.onChange(() => {
    const open = broker.list();
    if (open.length > 0) {
      console.log(`\n  >>> ${open.length} intervention(s) waiting for a human: ${consoleServer.url}\n`);
    }
  });

  return {
    sink: broker,
    console: consoleServer,
    close: () => consoleServer.close(),
  };
}
