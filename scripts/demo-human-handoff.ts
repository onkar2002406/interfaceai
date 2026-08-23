/**
 * End-to-end demonstration of the human-in-the-loop handoff.
 *
 *   npx tsx scripts/demo-handoff.ts
 *
 * What is simulated: the *person*. A script stands in for the operator, because
 * a demo that needs someone to click a button is not reproducible evidence.
 *
 * What is NOT simulated — everything the mechanism actually consists of:
 *
 *   - the real operator console, driven over its real HTTP API (claim, hand back)
 *   - the real CDP screencast, over the real WebSocket the browser UI uses
 *   - real mouse events dispatched into the SAME live browser session the
 *     executor was driving, at coordinates read off the screen
 *   - the real ControlAuthority token check on every one of those events
 *   - the real resume contract, re-verified by the executor before it continues
 *
 * The run this drives is a genuine policy stop: `open_sub_account` ends in an
 * irreversible step, invoked without authorisation, so replay parks rather than
 * committing. The operator finishes that step by hand and hands control back.
 */

import 'dotenv/config';
import WebSocket from 'ws';
import { loadAppProfile } from '../src/capability/application-profile.js';
import { CapabilityStore } from '../src/capability/store.js';
import { Policy } from '../src/policy/guardrails.js';
import { RunRecorder } from '../src/observability/run-recorder.js';
import { replay } from '../src/replay/executor.js';
import { summarize, type ReplayResult } from '../src/replay/replay-result.js';
import { connectToOperatorConsole } from '../src/escalation/operator/console-client.js';
import { renderReplaySummary } from '../src/cli/run-reports.js';
import type { PlaywrightSurface } from '../src/surface/web/playwright-surface.js';
import { resolve as resolveDescriptor } from '../src/surface/element-resolver.js';

const OPERATOR = 'j.okafor';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, timeoutMs: number, failure: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(100);
  }
  throw new Error(`${failure} (waited ${timeoutMs}ms)`);
}

const profile = loadAppProfile('config/apps/corebank-servicing.yaml');
const policy = Policy.fromFile('config/policy.json');
const store = new CapabilityStore('capabilities');
const capability = store.load('open_sub_account');

const attached = await connectToOperatorConsole({ waitMs: 120_000 });
const base = attached.console.url;
console.log(`\nOperator console listening at ${base}\n`);

// Stable directory name so this lands in curated evidence rather than as one
// more anonymous run id.
const recorder = new RunRecorder('human-handoff', 'replay');

// Start the run. It will reach the irreversible step and park there.
const runPromise: Promise<ReplayResult> = replay({
  capability,
  params: { memberId: '10002', accountType: 'Checking', initialDeposit: '250.00', nickname: 'Escrow' },
  tenantId: 'base',
  profile,
  policy,
  recorder,
  sink: attached.sink,
  // Deliberately NOT authorising the irreversible step — that is what forces
  // the escalation this demo is about.
  authorizeIrreversible: false,
});

/* ------------------------------------------------ stand in for the human */

async function waitForIntervention(): Promise<string> {
  for (let i = 0; i < 120; i++) {
    const r = (await fetch(`${base}/api/interventions`).then((x) => x.json())) as {
      open: Array<{ id: string; atStep: { intent: string }; reason: string }>;
    };
    if (r.open.length) {
      const first = r.open[0]!;
      console.log(`\n[operator] intervention ${first.id} is waiting`);
      console.log(`[operator]   step: ${first.atStep.intent}`);
      console.log(`[operator]   why : ${first.reason}\n`);
      return first.id;
    }
    await sleep(500);
  }
  throw new Error('no intervention was raised within 60s');
}

const id = await waitForIntervention();

// 1. Watch the live session before deciding anything. Viewing needs no token —
//    an operator should be able to understand a stuck run before taking it on.
//
//    Note Chromium emits a screencast frame on *visual change*, so a static
//    screen yields exactly one frame and then goes quiet. That is correct
//    behaviour, not a stalled stream.
const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?id=${id}`);
let frames = 0;
let denied: string | undefined;

ws.on('message', (raw) => {
  const m = JSON.parse(String(raw)) as { type: string; message?: string };
  if (m.type === 'frame') frames += 1;
  if (m.type === 'denied') denied = m.message ?? 'denied';
});

await new Promise<void>((r) => ws.on('open', () => r()));
await waitUntil(() => frames > 0, 10_000, 'no screencast frame arrived');
console.log(`[operator] receiving live screencast of the same session (${frames} frame(s))`);

// 2. Prove the token gate: input BEFORE claiming must be refused.
ws.send(JSON.stringify({ type: 'input', event: { kind: 'mouse', type: 'mousePressed', x: 10, y: 10 } }));
await waitUntil(() => denied !== undefined, 5_000, 'un-claimed input was not refused');
console.log(`[operator] tried to click without taking control -> REFUSED: ${denied}`);

// 3. Take control.
const claim = await fetch(`${base}/api/interventions/${id}/claim`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ operator: OPERATOR }),
});
console.log(`[operator] claimed control as "${OPERATOR}" -> ${claim.status === 200 ? 'HUMAN' : 'FAILED'}`);

// 4. Do the work by hand: find the button on screen and click its pixels,
//    exactly as a person moving a mouse over the canvas would.
const surface = attached.sink.surfaceFor(id) as PlaywrightSurface;
const token = attached.sink.operatorToken(id);
const obs = await surface.observe();
const found = resolveDescriptor(
  {
    description: 'the Submit Application button',
    role: 'button',
    name: 'Submit Application',
    nameMatch: 'normalized',
    scope: {},
    anchors: [],
    hints: {},
  },
  obs.elements,
);
if (!found.ok) throw new Error(`operator could not find the submit button on screen: ${found.reason}`);
const b = found.node.bounds!;
const cx = Math.round(b.x + b.width / 2);
const cy = Math.round(b.y + b.height / 2);
console.log(`[operator] clicking "${found.node.name}" at (${cx}, ${cy}) on the live session`);

ws.send(JSON.stringify({ type: 'input', event: { kind: 'mouse', type: 'mouseMoved', x: cx, y: cy } }));
ws.send(JSON.stringify({ type: 'input', event: { kind: 'mouse', type: 'mousePressed', x: cx, y: cy, clickCount: 1 } }));
ws.send(JSON.stringify({ type: 'input', event: { kind: 'mouse', type: 'mouseReleased', x: cx, y: cy, clickCount: 1 } }));
await sleep(1200);

// 5. Hand control back. This does NOT resume anything by itself — the executor
//    re-observes and checks the resume contract before it acts again.
const hb = await fetch(`${base}/api/interventions/${id}/handback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ note: 'Submitted the application manually after supervisor approval (ticket OPS-4471).' }),
});
console.log(`[operator] handed control back -> ${hb.status === 200 ? 'RESUMING' : 'FAILED'}\n`);
ws.close();

/* ----------------------------------------------------------- the result */

const result = await runPromise;
recorder.finish(result, renderReplaySummary(result));

console.log(`\n${summarize(result)}`);
console.log(`\nSteps:`);
for (const s of result.steps) {
  console.log(`  ${s.stepId.padEnd(4)} ${s.status.padEnd(10)} ${s.intent}${s.note ? `\n         ↳ ${s.note}` : ''}`);
}
console.log(`\nEvidence: ${recorder.dir}`);

await attached.close();
process.exit(result.status === 'success' ? 0 : 1);
