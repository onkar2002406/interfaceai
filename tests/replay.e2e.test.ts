/**
 * End-to-end: a real browser, the real target application, the real replay
 * engine.
 *
 * The unit tests pin the pieces; this pins the thing the pieces are for. It
 * covers one case of each arm of the result contract, because a taxonomy that
 * has never been exercised is a guess:
 *
 *   success           — outputs extracted and typed
 *   business_outcome  — "no such member", returned as an answer
 *   business_outcome  — a restricted record, likewise
 *   failed            — an injected application error, diagnosed not timed out
 *   escalated         — an irreversible step with no authorisation
 *   recovered         — a surprise interstitial, cleared without a human
 *   cross-tenant      — the same artifact against a differently-configured install
 *
 * Slow by nature (each case drives a browser through a multi-step flow), so it
 * is generous with timeouts rather than flaky.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startCoreBank, stopCoreBank, type RunningInstance } from '../apps/corebank/start-servers.js';
import { loadAppProfile, tenantOf } from '../src/capability/application-profile.js';
import { CapabilityStore } from '../src/capability/store.js';
import { Policy } from '../src/policy/guardrails.js';
import { RunRecorder } from '../src/observability/run-recorder.js';
import { replay, validateInputs, CapabilityInputError } from '../src/replay/executor.js';
import type { ReplayResult } from '../src/replay/replay-result.js';

const CASE_TIMEOUT = 90_000;

const profile = loadAppProfile('config/apps/corebank-servicing.yaml');
const policy = Policy.fromFile('config/policy.json');
const store = new CapabilityStore('capabilities');
const lookup = store.load('lookup_member_savings_balance');
const openSubAccount = store.load('open_sub_account');

let started: RunningInstance[] = [];

/** Reuse an already-running app if there is one; otherwise start our own. */
async function ensureApp(): Promise<void> {
  try {
    const r = await fetch('http://localhost:4000/_admin/status', { signal: AbortSignal.timeout(1500) });
    if (r.ok) return;
  } catch {
    /* not running */
  }
  started = await startCoreBank();
}

async function armFault(baseUrl: string, mode: string, route?: string): Promise<void> {
  await fetch(`${baseUrl}/_admin/fault`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, times: 1, route }),
  });
}

async function run(
  capability = lookup,
  params: Record<string, string> = { memberId: '10001' },
  tenantId = 'base',
  authorizeIrreversible = false,
): Promise<ReplayResult> {
  const recorder = new RunRecorder(randomUUID().slice(0, 8), 'replay', 'evidence/_scratch', {
    consoleEcho: false,
  });
  return replay({ capability, params, tenantId, profile, policy, recorder, authorizeIrreversible });
}

beforeAll(async () => {
  await ensureApp();
  process.env.COREBANK_OPERATOR ??= 'svc.demo';
  process.env.COREBANK_PASSWORD ??= 'demo1234';
}, 60_000);

afterAll(async () => {
  if (started.length) await stopCoreBank(started);
});

describe('deterministic replay', () => {
  it(
    'completes a read-only flow and returns typed outputs',
    async () => {
      const r = await run();
      expect(r.status).toBe('success');
      if (r.status !== 'success') return;
      expect(r.outputs.savingsBalance).toBe(8412.55);
      expect(r.outputs.savingsAccountNumber).toBe('4820117735');
      // Money is a number, not a display string — the caller can compare it.
      expect(typeof r.outputs.savingsBalance).toBe('number');
      expect(r.steps.every((s) => s.status === 'ok')).toBe(true);
    },
    CASE_TIMEOUT,
  );

  it(
    'is deterministic: the same inputs produce the same outputs',
    async () => {
      const [a, b] = await Promise.all([run(), run()]);
      expect(a.status).toBe('success');
      expect(b.status).toBe('success');
      if (a.status === 'success' && b.status === 'success') expect(a.outputs).toEqual(b.outputs);
    },
    CASE_TIMEOUT * 2,
  );

  it(
    'rejects malformed inputs before launching a browser',
    () => {
      expect(() => validateInputs(lookup, { memberId: 'not-a-number' })).toThrow(CapabilityInputError);
      expect(() => validateInputs(lookup, {})).toThrow(CapabilityInputError);
      expect(() => validateInputs(lookup, { memberId: '10001', extra: 'x' })).toThrow(CapabilityInputError);
    },
  );
});

describe('business outcomes are answers, not failures', () => {
  it(
    'reports MEMBER_NOT_FOUND for an identifier that does not exist',
    async () => {
      const r = await run(lookup, { memberId: '99999' });
      expect(r.status).toBe('business_outcome');
      if (r.status !== 'business_outcome') return;
      expect(r.code).toBe('MEMBER_NOT_FOUND');
      // Declared in the capability's contract, so a caller could plan for it.
      expect(lookup.spec.outcomes.business.map((b) => b.code)).toContain('MEMBER_NOT_FOUND');
    },
    CASE_TIMEOUT,
  );

  it(
    'reports PERMISSION_DENIED for a restricted record',
    async () => {
      const r = await run(lookup, { memberId: '10007' });
      expect(r.status).toBe('business_outcome');
      if (r.status === 'business_outcome') expect(r.code).toBe('PERMISSION_DENIED');
    },
    CASE_TIMEOUT,
  );
});

describe('runtime conditions', () => {
  it(
    'diagnoses an application error rather than reporting a timeout',
    async () => {
      const t = tenantOf(profile, 'base');
      await armFault(t.baseUrl, 'app_error', '/member/*');
      const r = await run();
      expect(r.status).toBe('failed');
      if (r.status !== 'failed') return;
      // The valuable part: `surface_error`, not `checkpoint_failed`. The
      // detector explained the silence before the deadline could.
      expect(r.error.class).toBe('surface_error');
      expect(r.error.observed).toMatch(/Unexpected System Error/i);
      expect(r.error.stepId).toBe('s3');
      expect(r.error.stepIntent).toBeTruthy();
    },
    CASE_TIMEOUT,
  );

  it(
    'clears an unexpected interstitial without a human and carries on',
    async () => {
      const t = tenantOf(profile, 'base');
      await armFault(t.baseUrl, 'interstitial', '/search');
      const r = await run();
      expect(r.status).toBe('success');
      const recoveries = r.steps.flatMap((s) => s.recoveries);
      expect(recoveries.some((x) => x.handler === 'dismiss_dialog' && x.ok)).toBe(true);
    },
    CASE_TIMEOUT,
  );

  it(
    'absorbs transient slowness through checkpoint polling, not a fixed sleep',
    async () => {
      const t = tenantOf(profile, 'base');
      await armFault(t.baseUrl, 'slow', '/member/*');
      const r = await run();
      expect(r.status).toBe('success');
    },
    CASE_TIMEOUT,
  );

  it(
    're-authenticates after a mid-flow session expiry and restarts the flow',
    async () => {
      const t = tenantOf(profile, 'base');
      await armFault(t.baseUrl, 'session', '/member/*');
      const r = await run();
      expect(r.status).toBe('success');
    },
    CASE_TIMEOUT,
  );
});

describe('safety', () => {
  it(
    'escalates rather than taking an irreversible action unauthorised',
    async () => {
      const r = await run(
        openSubAccount,
        { memberId: '10004', accountType: 'Savings', initialDeposit: '50.00', nickname: 'Test' },
        'base',
        false,
      );
      expect(r.status).toBe('escalated');
      if (r.status !== 'escalated') return;
      // Nothing was committed, and no operator console was attached.
      expect(r.resolution).toBe('unattended');
      expect(r.atStep).toBe('s9');
    },
    CASE_TIMEOUT,
  );

  it(
    'performs the irreversible step once the caller authorises it',
    async () => {
      const r = await run(
        openSubAccount,
        { memberId: '10004', accountType: 'Savings', initialDeposit: '75.00', nickname: 'Authorised' },
        'base',
        true,
      );
      expect(r.status).toBe('success');
      if (r.status === 'success') expect(String(r.outputs.newAccountNumber)).toMatch(/^48209\d+$/);
    },
    CASE_TIMEOUT,
  );

  it(
    'returns a validation refusal as a business outcome, having committed nothing',
    async () => {
      // $5 is below the institution's $25 minimum. The app refuses; that is an
      // answer the caller needs, not a malfunction.
      const r = await run(
        openSubAccount,
        { memberId: '10004', accountType: 'Savings', initialDeposit: '5.00', nickname: 'TooSmall' },
        'base',
        true,
      );
      expect(r.status).toBe('business_outcome');
      if (r.status === 'business_outcome') expect(r.code).toBe('VALIDATION_ERROR');
    },
    CASE_TIMEOUT,
  );
});

describe('cross-tenant reuse', () => {
  it(
    'replays on a relabelled install using overrides, and reports the residual drift',
    async () => {
      const r = await run(lookup, { memberId: '10001' }, 'firstvalley');
      expect(r.status).toBe('success');
      if (r.status !== 'success') return;
      expect(r.outputs.savingsBalance).toBe(8412.55);
      expect(r.appliedOverrides.length).toBeGreaterThan(0);
      // The unnamed member-id field is NOT overridden — it resolves structurally
      // and says so, which is the system reporting drift instead of hiding it.
      expect(r.driftSignals.length).toBeGreaterThan(0);
    },
    CASE_TIMEOUT,
  );

  it(
    'replays UNCHANGED on a newer install with reordered columns and an extra screen',
    async () => {
      const r = await run(lookup, { memberId: '10001' }, 'harborcu');
      expect(r.status).toBe('success');
      if (r.status !== 'success') return;
      // Same value despite the accounts table being ordered differently, because
      // the cell is addressed by column header and row, never by index.
      expect(r.outputs.savingsBalance).toBe(8412.55);
      expect(r.appliedOverrides).toHaveLength(0);
      // Harbor's mandatory privacy screen was handled by a tenant-level
      // condition that every capability inherits.
      const recoveries = r.steps.flatMap((s) => s.recoveries);
      expect(recoveries.some((x) => x.conditionId === 'privacy_acknowledgement')).toBe(true);
    },
    CASE_TIMEOUT,
  );
});
