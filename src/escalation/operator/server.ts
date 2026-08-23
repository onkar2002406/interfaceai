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
 */

import express from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InterventionBroker } from '../broker.js';
import type { PlaywrightSurface } from '../../surface/web/playwright-surface.js';

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

  app.get('/api/interventions', (_req, res) => {
    res.json({
      open: broker.list(),
      resolved: broker.resolved().map((r) => ({ id: r.request.id, resolution: r.outcome.resolution })),
    });
  });

  app.get('/api/interventions/:id', (req, res) => {
    const d = broker.detail(String(req.params.id));
    if (!d) {
      res.status(404).json({ error: 'no such open intervention' });
      return;
    }
    res.json({
      request: d.request,
      state: d.state,
      operator: d.operator ?? null,
      actions: d.actions,
    });
  });

  app.post('/api/interventions/:id/claim', (req, res) => {
    try {
      const operator = String(req.body.operator ?? 'operator');
      const { request } = broker.claim(String(req.params.id), operator);
      res.json({ ok: true, request, state: 'HUMAN' });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/interventions/:id/handback', (req, res) => {
    try {
      broker.handBack(String(req.params.id), String(req.body.note ?? ''));
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/interventions/:id/abandon', (req, res) => {
    try {
      broker.abandon(String(req.params.id), String(req.body.reason ?? 'operator could not resolve'));
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const server: Server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req) => {
    const id = new URL(req.url ?? '', 'http://localhost').searchParams.get('id') ?? '';
    void attachSession(ws, broker, id);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });

  return {
    url: `http://localhost:${port}`,
    close: async () => {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Wires one browser tab in the console to one live automation session.
 */
async function attachSession(ws: WebSocket, broker: InterventionBroker, id: string): Promise<void> {
  let surface: PlaywrightSurface;
  try {
    surface = broker.surfaceFor(id) as PlaywrightSurface;
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
    ws.close();
    return;
  }

  const stop = await surface.startScreencast((jpegBase64) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'frame', data: jpegBase64 }));
  });

  ws.on('message', async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type !== 'input') return;

    // Every input is gated on the operator's control token. If the token has
    // been rotated (handed back, abandoned, timed out), this throws and the
    // input is refused — the console cannot keep driving a session it no longer
    // holds, even if its page is still open.
    let token;
    try {
      token = broker.operatorToken(id);
    } catch (err) {
      ws.send(JSON.stringify({ type: 'denied', message: err instanceof Error ? err.message : String(err) }));
      return;
    }

    try {
      await surface.dispatchHumanInput(token, msg.event as never);
    } catch (err) {
      ws.send(JSON.stringify({ type: 'denied', message: err instanceof Error ? err.message : String(err) }));
      return;
    }

    // Record what the human did — but not every mouse move, which would bury
    // the meaningful actions in noise.
    const ev = msg.event as { kind?: string; type?: string; text?: string; key?: string; x?: number; y?: number };
    if (ev.kind === 'mouse' && ev.type === 'mousePressed') {
      broker.record(id, { at: new Date().toISOString(), kind: 'click', detail: { x: ev.x, y: ev.y } });
    } else if (ev.kind === 'key' && ev.type === 'keyDown' && ev.key && ev.key.length > 1) {
      // Named keys only (Enter, Tab, Backspace). Typed characters are NOT
      // recorded: an operator filling in a member's details would otherwise
      // write regulated data into the evidence log one keystroke at a time.
      broker.record(id, { at: new Date().toISOString(), kind: 'key', detail: { key: ev.key } });
    }
  });

  ws.on('close', () => {
    void stop();
  });
}
