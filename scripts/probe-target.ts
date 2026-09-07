/**
 * Dev utility: sign on to any configured product and dump what perception sees.
 *
 *   npx tsx scripts/probe-target.ts --profile config/apps/meridian-core.yaml /members/101555
 *   npx tsx scripts/probe-target.ts --profile config/apps/meridian-core.yaml --identity supervisor /members/101555/hold
 *
 * Deliberately drives the REAL surface, the REAL policy and the REAL auth block
 * from the product profile rather than reaching for selectors of its own. That
 * makes it a genuine smoke test of a new target adapter and not just a viewer:
 * if this signs on, the profile's field descriptors resolve, the allowlist
 * admits the routes, and the accessibility tree yields usable identity signals —
 * which is most of what has to be true before recording a capability.
 *
 * Prints exactly the three signals a descriptor is built from: an element's
 * accessible name, the caption recovered geometrically for unnamed controls, and
 * a table cell's column header plus row contents.
 */

import 'dotenv/config';
import { resolve as resolvePath } from 'node:path';
import { loadAppProfile, policyPathFor, tenantOf } from '../src/capability/application-profile.js';
import { Policy } from '../src/policy/guardrails.js';
import { ControlAuthority } from '../src/escalation/control-authority.js';
import { PlaywrightSurface } from '../src/surface/web/playwright-surface.js';
import { isInteractive } from '../src/surface/web/accessibility-tree.js';
import { ensureAuthenticated } from '../src/replay/recovery.js';

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const profilePath = flag('profile', 'config/apps/meridian-core.yaml')!;
const tenantId = flag('tenant');
const identity = flag('identity');
const fault = flag('fault');
const path = process.argv.filter((a) => a.startsWith('/')).pop() ?? '/';

const profile = loadAppProfile(resolvePath(profilePath));
const policy = Policy.fromFile(resolvePath(policyPathFor(profile, 'config/policy.json')));
const tenant = tenantOf(profile, tenantId ?? profile.tenants[0]!.id);
const url = new URL(path, tenant.baseUrl).toString();

const authority = new ControlAuthority('probe');
const surface = await PlaywrightSurface.launch({
  policy,
  authority,
  mode: 'replay',
  headful: process.env.HEADFUL === '1',
  ...(fault
    ? { fault: { kind: fault, param: 'inject', route: '/**', times: 1 } }
    : {}),
});
const token = () => authority.automationToken();

try {
  const entry = await surface.act({ type: 'navigate', url }, token());
  if (!entry.ok) throw new Error(`navigate failed: ${entry.error?.message}`);

  const auth = await ensureAuthenticated({
    surface,
    token,
    profile,
    tenant,
    returnUrl: url,
    ...(identity ? { identity } : {}),
  });
  console.log(`sign-on  : ${auth.ok ? 'ok' : 'FAILED'} — ${auth.note}`);
  if (auth.restartFlow) {
    // A cold sign-on lands on the landing page, so come back to what was asked for.
    await surface.act({ type: 'navigate', url }, token());
  }

  const obs = await surface.observe();
  console.log(`url      : ${obs.signals.url}`);
  console.log(`title    : ${obs.signals.title}`);
  console.log(`nodes    : ${obs.elements.length}\n`);

  console.log('--- INTERACTIVE (what a step can act on) ---');
  for (const n of obs.elements.filter((e) => isInteractive(e.role))) {
    const label = n.proximateLabels.length ? ` labelled=${JSON.stringify(n.proximateLabels[0])}` : '';
    console.log(`  ${n.role.padEnd(9)} name=${JSON.stringify(n.name).padEnd(28)}${label}`);
  }

  const labelled = obs.elements.filter(
    (e) => !isInteractive(e.role) && !e.context.columnHeader && e.proximateLabels.length,
  );
  console.log(`\n--- LABELLED VALUES (caption/value pairs) — ${labelled.length} ---`);
  for (const e of labelled.slice(0, 25)) {
    console.log(`  labelled=${JSON.stringify(e.proximateLabels[0]).padEnd(22)} value=${JSON.stringify(e.name)}`);
  }

  const cells = obs.elements.filter((e) => e.context.columnHeader);
  console.log(`\n--- TABLE CELLS (what an output can be read from) — ${cells.length} ---`);
  for (const c of cells.slice(0, 40)) {
    console.log(
      `  under=${JSON.stringify(c.context.columnHeader).padEnd(14)} ` +
        `value=${JSON.stringify(c.name).padEnd(20)} row=${JSON.stringify(c.context.rowCells)}`,
    );
  }

  console.log('\n--- VISIBLE TEXT (what a condition detector matches) ---');
  console.log(obs.signals.visibleText.slice(0, 900));
} finally {
  await surface.close();
}
