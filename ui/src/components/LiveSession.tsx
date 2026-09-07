/**
 * The parked browser session, live, in a canvas.
 *
 * This is the part of the handoff that had to be real, so it is worth being
 * precise about what it is: frames come out of the *same* Chromium page the
 * automation was driving, over CDP screencast, and the operator's mouse and
 * keyboard go back into that same page over CDP input. Nobody gets a fresh
 * browser. Cookies, session, scroll position and half-filled form fields are all
 * exactly as the automation left them, because it never left.
 *
 * Two rules the transport enforces and this component must not appear to soften:
 *
 *   - **Viewing needs no claim.** The canvas streams as soon as it is open, so a
 *     person can see what happened before deciding to take responsibility for it.
 *   - **Acting needs the claim token.** Input handlers are attached regardless
 *     but refuse to send unless `claimed`, and the server refuses again on its
 *     own account. A refusal comes back as a `denied` frame and is shown, rather
 *     than silently dropped — an operator clicking into a dead session deserves
 *     to be told why nothing is happening.
 */

import { useEffect, useRef } from 'react';

export interface LiveSessionProps {
  interventionId: string;
  /** Whether this viewer holds control. Gates input, never the video. */
  claimed: boolean;
  onLog: (line: string) => void;
}

interface InputEvent {
  kind: 'mouse' | 'key' | 'scroll';
  [k: string]: unknown;
}

export function LiveSession({ interventionId, claimed, onLog }: LiveSessionProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Read by the event handlers, which are attached once. A plain closure over
  // the prop would capture the value at attach time and the operator's first
  // click after claiming would still be refused.
  const claimedRef = useRef(claimed);
  claimedRef.current = claimed;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/session?id=${encodeURIComponent(interventionId)}`);
    wsRef.current = ws;

    ws.onopen = () => onLog('viewing the live session (read-only until you take control)');

    ws.onmessage = (e) => {
      let m: { type?: string; data?: string; message?: string };
      try {
        m = JSON.parse(String(e.data)) as typeof m;
      } catch {
        return;
      }
      if (m.type === 'frame' && m.data) {
        const img = new Image();
        img.onload = () => {
          // The screencast can change resolution mid-session (a viewport
          // change, a zoom). Track it rather than scaling into a fixed canvas,
          // or the coordinate mapping below silently goes wrong.
          if (canvas.width !== img.width || canvas.height !== img.height) {
            canvas.width = img.width;
            canvas.height = img.height;
          }
          ctx.drawImage(img, 0, 0);
        };
        img.src = `data:image/jpeg;base64,${m.data}`;
      } else if (m.type === 'denied') {
        onLog(`REFUSED: ${m.message ?? ''}`);
      } else if (m.type === 'error') {
        onLog(`ERROR: ${m.message ?? ''}`);
      }
    };

    ws.onclose = () => onLog('stream closed');

    const send = (event: InputEvent): void => {
      if (!claimedRef.current) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'input', event }));
    };

    /* Coordinates must be in the page's space, not the canvas element's. */
    const pt = (e: MouseEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.round((e.clientX - r.left) * (canvas.width / r.width)),
        y: Math.round((e.clientY - r.top) * (canvas.height / r.height)),
      };
    };

    const onDown = (e: MouseEvent): void => {
      const p = pt(e);
      send({ kind: 'mouse', type: 'mousePressed', x: p.x, y: p.y, clickCount: 1 });
    };
    const onUp = (e: MouseEvent): void => {
      const p = pt(e);
      send({ kind: 'mouse', type: 'mouseReleased', x: p.x, y: p.y, clickCount: 1 });
    };
    const onMove = (e: MouseEvent): void => {
      const p = pt(e);
      send({ kind: 'mouse', type: 'mouseMoved', x: p.x, y: p.y });
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const p = pt(e);
      send({ kind: 'scroll', x: p.x, y: p.y, deltaY: e.deltaY });
    };

    const typingHere = (): boolean => {
      const el = document.activeElement;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!claimedRef.current) return;
      // The operator's own name and note fields are on this page. Typing into
      // them must not be forwarded into the member's browser session.
      if (typingHere()) return;
      e.preventDefault();
      send({ kind: 'key', type: 'keyDown', key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode });
      if (e.key.length === 1) send({ kind: 'key', type: 'char', text: e.key });
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (!claimedRef.current) return;
      if (typingHere()) return;
      send({ kind: 'key', type: 'keyUp', key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode });
    };

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mouseup', onUp);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      wsRef.current = null;
    };
    // `onLog` is deliberately not a dependency: it changes identity on every
    // render of the parent, and re-running this effect would tear down and
    // rebuild the screencast — visibly, several times a second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interventionId]);

  return (
    <div className="stage">
      <canvas ref={canvasRef} className={claimed ? 'live' : ''} width={1280} height={900} />
    </div>
  );
}
