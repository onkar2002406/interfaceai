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
import { startCoreBank, stopCoreBank, type RunningInstance } from '../apps/corebank/start-servers.js';
import { loadAppProfile, tenantOf } from '../src/capability/application-profile.js';
import { CapabilityStore } from '../src/capability/store.js';
import { Policy } from '../src/policy/guardrails.js';
import { RunRecorder } from '../src/observability/run-recorder.js';
import { replay } from '../src/replay/executor.js';
import { summarize, type ReplayResult } from '../src/replay/replay-result.js';
import { renderDiscoverySummary, renderReplaySummary } from '../src/cli/run-reports.js';
import { discover } from '../src/discovery/loop.js';
import { compile } from '../src/discovery/trace-compiler.js';
import { ControlAuthority } from '../src/escalation/control-authority.js';
import { PlaywrightSurface } from '../src/surface/web/playwright-surface.js';
import {
  createProvider,
  defaultProviderName,
  describeProviders,
} from '../src/discovery/llm/provider-registry.js';
import type { LlmProvider } from '../src/discovery/llm/llm-provider.js';

const EVIDENCE = 'evidence';
const profile = loadAppProfile('config/apps/corebank-servicing.yaml');
const policy = Policy.fromFile('config/policy.json');
const store = new CapabilityStore('capabilities');
const lookup = store.load('lookup_member_savings_balance');
const subAccount = store.load('open_sub_account');

const results: Array<{ dir: string; headline: string; note: string }> = [];
/** True only when a live model actually completed the discovery goal. */
let usedLiveModel = false;
/** Why the live attempt did not produce the committed run, if it did not. */
let liveFailureReason: string | undefined;

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

const DISCOVERY_GOAL = 'look up member {{memberId}} and read their current savings balance';
const DISCOVERY_PARAMS = { memberId: '10001' };

/** One discovery attempt with a given provider. Leaves the surface closed. */
async function runDiscovery(provider: LlmProvider, slug: string): Promise<{
  trace: Awaited<ReturnType<typeof discover>>;
  recorder: RunRecorder;
}> {
  rmSync(join(EVIDENCE, `discovery-${slug}`), { recursive: true, force: true });

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
      goalTemplate: DISCOVERY_GOAL,
      params: DISCOVERY_PARAMS,
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
      allowedActions: policy.config.actions,
      maxSteps: 20,
    });
    return { trace, recorder };
  } finally {
    await surface.close();
  }
}

/**
 * Captures the discovery run.
 *
 * Prefers a live model, and falls back to the scripted fixture if the live
 * attempt does not *succeed* — not merely if no key is configured. A key that is
 * present but unfunded, or a model the account cannot reach, both produce a
 * failed run, and committing that as the discovery evidence would be worse than
 * committing an honest fixture run: the evidence set would be incomplete and
 * nothing downstream would replay.
 *
 * Whichever produced it, the banner in evidence/README.md says so plainly.
 */
async function discoveryCase(): Promise<void> {
  const slug = 'lookup-savings-balance';
  const providerName = defaultProviderName();

  if (providerName !== 'scripted') {
    const live = createProvider(providerName);
    console.log(
      `  attempting a live run with ${live.name}:${live.model}` +
        `${live.supportsVision ? '' : ' (text inventory only — this model has no vision)'}`,
    );
    const { trace, recorder } = await runDiscovery(live, slug);

    if (trace.outcome.kind === 'success') {
      usedLiveModel = true;
      finishDiscovery(trace, recorder);
      return;
    }

    // Every non-success arm of the outcome union carries a `why`.
    const why = trace.outcome.why;
    liveFailureReason = why;
    console.log(`  !! the live run did not complete: ${why.split('\n')[0]}`);
    console.log('  !! falling back to the scripted fixture so the evidence set stays complete.');
  } else {
    liveFailureReason = `no provider key was set (${describeProviders()})`;
    console.log('  !! no provider key set — using the scripted fixture.');
  }

  const { trace, recorder } = await runDiscovery(createProvider('scripted', { scriptedParams: DISCOVERY_PARAMS }), slug);
  finishDiscovery(trace, recorder);
}

function finishDiscovery(trace: Awaited<ReturnType<typeof discover>>, recorder: RunRecorder): void {
  const traceRef = recorder.snapshot('trace', trace);
  let compiledNote = 'no capability was compiled — an artifact is a promise that a flow works';

  if (trace.outcome.kind === 'success') {
    const capability = compile({ trace, profile, traceRef, name: 'discovered_member_savings' });
    /**
     * Compiled into the run's own evidence directory, not into `capabilities/`.
     *
     * The flow it discovers is the savings lookup, which `capabilities/
     * lookup_member_savings_balance@1.0.0.yaml` already covers — hand-authored,
     * reviewed, approved, with the First Valley overrides on it. Saving this one
     * beside it put two cards in the CoreBank panel's rail that do the same
     * thing, one of them a permanent draft nobody would ever approve because the
     * approved one is better. A catalog that advertises the same flow twice is
     * lying about what the system can do.
     *
     * It is still written, and still regenerated on every `npm run evidence`,
     * because it is the artifact under discussion: what the compiler produced
     * from a live model's trace, next to the transcript that produced it. It is
     * evidence of a discovery run rather than a capability on offer, so it lives
     * where the rest of that run's evidence lives.
     */
    new CapabilityStore(recorder.dir).save(capability);
    recorder.finish(trace, renderDiscoverySummary(trace, capability));
    compiledNote = `compiled ${capability.metadata.name}@${capability.metadata.version} (${capability.metadata.approval})`;
  } else {
    recorder.finish(trace, renderDiscoverySummary(trace, null));
  }

  results.push({
    dir: recorder.dir,
    headline: `${trace.outcome.kind} in ${trace.steps.length} steps via ${trace.provider}:${trace.model}`,
    note: `The discovery run: a goal in plain words, driven to completion, then compiled. ${compiledNote}.`,
  });
  console.log(`  ${'discovery'.padEnd(34)} ${trace.outcome.kind} in ${trace.steps.length} steps — ${compiledNote}`);
}

/* ---------------------------------------------------------------- driver */

/**
 * Gets exclusive-enough use of the target application before capturing.
 *
 * This matters more than it looks. Several scenarios arm a ONE-SHOT fault
 * (`times: 1`) and then drive the flow that is supposed to trip it. If anything
 * else touches the app in between — a browser tab left open on a member page —
 * that request consumes the fault instead, and the scenario records a success
 * where the committed evidence claims a failure. That has happened, and it is
 * silent: every run still passes, the artifact is just quietly wrong.
 *
 * So: start our own instances when nothing is listening, and when something is,
 * refuse if a human is evidently using it. `--reuse-app` overrides for the case
 * where you know the sessions are yours.
 */
async function claimTargetApp(): Promise<void> {
  const status = await fetch('http://localhost:4000/_admin/status', { signal: AbortSignal.timeout(1500) })
    .then((r) => (r.ok ? (r.json() as Promise<{ sessions: number }>) : null))
    .catch(() => null);

  if (!status) {
    started = await startCoreBank();
    console.log('Started the target application on ports 4000-4002.\n');
    return;
  }

  const force = process.argv.includes('--reuse-app');
  if (status.sessions > 0 && !force) {
    throw new Error(
      `The target application is already running and has ${status.sessions} active session(s) — ` +
        `something (probably a browser tab) is using it.\n\n` +
        `Capture arms one-shot faults, so a stray page load can consume a fault and turn a\n` +
        `failure scenario into a false success. Stop the running app (Ctrl+C in its terminal)\n` +
        `and re-run, or pass --reuse-app if you are certain those sessions are inert.`,
    );
  }

  // Known baseline: clear any half-armed fault and stale sessions from earlier runs.
  await Promise.all(
    [4000, 4001, 4002].map((p) =>
      fetch(`http://localhost:${p}/_admin/reset`, { method: 'POST' }).catch(() => {}),
    ),
  );
  console.log('Using the already-running target application (faults and sessions reset).\n');
}

let started: RunningInstance[] = [];
try {
  await claimTargetApp();

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
    // Certificate, not Savings: 10001 already holds an open Savings account and
    // the institution permits one per product, so a Savings request would be
    // refused at the review screen and never reach the irreversible step this
    // case exists to demonstrate.
    params: { memberId: '10001', accountType: 'Certificate', initialDeposit: '100.00', nickname: 'Holiday Fund' },
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
  await replayCase({
    slug: 'business-outcome-duplicate-account',
    capability: subAccount,
    // A well-formed request the institution will never accept: 10002 already
    // holds an open Savings account. Distinct from the case above, where the
    // input was malformed — here nothing is wrong with what was asked, so
    // "correct it and retry" would be the wrong advice and a different code
    // says so. Refused at the review screen, before the irreversible step.
    params: { memberId: '10002', accountType: 'Savings', initialDeposit: '100.00', nickname: 'Rainy Day' },
    authorizeIrreversible: true,
    note: 'The member already holds this product. DUPLICATE_ACCOUNT_TYPE — nothing was created.',
  });

  writeIndex();
  console.log(`\nWrote ${results.length} runs to ${EVIDENCE}/`);
  console.log('Run `npm run handoff` separately to capture the human-handoff run.');
  if (!usedLiveModel) {
    console.log(
      `\n!! The committed discovery run came from the offline fixture.\n` +
        `!! Reason: ${(liveFailureReason ?? 'no live attempt was made').split('\n')[0]}\n` +
        '!! Fix that and re-run `npm run evidence` before submitting.',
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
    lines.push('>');
    lines.push(`> Reason: ${liveFailureReason ?? 'no live attempt was made'}`);
    lines.push('>');
    lines.push('> Fix that, then re-run `npm run evidence` to replace this with a genuine');
    lines.push('> LLM-driven run. The compiled artifact');
    lines.push('> `discovery-lookup-savings-balance/discovered_member_savings@1.0.0.yaml` is');
    lines.push('> regenerated at the same time, and its `metadata.provenance.model` field');
    lines.push('> records which produced it.');
    lines.push('');
  } else {
    lines.push('The discovery run below was produced by a **live language model** driving the');
    lines.push('real application. See its `summary.md` for the model, the token count, and the');
    lines.push('reasoning it gave for each step.');
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
  lines.push('The human-handoff run is captured by `scripts/demo-human-handoff.ts`, which stands');
  lines.push('in for the *person* only — the console, the screencast, the control tokens and');
  lines.push('the resume verification in that run are all the real ones.');
  writeFileSync(join(EVIDENCE, 'README.md'), `${lines.join('\n')}\n`, 'utf8');
}

if (!existsSync(EVIDENCE)) throw new Error('evidence directory missing');
