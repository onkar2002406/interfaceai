/**
 * Regenerates the curated contents of /evidence.
 *
 *   npx tsx scripts/capture-evidence.ts
 *
 * Runs the canonical scenarios end to end against the live target application
 * and writes each into a named directory, so the committed evidence is
 * reproducible rather than a snapshot of whatever happened to be in the
 * directory when the repo was pushed.
 *
 * Uses a live model for the discovery run when OPENAI_API_KEY is set, and the
 * scripted fixture otherwise. Which one produced the committed run is recorded
 * in the discovery run's own summary and in evidence/README.md.
 */

import 'dotenv/config';
import { rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startCoreBank, stopCoreBank, type RunningInstance } from '../apps/corebank/main.js';
import { loadAppProfile, tenantOf } from '../src/capability/app-profile.js';
import { CapabilityStore } from '../src/capability/store.js';
import { Policy } from '../src/policy/policy.js';
import { RunRecorder } from '../src/observability/evidence.js';
import { replay } from '../src/replay/executor.js';
import { summarize, type ReplayResult } from '../src/replay/outcomes.js';
import { renderDiscoverySummary, renderReplaySummary } from '../src/cli/report.js';
import { discover } from '../src/agent/loop.js';
import { compile } from '../src/agent/compile.js';
import { ControlAuthority } from '../src/escalation/control.js';
import { PlaywrightSurface } from '../src/surface/web/playwright-surface.js';
import { MockProvider } from '../src/agent/provider/mock.js';
import { OpenAiProvider } from '../src/agent/provider/openai.js';
import type { LlmProvider } from '../src/agent/provider/types.js';

const EVIDENCE = 'evidence';
const profile = loadAppProfile('config/apps/corebank-servicing.yaml');
const policy = Policy.fromFile('config/policy.json');
const store = new CapabilityStore('capabilities');
const lookup = store.load('lookup_member_savings_balance');
const subAccount = store.load('open_sub_account');

const results: Array<{ dir: string; headline: string; note: string }> = [];
let usedLiveModel = false;

async function armFault(baseUrl: string, mode: string, route?: string): Promise<void> {
  await fetch(`${baseUrl}/_admin/fault`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, times: 1, route }),
  });
}

async function replayCase(opts: {
  slug: string;
  note: string;
  capability?: typeof lookup;
  params: Record<string, string>;
  tenantId?: string;
  fault?: { mode: string; route?: string };
  authorizeIrreversible?: boolean;
}): Promise<void> {
  const dir = join(EVIDENCE, `replay-${opts.slug}`);
  rmSync(dir, { recursive: true, force: true });

  const tenantId = opts.tenantId ?? 'base';
  const tenant = tenantOf(profile, tenantId);
  if (opts.fault) await armFault(tenant.baseUrl, opts.fault.mode, opts.fault.route);

  const recorder = new RunRecorder(opts.slug, 'replay', EVIDENCE, { consoleEcho: false });
  const result: ReplayResult = await replay({
    capability: opts.capability ?? lookup,
    params: opts.params,
    tenantId,
    profile,
    policy,
    recorder,
    authorizeIrreversible: opts.authorizeIrreversible ?? false,
  });
  recorder.finish(result, renderReplaySummary(result));

  const headline = summarize(result).split('\n')[0]!;
  results.push({ dir: recorder.dir, headline, note: opts.note });
  console.log(`  ${opts.slug.padEnd(34)} ${headline.slice(0, 110)}`);

  if (opts.fault) await armFault(tenant.baseUrl, 'none');
}

async function discoveryCase(): Promise<void> {
  const slug = 'lookup-savings-balance';
  rmSync(join(EVIDENCE, `discovery-${slug}`), { recursive: true, force: true });

  let provider: LlmProvider;
  if (process.env.OPENAI_API_KEY) {
    provider = new OpenAiProvider();
    usedLiveModel = true;
    console.log(`  using live model ${provider.model}`);
  } else {
    provider = new MockProvider({ memberId: '10001' });
    console.log('  !! OPENAI_API_KEY not set — falling back to the scripted fixture.');
    console.log('  !! The committed discovery evidence MUST come from a live model run.');
  }

  const recorder = new RunRecorder(slug, 'discovery', EVIDENCE, { consoleEcho: false });
  const tenant = tenantOf(profile, 'base');
  const authority = new ControlAuthority(slug);
  const surface = await PlaywrightSurface.launch({
    policy,
    authority,
    mode: 'discovery',
    onEvent: (e) => recorder.event(`surface_${e.kind}`, e.detail),
  });

  try {
    const trace = await discover({
      goalTemplate: 'look up member {{memberId}} and read their current savings balance',
      params: { memberId: '10001' },
      entryUrl: new URL('/', tenant.baseUrl).toString(),
      product: profile.product,
      tenant: tenant.id,
      profile,
      tenantProfile: tenant,
      provider,
      surface,
      authority,
      recorder,
      allowedOrigins: policy.config.origins,
      maxSteps: 20,
    });

    const traceRef = recorder.snapshot('trace', trace);
    let compiledNote = 'did not complete';
    if (trace.outcome.kind === 'success') {
      const capability = compile({ trace, profile, traceRef, name: 'discovered_member_savings' });
      store.save(capability);
      recorder.finish(trace, renderDiscoverySummary(trace, capability));
      compiledNote = `compiled ${capability.metadata.name}@${capability.metadata.version} (${capability.metadata.approval})`;
    } else {
      recorder.finish(trace, renderDiscoverySummary(trace, null));
    }

    results.push({
      dir: recorder.dir,
      headline: `${trace.outcome.kind} in ${trace.steps.length} steps via ${trace.provider}:${trace.model}`,
      note: `The LLM-driven discovery run. ${compiledNote}.`,
    });
    console.log(`  ${'discovery'.padEnd(34)} ${trace.outcome.kind} in ${trace.steps.length} steps — ${compiledNote}`);
  } finally {
    await surface.close();
  }
}

/* ---------------------------------------------------------------- driver */

let started: RunningInstance[] = [];
try {
  const alive = await fetch('http://localhost:4000/_admin/status', { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!alive) {
    started = await startCoreBank();
    console.log('Started the target application.\n');
  } else {
    console.log('Using the already-running target application.\n');
  }

  console.log('Discovery');
  await discoveryCase();

  console.log('\nReplay — the four arms of the result contract');
  await replayCase({
    slug: 'success',
    params: { memberId: '10001' },
    note: 'The happy path: three steps, outputs extracted and typed.',
  });
  await replayCase({
    slug: 'business-outcome-not-found',
    params: { memberId: '99999' },
    note: 'A member that does not exist. Returned as MEMBER_NOT_FOUND — an answer, not a crash.',
  });
  await replayCase({
    slug: 'business-outcome-permission-denied',
    params: { memberId: '10007' },
    note: 'A restricted record. PERMISSION_DENIED — a different operator identity might succeed.',
  });
  await replayCase({
    slug: 'failure-app-error',
    params: { memberId: '10001' },
    fault: { mode: 'app_error', route: '/member/*' },
    note: 'An injected application error. Reported as surface_error with what was on screen — NOT as a checkpoint timeout.',
  });

  console.log('\nReplay — recoverable runtime conditions');
  await replayCase({
    slug: 'recovered-interstitial',
    params: { memberId: '10001' },
    fault: { mode: 'interstitial', route: '/search' },
    note: 'A surprise maintenance overlay, dismissed without a human.',
  });
  await replayCase({
    slug: 'recovered-session-expiry',
    params: { memberId: '10001' },
    fault: { mode: 'session', route: '/member/*' },
    note: 'The session expires mid-flow. Re-authenticated, then the flow restarts from the entry point because its position was lost.',
  });
  await replayCase({
    slug: 'recovered-slow-load',
    params: { memberId: '10001' },
    fault: { mode: 'slow', route: '/member/*' },
    note: 'A six-second stall, absorbed by checkpoint polling rather than a fixed sleep.',
  });

  console.log('\nReplay — the same artifact across three institutions');
  await replayCase({
    slug: 'tenant-firstvalley',
    params: { memberId: '10001' },
    tenantId: 'firstvalley',
    note: 'Relabelled controls. Two overrides carry it; a third difference resolves structurally and reports a drift signal.',
  });
  await replayCase({
    slug: 'tenant-harborcu',
    params: { memberId: '10001' },
    tenantId: 'harborcu',
    note: 'Newer build, reordered accounts table, mandatory privacy screen. ZERO overrides.',
  });

  console.log('\nSafety and escalation');
  await replayCase({
    slug: 'escalation-irreversible-unattended',
    capability: subAccount,
    params: { memberId: '10001', accountType: 'Savings', initialDeposit: '100.00', nickname: 'Holiday Fund' },
    note: 'An irreversible step with no authorisation. Parks and escalates; nothing was committed.',
  });
  await replayCase({
    slug: 'irreversible-authorised',
    capability: subAccount,
    params: { memberId: '10002', accountType: 'Checking', initialDeposit: '250.00', nickname: 'Escrow' },
    authorizeIrreversible: true,
    note: 'The same flow with an approved artifact and explicit invocation authorisation. Completes.',
  });
  await replayCase({
    slug: 'business-outcome-validation',
    capability: subAccount,
    params: { memberId: '10002', accountType: 'Savings', initialDeposit: '5.00', nickname: 'TooSmall' },
    authorizeIrreversible: true,
    note: 'An opening deposit below the institution minimum. VALIDATION_ERROR — nothing was created.',
  });

  writeIndex();
  console.log(`\nWrote ${results.length} runs to ${EVIDENCE}/`);
  console.log('Run `npm run handoff` separately to capture the human-handoff run.');
  if (!usedLiveModel) {
    console.log(
      '\n!! The discovery run used the offline fixture. Set OPENAI_API_KEY in .env and\n' +
        '!! re-run `npm run evidence` before submitting — see the banner in evidence/README.md.',
    );
  }
} finally {
  if (started.length) await stopCoreBank(started);
}

function writeIndex(): void {
  const lines: string[] = [];
  lines.push('# Evidence');
  lines.push('');

  if (!usedLiveModel) {
    lines.push('> [!IMPORTANT]');
    lines.push('> **The discovery run below was produced by the offline scripted fixture, not a live model.**');
    lines.push('> `OPENAI_API_KEY` was not set when this evidence was captured.');
    lines.push('>');
    lines.push('> Set the key in `.env` and re-run `npm run evidence` to replace it with a real');
    lines.push('> LLM-driven run before this repository is submitted. The compiled capability');
    lines.push('> `capabilities/discovered_member_savings@1.0.0.yaml` should be regenerated at the');
    lines.push('> same time — its `provenance.model` field records which produced it.');
    lines.push('');
  }

  lines.push('Recorded runs against the local target application. Regenerate with:');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run app        # in one terminal');
  lines.push('npm run evidence   # in another — everything except the handoff run');
  lines.push('npm run handoff    # the human-handoff run');
  lines.push('```');
  lines.push('');
  lines.push('Every directory contains:');
  lines.push('');
  lines.push('- `events.jsonl` — the structured event log, one JSON object per line');
  lines.push('- `summary.md` — the same run written for a human');
  lines.push('- `result.json` — the full machine-readable result');
  lines.push('- screenshots and accessibility snapshots for any failure or escalation');
  lines.push('');
  lines.push('Everything written here passes through redaction: secrets are never written,');
  lines.push('PII appears as a per-run salted hash, and screenshots have sensitive elements');
  lines.push('blacked out *before* capture.');
  lines.push('');
  lines.push('| Run | Outcome | What it shows |');
  lines.push('|---|---|---|');
  for (const r of results) {
    const name = r.dir.replace(/\\/g, '/').replace(/^evidence\//, '');
    lines.push(`| [\`${name}\`](${name}/summary.md) | ${r.headline.replace(/\|/g, '\\|')} | ${r.note} |`);
  }

  // Captured by a separate script, because it needs the operator console.
  if (existsSync(join(EVIDENCE, 'replay-human-handoff'))) {
    lines.push(
      '| [`replay-human-handoff`](replay-human-handoff/summary.md) | SUCCESS after a human took over | ' +
        'The full handoff: policy stops an irreversible step, an operator views the live session, is **refused** ' +
        'input until they claim control, clicks the real button on the same session, hands back, and the executor ' +
        're-verifies its resume contract before finishing. |',
    );
  }

  lines.push('');
  lines.push('The human-handoff run is captured by `scripts/demo-handoff.ts`, which stands');
  lines.push('in for the *person* only — the console, the screencast, the control tokens and');
  lines.push('the resume verification in that run are all the real ones.');
  writeFileSync(join(EVIDENCE, 'README.md'), `${lines.join('\n')}\n`, 'utf8');
}

if (!existsSync(EVIDENCE)) throw new Error('evidence directory missing');
