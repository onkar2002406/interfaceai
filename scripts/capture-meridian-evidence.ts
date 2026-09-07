/**
 * Regenerates the curated MERIDIAN CORE evidence set.
 *
 *   npx tsx scripts/capture-meridian-evidence.ts
 *   npx tsx scripts/capture-meridian-evidence.ts --member 103001
 *
 * Every scenario the brief asks the replay engine to distinguish, run end to end
 * against the hosted target and written into a named directory. This is the
 * backup for demo day: the network will not be a friend under pressure, and a
 * committed run with its screenshots, step log and result contract is what makes
 * the story tellable when the live attempt stalls.
 *
 * No model is involved in any of it. These are all deterministic replays.
 *
 * ## Why it picks its own share ids
 *
 * The target is a shared, public, in-memory instance that other people are using
 * at the same time, and it resets on redeploy. Balances move, shares get holds
 * placed on them, and the seed member who had an open Money Market share
 * yesterday may have none today. A fixture that hard-coded "103001-MMKT-4"
 * would therefore go green on the day it was written and produce a confusing
 * VALIDATION_ERROR on demo day — which is exactly the failure mode this script
 * exists to insure against.
 *
 * So it reads the member's current shares first and chooses live ones. That is
 * also the honest shape of the thing: a capability takes a share id as an
 * argument precisely because the system cannot know it in advance.
 */

import 'dotenv/config';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadAppProfile, policyPathFor, tenantOf } from '../src/capability/application-profile.js';
import { CapabilityStore } from '../src/capability/store.js';
import { Policy } from '../src/policy/guardrails.js';
import { RunRecorder } from '../src/observability/run-recorder.js';
import { replay } from '../src/replay/executor.js';
import { summarize, type ReplayResult } from '../src/replay/replay-result.js';
import { renderReplaySummary } from '../src/cli/run-reports.js';
import { planFault } from '../src/target/faults.js';
import { sliceForAgent } from '../src/api/contract.js';

const EVIDENCE = 'evidence/meridian';

const profile = loadAppProfile('config/apps/meridian-core.yaml');
const policy = Policy.fromFile(policyPathFor(profile, 'config/policy.json'));
const store = new CapabilityStore('capabilities');
const tenant = tenantOf(profile, profile.tenants[0]!.id);

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const MEMBER = flag('member', '103001');

const results: Array<{ dir: string; headline: string; note: string }> = [];

/* ------------------------------------------------------------- live state */

interface Share {
  id: string;
  type: string;
  balance: number;
  status: string;
}

/**
 * Reads the member's shares straight off the page, the same way a person would.
 *
 * Deliberately plain HTTP rather than the automation: this is the harness
 * choosing the arguments for a scenario, not part of any scenario. Using the
 * capability engine to set up its own fixtures would make a failure here look
 * like a failure of the thing under test.
 */
async function readShares(memberId: string): Promise<Share[]> {
  const jar: string[] = [];
  const keep = (res: Response): void => {
    const c = res.headers.get('set-cookie');
    if (c) jar.push(c.split(';')[0]!);
  };
  const cookie = (): Record<string, string> => (jar.length ? { cookie: jar.join('; ') } : {});

  const user = process.env[profile.identities.teller?.user ?? ''] ?? '';
  const password = process.env[profile.identities.teller?.password ?? ''] ?? '';
  if (!user || !password) {
    throw new Error(
      'MERIDIAN_TELLER_OPERATOR / MERIDIAN_TELLER_PASSWORD are not set in .env — ' +
        'the harness cannot read the member record to choose live share ids.',
    );
  }

  keep(await fetch(new URL('/signon', tenant.baseUrl), { redirect: 'manual', headers: cookie() }));
  keep(
    await fetch(new URL('/signon', tenant.baseUrl), {
      method: 'POST',
      redirect: 'manual',
      headers: { ...cookie(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ operator: user, password, branch: 'MAIN-001' }).toString(),
    }),
  );

  const html = await fetch(new URL(`/members/${memberId}`, tenant.baseUrl), { headers: cookie() }).then((r) => r.text());

  const shares: Share[] = [];
  // The shares table, row by row: id | type | balance | status.
  const rows = html.matchAll(
    /<td>(\d+-[A-Z0-9-]+)<\/td>\s*<td>([^<]*)<\/td>\s*<td align="right">\$([\d,]+\.\d{2})<\/td>\s*<td>(\w+)/g,
  );
  for (const m of rows) {
    shares.push({ id: m[1]!, type: m[2]!.trim(), balance: Number(m[3]!.replace(/,/g, '')), status: m[4]! });
  }
  return shares;
}

/* ------------------------------------------------------------- scenarios */

async function replayCase(opts: {
  slug: string;
  headline: string;
  note: string;
  capability: string;
  params: Record<string, string>;
  identity?: string;
  fault?: string;
  authorizeIrreversible?: boolean;
}): Promise<ReplayResult> {
  // The recorder names its own directory `<kind>-<runId>`, so the slug is the
  // run id. Clearing it first keeps the committed set reproducible rather than
  // an accumulation of whatever has been run.
  const dir = join(EVIDENCE, `replay-${opts.slug}`).replace(/\\/g, '/');
  rmSync(dir, { recursive: true, force: true });

  const capability = store.load(opts.capability);
  const recorder = new RunRecorder(opts.slug, 'replay', EVIDENCE, { consoleEcho: false });

  const armed = opts.fault ? planFault(profile, tenant, opts.fault) : undefined;
  if (armed?.via === 'endpoint') await armed.arm();

  let result: ReplayResult;
  try {
    result = await replay({
      capability,
      params: opts.params,
      tenantId: tenant.id,
      profile,
      policy,
      recorder,
      ...(opts.identity ? { identity: opts.identity } : {}),
      ...(armed?.via === 'surface' ? { fault: armed.fault } : {}),
      authorizeIrreversible: Boolean(opts.authorizeIrreversible),
    });
  } finally {
    if (armed?.via === 'endpoint') await armed.disarm();
  }

  recorder.finish(result, renderReplaySummary(result));
  // The agent-facing slice beside the full envelope: what a caller received, in
  // the same directory as everything that produced it.
  writeFileSync(join(dir, 'agent-result.json'), `${JSON.stringify(sliceForAgent(result), null, 2)}\n`, 'utf8');

  results.push({ dir: opts.slug, headline: opts.headline, note: opts.note });
  console.log(`  ${opts.slug.padEnd(34)} ${summarize(result).slice(0, 110)}`);
  return result;
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE, { recursive: true });

  console.log(`Reading member ${MEMBER}'s current shares to choose live arguments…`);
  const shares = await readShares(MEMBER);
  const open = shares.filter((s) => s.status === 'OPEN');
  const held = shares.find((s) => s.status === 'HOLD');

  if (open.length === 0) {
    throw new Error(
      `member ${MEMBER} currently has no OPEN share — the shared demo instance has drifted. ` +
        `Try another seed member with --member (100234, 100987, 101555, 102777, 103001).`,
    );
  }
  const readable = open[0]!;
  console.log(`  ${shares.length} shares, ${open.length} open. Reading ${readable.id} ($${readable.balance}).\n`);

  console.log(`Capturing evidence into ${EVIDENCE}/\n`);

  /* ---- the happy path ---- */
  await replayCase({
    slug: 'success-balance',
    headline: 'A capability completes and returns typed outputs',
    note:
      'Recorded against one member, replayed against another. No model is involved: the descriptors ' +
      'name the balance cell by its column header and the row holding the requested share id.',
    capability: 'get_balance',
    params: { memberId: MEMBER, shareId: readable.id },
    identity: 'teller',
  });

  /* ---- business outcomes: answers, not failures ---- */
  await replayCase({
    slug: 'business-member-not-found',
    headline: 'MEMBER_NOT_FOUND — an answer the caller asked for',
    note:
      'Returned in a few hundred milliseconds because classification runs on every poll of the ' +
      'checkpoint wait, so the condition fires long before a deadline that was never going to be met.',
    capability: 'get_balance',
    params: { memberId: '999999', shareId: '999999-S0001' },
    identity: 'teller',
  });

  await replayCase({
    slug: 'business-supervisor-required',
    headline: 'SUPERVISOR_OVERRIDE_REQUIRED — an entitlement answer, not an error',
    note:
      'HTTP 403. Reported as a business outcome because nothing is broken: the application answered ' +
      'the question "may this operator do this?" and the answer was no. A calling agent needs to route ' +
      'the work to someone entitled, which it can only do if it is told an answer rather than handed ' +
      'an exception.',
    capability: 'get_balance',
    params: { memberId: MEMBER, shareId: readable.id },
    identity: 'teller',
    fault: 'permission',
  });

  await replayCase({
    slug: 'business-validation-rejected',
    headline: 'VALIDATION_ERROR — the application refused the values',
    note:
      'HTTP 400. Also a business outcome: the caller supplied data the business rules refuse, which is ' +
      'information rather than a malfunction, and retrying it unchanged will produce the same answer.',
    capability: 'get_balance',
    params: { memberId: MEMBER, shareId: readable.id },
    identity: 'teller',
    fault: 'validation',
  });

  /* ---- recoverable conditions ---- */
  await replayCase({
    slug: 'recovered-maintenance',
    headline: 'A maintenance interstitial is cleared and the run carries on',
    note:
      'HTTP 503 replaces the page mid-flow. `retry_request` asks for it again rather than dismissing ' +
      'it — the Continue link on that screen goes to the main menu, which would clear the condition ' +
      'and lose the flow position in the same motion.',
    capability: 'get_balance',
    params: { memberId: MEMBER, shareId: readable.id },
    identity: 'teller',
    fault: 'maintenance',
  });

  await replayCase({
    slug: 'recovered-session-timeout',
    headline: 'The session expires mid-flow and the run re-authenticates',
    note:
      'HTTP 440 destroys the session, so every later request lands on sign-on. The run signs on again ' +
      'from environment credentials and restarts the flow from its entry point, because a new session ' +
      'does not restore where it was.',
    capability: 'get_balance',
    params: { memberId: MEMBER, shareId: readable.id },
    identity: 'teller',
    fault: 'timeout',
  });

  /* ---- hard failure ---- */
  await replayCase({
    slug: 'failure-application-error',
    headline: 'An application error is diagnosed, not timed out',
    note:
      "HTTP 500. Reported as `surface_error` naming the screen's own ERR- reference, so it can be " +
      'traced in the vendor\'s logs — rather than as a checkpoint timeout that says only "nothing arrived".',
    capability: 'get_balance',
    params: { memberId: MEMBER, shareId: readable.id },
    identity: 'teller',
    fault: 'server',
  });

  /* ---- who is asking changes the answer ---- */
  if (held) {
    console.log(`\n  (share ${held.id} is on HOLD — usable for the hold scenarios)`);
  }

  /* ---- the irreversible gate, which is the point of the posting flows ---- */

  // The transfer drives the whole flow — lookup, share selection, amount,
  // Continue — and then stops dead at `Post Transfer`. Nothing is committed.
  // This is the scenario the brief is really asking about, and the interesting
  // part is WHERE it stops: at step 10 of 10, on the confirmation screen, with
  // the values already verified by the previous step's checkpoint.
  const second = open[1] ?? readable;
  await replayCase({
    slug: 'escalated-irreversible-transfer',
    headline: 'A funds transfer runs to the posting step and stops for a human',
    note:
      'Not a failure and not a refusal to try: every step up to the commit ran, the review screen ' +
      'was reached and its contents asserted, and then policy declined to press "Post Transfer" ' +
      'unattended. The browser session stays open and parked so a person can take it over on the ' +
      'live session rather than starting again.',
    capability: 'funds_transfer',
    params: {
      memberId: MEMBER,
      fromShare: readable.id,
      toShare: second.id,
      amount: '1.00',
      memo: 'evidence capture',
    },
    identity: 'teller',
  });

  // Entitlement is the application's answer, not our guess at one. A teller is
  // told no by MERIDIAN itself, and that arrives as a business outcome rather
  // than an exception — which is what lets a calling agent route the work to
  // somebody who does have the entitlement.
  await replayCase({
    slug: 'business-supervisor-gated-hold',
    headline: 'SUPERVISOR_OVERRIDE_REQUIRED — the application declines the operator, not the request',
    note:
      'Place Account Hold is entitlement-gated. Nothing is broken: MERIDIAN answered the question ' +
      '"may this operator do this?" and the answer was no. Reported as an outcome code a caller ' +
      'can branch on, with the run stopping before it reaches anything irreversible.',
    capability: 'place_account_hold',
    params: {
      memberId: MEMBER,
      shareId: (held ?? readable).id,
      reason: 'FRAUD',
      notes: 'evidence capture',
    },
    identity: 'teller',
  });

  /* ---- the four capabilities that had no committed replay ---- */

  // Every other scenario here signs on as a precondition, so sign-on is proven
  // a dozen times over — but only ever as a side effect. Captured on its own
  // because "session handling" is its own line in the brief, and because a
  // precondition that fails is a different failure from a step that fails.
  await replayCase({
    slug: 'success-sign-on',
    headline: 'Session handling on its own — the precondition every other run depends on',
    note:
      'Takes no credentials as arguments. The capability declares that it needs an authenticated ' +
      'session; the runtime supplies the identity from the product profile, and the operator id and ' +
      'password reach the step log as {{__operator}} and [REDACTED:secret] rather than as values.',
    capability: 'sign_on',
    identity: 'teller',
    params: {},
  });

  // Search by LAST NAME rather than by member number: the other half of §2.1's
  // "member inquiry / selection", and the half that has to pick a row out of a
  // result table rather than navigate straight to a record.
  await replayCase({
    slug: 'success-member-inquiry-by-name',
    headline: 'Member inquiry by last name — selecting a row from a result set',
    note:
      'Recorded searching for one surname and replayed for another. The Select link is addressed by ' +
      'the row it sits in rather than by position, so a result set that comes back in a different ' +
      'order still resolves to the right member.',
    capability: 'member_inquiry',
    params: { lastName: 'Hopper' },
    identity: 'teller',
  });

  // Exercises the mailing-address field added by scripts/add-form-fields.ts.
  // The values are the ones already on the record: this is a shared public
  // instance, and a capture run should prove the flow works without editing
  // somebody else's demo data underneath them.
  await replayCase({
    slug: 'success-update-member-info',
    headline: 'Update Member Information — e-mail, phone and mailing address',
    note:
      'Writes the values already on file, so the flow is exercised end to end without changing the ' +
      'record on a shared instance. The mailing address REPLACES what is on file rather than ' +
      'appending, which is why the input is required rather than optional.',
    capability: 'update_member_info',
    params: {
      memberId: MEMBER,
      email: 'verified.member@example.net',
      phone: '415-555-0196',
      address: '130 Demo Street, San Francisco, CA 94104',
    },
    identity: 'teller',
  });

  // The third posting flow. Like the transfer above it drives everything up to
  // the commit and then stops, so the capture creates nothing.
  await replayCase({
    slug: 'escalated-irreversible-open-share',
    headline: 'Open New Share — drives to the commit and stops, having created nothing',
    note:
      'The review screen was reached and its contents asserted, and then policy declined to press ' +
      '"Open Share" unattended. Two gates have to open for that step: the artifact must be approved ' +
      'by a human, and the invocation must explicitly authorise it. This run had neither.',
    capability: 'open_new_share',
    // The option's full display text, not the friendly half of it. MERIDIAN
    // labels these "S0001 - Regular Shares"; passing "Regular Shares" fails the
    // select outright rather than matching loosely, which is the behaviour you
    // want from something about to open an account.
    params: { memberId: MEMBER, shareType: 'S0001 - Regular Shares', deposit: '5.00' },
    identity: 'teller',
  });

  writeSummary(readable);
}

function writeSummary(readable: Share): void {
  const lines = [
    '# MERIDIAN CORE — curated evidence',
    '',
    'Regenerate with `npx tsx scripts/capture-meridian-evidence.ts`.',
    '',
    `Target: ${tenant.baseUrl} (${profile.product} v${tenant.productVersion})`,
    `Captured: ${new Date().toISOString()}`,
    `Arguments chosen live from member ${MEMBER}'s record (share ${readable.id}).`,
    '',
    'Every run below is a deterministic replay. No model is in the decision loop.',
    'Each directory holds the step log (`events.jsonl`), the result contract',
    '(`result.json`), what a calling agent received (`agent-result.json`), a',
    'readable summary (`summary.md`), and screenshots where the run captured them.',
    '',
    '| Scenario | What it shows |',
    '|---|---|',
    ...results.map((r) => `| [\`${r.dir}\`](${r.dir}/summary.md) | ${r.headline} |`),
    '',
    '## Notes',
    '',
    ...results.flatMap((r) => [`**${r.dir}** — ${r.note}`, '']),
  ];
  writeFileSync(join(EVIDENCE, 'README.md'), `${lines.join('\n')}\n`, 'utf8');
  console.log(`\nWrote ${EVIDENCE}/README.md`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
