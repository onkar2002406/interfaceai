/**
 * Dev utility: confirms which coordinate space CDP box models report in for
 * elements inside a frame. Coordinate-based clicking depends on the answer.
 *
 *   npx tsx scripts/probe-frames.ts
 */

import { chromium } from 'playwright';
import { perceive } from '../src/surface/web/perception.js';

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

await page.goto('http://localhost:4000/', { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle');
const nav = page.frame({ name: 'navFrame' })!;
await nav.locator('a', { hasText: 'Member Search' }).click();
await page.waitForLoadState('networkidle');

const content = page.frame({ name: 'contentFrame' })!;
const fbox = await (await content.frameElement()).boundingBox();
console.log('contentFrame element box (page coords) :', fbox);

const viaLocator = await content.locator('#ctl00_ContentPlaceHolder1_txtMbrId').boundingBox();
console.log('input box via Playwright (page coords)  :', viaLocator);

const nodes = await perceive(page, cdp);
for (const n of nodes.filter((x) => x.role === 'textbox' || x.role === 'button')) {
  console.log(
    `perceive -> ${n.role.padEnd(8)} labels=${JSON.stringify(n.proximateLabels).padEnd(30)} ` +
      `frame=${n.framePath.join('/')} bounds=`,
    n.bounds,
  );
}

await browser.close();
