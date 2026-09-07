/**
 * Operator console — the human end of the handoff.
 *
 * Scope, stated honestly: this is a minimal but *real* console, not a product.
 * It runs in the same process as the run it is serving, has no authentication,
 * no operator queue, no assignment, and no session recording. Those are the
 * parts the brief explicitly allows mocking, and they are all behind the
 * `EscalationSink` interface, which is where a durable queue and an on-call
 * rota would go.
 *
 * What is NOT mocked is the part the brief cares about: the human takes control
 * of the *same live browser session* the automation was using. Frames stream out
 * of Chromium over CDP screencast; the operator's mouse and keyboard go back in
 * over CDP input, gated by the same `ControlAuthority` token that gates the
 * executor. Nobody gets a fresh browser, nothing is replayed for them, and there
 * is no window in which both parties may act.
 *
 * The routes and the frame pump themselves live in `intervention-api.ts`,
 * because the chat UI's escalation modal needs the identical transport from the
 * panel's own origin. This file is now the standalone console: a port, a page,
 * and the two mounts.
 */

import express from 'express';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InterventionBroker } from '../intervention-broker.js';
import { attachSessionBridge, mountInterventionApi } from './intervention-api.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface OperatorConsole {
  url: string;
  close: () => Promise<void>;
}

export async function startOperatorConsole(
  broker: InterventionBroker,
  port = Number(process.env.OPERATOR_PORT ?? 4100),
): Promise<OperatorConsole> {
  const app = express();
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.type('html').send(readFileSync(join(here, 'console.html'), 'utf8'));
  });

  mountInterventionApi(app, broker);

  const server: Server = createServer(app);
  const closeBridge = attachSessionBridge(server, broker, '/ws');

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    // Port 0 asks the OS for a free one; read back what it actually gave us.
    server.listen(port, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  return {
    url: `http://localhost:${boundPort}`,
    close: async () => {
      closeBridge();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
