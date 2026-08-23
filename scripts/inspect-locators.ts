/**
 * Dev utility: run a capability's descriptors against a live screen and show
 * the resolver's candidate ranking.
 *
 *   npx tsx scripts/probe-resolve.ts
 *
 * This is the tool you reach for when replay reports "could not find X" — it
 * shows what the resolver actually saw and what it scored.
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import { perceive } from '../src/surface/web/accessibility-tree.js';
import { resolve, scoreCandidate } from '../src/surface/element-resolver.js';
import { CapabilityStore } from '../src/capability/store.js';
import { describeDescriptor } from '../src/surface/element-descriptor.js';

const store = new CapabilityStore('capabilities');
const cap = store.load('lookup_member_savings_balance');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('DOM.enable');
await cdp.send('Accessibility.enable');

await page.goto('http://localhost:4000/login', { waitUntil: 'domcontentloaded' });
await page.locator('#ctl00_txtOperator').fill('svc.demo');
await page.locator('#ctl00_txtPwd').fill('demo1234');
await page.locator('input[type=submit]').click();
await page.waitForLoadState('networkidle');

// Drive to member detail the same way replay does — through the frameset.
await page.goto('http://localhost:4000/', { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle');
await page.frame({ name: 'navFrame' })!.locator('a', { hasText: 'Member Search' }).click();
await page.waitForLoadState('networkidle');
const content = page.frame({ name: 'contentFrame' })!;
await content.locator('#ctl00_ContentPlaceHolder1_txtMbrId').fill('10001');
await content.locator('input[type=submit]').click();
await page.waitForLoadState('networkidle');

const nodes = await perceive(page, cdp);
console.log(`perceived ${nodes.length} nodes`);
console.log(`cells: ${nodes.filter((n) => n.role === 'cell').length}`);
console.log(`with columnHeader: ${nodes.filter((n) => n.context.columnHeader).length}\n`);

for (const out of cap.spec.outputs) {
  const d = out.from.target;
  console.log(`--- output "${out.name}": ${describeDescriptor(d)}`);
  console.log(`    descriptor role=${JSON.stringify(d.role)} name=${JSON.stringify(d.name)} anchors=${JSON.stringify(d.anchors)}`);

  const scored = nodes
    .map((n) => ({ n, s: scoreCandidate(d, n) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => b.s!.score - a.s!.score)
    .slice(0, 5);

  if (scored.length === 0) {
    console.log('    NO CANDIDATES PASSED THE ROLE FILTER');
    console.log(`    roles on page: ${[...new Set(nodes.map((n) => n.role))].join(', ')}`);
  }
  for (const { n, s } of scored) {
    console.log(
      `    ${s!.score.toFixed(3)}  ${n.role.padEnd(12)} name=${JSON.stringify(n.name).padEnd(16)} ` +
        `col=${JSON.stringify(n.context.columnHeader)} matched=[${s!.matched.join(',')}]`,
    );
  }
  const r = resolve(d, nodes);
  console.log(`    => ${r.ok ? `RESOLVED "${r.node.name}" via ${r.info.strategy}` : `FAILED (${r.reason})`}\n`);
}

await browser.close();
