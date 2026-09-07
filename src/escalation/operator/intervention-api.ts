/**
 * The intervention transport, mounted rather than owned.
 *
 * This module exists because the handoff now has two front doors. The standalone
 * operator console (port 4100) was the first; the chat UI's escalation modal is
 * the second, and it has to reach the live session from the *panel's* origin —
 * a browser will happily render a cross-origin iframe but it will not let the
 * page inside it be driven, and proxying a screencast through a second process
 * would mean two copies of the CDP pump to keep correct.
 *
 * So the routes and the WebSocket bridge move here and both servers mount them.
 * `console-server.ts` mounts them at `/ws`; the panel mounts them at
 * `/ws/session`. There is one implementation of "claim, drive, hand back", and
 * one implementation of the frame pump.
 *
 * What deliberately does NOT change, and is the reason this was an extraction
 * rather than a rewrite:
 *
 *   - **Viewing needs no token.** A person should be able to watch a parked
 *     session before deciding to take responsibility for it.
 *   - **Acting requires the claim token**, checked per input event against
 *     `ControlAuthority`, which rotates on every transition. A console whose page
 *     is still open after a hand-back cannot keep driving.
 *   - **Typed characters are not recorded.** Named keys only. An operator filling
 *     in a member's details must not write regulated data into the evidence log
 *     one keystroke at a time.
 */

import type { Express, Request, Response } from 'express';
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { InterventionBroker } from '../intervention-broker.js';
import type { PlaywrightSurface } from '../../surface/web/playwright-surface.js';

export interface InterventionApiOptions {
  basePath?: string;
  /**
   * Whether to register the collection route.
   *
   * The panel already serves `GET /api/interventions` — its version carries the
   * operator console URL alongside the queue, which its status badge needs — and
   * registering a second handler for the same path would leave a route that can
   * never fire. Better to say so than to shadow it silently.
   */
  includeList?: boolean;
}

/** The intervention queue as HTTP: read it, claim one, hand it back, give it up. */
export function mountInterventionApi(
  app: Express,
  broker: InterventionBroker,
  options: InterventionApiOptions = {},
): void {
  const basePath = options.basePath ?? '/api/interventions';
  const includeList = options.includeList ?? true;

  if (includeList) {
    app.get(basePath, (_req: Request, res: Response) => {
      res.json({
        open: broker.list(),
        resolved: broker.resolved().map((r) => ({ id: r.request.id, resolution: r.outcome.resolution })),
      });
    });
  }

  app.get(`${basePath}/:id`, (req: Request, res: Response) => {
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

  app.post(`${basePath}/:id/claim`, (req: Request, res: Response) => {
    try {
      const operator = String(req.body.operator ?? 'operator');
      const { request } = broker.claim(String(req.params.id), operator);
      res.json({ ok: true, request, state: 'HUMAN' });
    } catch (err) {
      // 409, not 400: the request was well-formed and the caller is not at
      // fault. Somebody else holds this session, or it has already been
      // resolved — a conflict with the world, not a malformed input.
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post(`${basePath}/:id/handback`, (req: Request, res: Response) => {
    try {
      broker.handBack(String(req.params.id), String(req.body.note ?? ''));
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post(`${basePath}/:id/abandon`, (req: Request, res: Response) => {
    try {
      broker.abandon(String(req.params.id), String(req.body.reason ?? 'operator could not resolve'));
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * Attaches the live-session WebSocket bridge to an already-built http server.
 *
 * Returns a closer, because a `WebSocketServer` outlives `server.close()` unless
 * it is told otherwise and the process then hangs on exit — which in a demo
 * looks exactly like a crash.
 */
export function attachSessionBridge(
  server: Server,
  broker: InterventionBroker,
  path = '/ws',
): () => void {
  const wss = new WebSocketServer({ server, path });

  wss.on('connection', (ws: WebSocket, req) => {
    const id = new URL(req.url ?? '', 'http://localhost').searchParams.get('id') ?? '';
    void attachSession(ws, broker, id);
  });

  // A WebSocketServer mounted on an http server re-emits that server's errors.
  // Without a listener here, a failure to bind becomes an unhandled 'error'
  // event and takes the process down before the caller can pick another port.
  wss.on('error', () => {
    /* surfaced via the http server's own 'error' event */
  });

  return () => wss.close();
}

/**
 * Wires one browser tab — console or chat modal — to one live automation session.
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
    // input is refused — a console cannot keep driving a session it no longer
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
