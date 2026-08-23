/**
 * Dev utility: dump what perception sees on a given URL.
 *
 *   npx tsx scripts/probe-perception.ts http://localhost:4000/login
 *
 * Useful for sanity-checking that a legacy screen produces usable identity
 * signals — especially `proximateLabels` on inputs that have no accessible name.
 */

import { chromium } from 'playwright';
import { perceive, readSignals, isInteractive } from '../src/surface/web/accessibility-tree.js';

const url = process.argv[2] ?? 'http://localhost:4000/login';
const loginFirst = process.argv.includes('--login');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('DOM.enable');
await cdp.send('Accessibility.enable');

if (loginFirst) {
  const origin = new URL(url).origin;
  await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#ctl00_txtOperator').fill('svc.demo');
  await page.locator('#ctl00_txtPwd').fill('demo1234');
  await page.locator('input[type=submit]').click();
  await page.waitForLoadState('networkidle');
}

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle').catch(() => {});

const signals = await readSignals(page, cdp);
const nodes = await perceive(page, cdp);

console.log(`URL      : ${signals.url}`);
console.log(`Title    : ${signals.title}`);
console.log(`Frames   : ${signals.frames.join(' | ')}`);
console.log(`Nodes    : ${nodes.length}\n`);

console.log('--- INTERACTIVE ---');
for (const n of nodes.filter((n) => isInteractive(n.role))) {
  const b = n.bounds ? `(${Math.round(n.bounds.x)},${Math.round(n.bounds.y)} ${Math.round(n.bounds.width)}x${Math.round(n.bounds.height)})` : '(no box)';
  console.log(
    `${n.id.padEnd(5)} ${n.role.padEnd(10)} name=${JSON.stringify(n.name).padEnd(24)} ` +
      `labels=${JSON.stringify(n.proximateLabels)} frame=${n.framePath.join('/')} ${b} hint=${n.domHint ?? '-'}`,
  );
}

console.log('\n--- TABLE CELLS (first 14) ---');
for (const n of nodes.filter((n) => n.context.columnHeader).slice(0, 14)) {
  console.log(
    `${n.id.padEnd(5)} ${n.role.padEnd(9)} text=${JSON.stringify(n.name).padEnd(18)} ` +
      `col=${JSON.stringify(n.context.columnHeader)} row=${JSON.stringify(n.context.rowCells?.slice(0, 3))}`,
  );
}

await browser.close();
