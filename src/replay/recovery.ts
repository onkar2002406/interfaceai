/**
 * Recovery handlers — the bounded, closed set of things replay may do to fix
 * itself without a human and without a model.
 *
 * "Closed set" is the design decision. The obvious alternative is a scripting
 * hook: let a capability declare arbitrary recovery steps. That fails two tests
 * this system has to pass — a reviewer approving a capability could no longer
 * tell what it might do, and it would become the natural place for an LLM to
 * smuggle unreviewed behaviour into the supposedly deterministic path.
 *
 * So there are four handlers, each does one obvious thing, each is bounded by
 * `maxAttempts` and by a global recovery budget, and every attempt is recorded.
 * If a condition needs something outside this set, that is a signal it should be
 * escalating to a human, not quietly improvising.
 *
 * Credentials for `reauthenticate` are read from the environment at the moment
 * they are needed and are never logged, never persisted, and never placed in an
 * artifact — the app profile names the env vars, not the values.
 */

import type { RecoveryAction } from '../capability/schema.js';
import type { AppProfile, TenantProfile } from '../capability/app-profile.js';
import type { Surface } from '../surface/types.js';
import type { ControlToken } from '../escalation/control.js';
import { evaluateCheckpoint } from './predicates.js';

export interface RecoveryContext {
  surface: Surface;
  token: () => ControlToken;
  profile: AppProfile;
  tenant: TenantProfile;
  /** Where the run was when the condition fired, so we can come back to it. */
  returnUrl: string;
}

export interface RecoveryResult {
  ok: boolean;
  note: string;
  /**
   * The recovery succeeded, but the flow's position was lost and cannot be
   * reconstructed — the caller must restart the capability from step one rather
   * than continue where it left off. See `reauthenticate` for why.
   */
  restartFlow?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Establishes an authenticated session if there isn't one.
 *
 * Shared by discovery and replay, and that sharing is the point: sign-on is the
 * runtime's job in both, so neither a recorded capability nor a model transcript
 * ever contains credentials or a sequence of sign-on steps. A capability says
 * "I need an authenticated session"; who that session belongs to is decided at
 * invocation time, which is also what lets the same flow run under different
 * operator identities with different entitlements.
 */
export async function ensureAuthenticated(ctx: RecoveryContext): Promise<RecoveryResult> {
  const obs = await ctx.surface.observe();
  const signedIn = evaluateCheckpoint(ctx.profile.auth.successCheckpoint, obs);
  if (signedIn.ok) return { ok: true, note: 'an authenticated session was already established' };

  const res = await reauthenticate(ctx);
  // `restartFlow` is meaningful when a session is lost mid-flow. On a cold start
  // there is no position to lose, so don't report one.
  if (!res.ok) return res;
  return { ok: true, note: 'signed on and returned to the entry point' };
}

export async function runRecovery(action: RecoveryAction, ctx: RecoveryContext): Promise<RecoveryResult> {
  switch (action.handler) {
    case 'wait_retry':
      await sleep(action.waitMs);
      return { ok: true, note: `waited ${action.waitMs}ms for the surface to settle` };

    case 'dismiss_dialog': {
      const res = await ctx.surface.act(
        { type: 'click', target: { kind: 'descriptor', descriptor: action.dismissTarget } },
        ctx.token(),
      );
      return res.ok
        ? { ok: true, note: `dismissed via "${action.dismissTarget.name ?? action.dismissTarget.description}"` }
        : { ok: false, note: `could not dismiss: ${res.error?.message ?? 'unknown'}` };
    }

    case 'navigate_back': {
      const res = await ctx.surface.act({ type: 'navigate', url: ctx.returnUrl }, ctx.token());
      return res.ok
        ? { ok: true, note: `returned to ${ctx.returnUrl}` }
        : { ok: false, note: `could not navigate back: ${res.error?.message ?? 'unknown'}` };
    }

    case 'reauthenticate':
      return reauthenticate(ctx);
  }
}

async function reauthenticate(ctx: RecoveryContext): Promise<RecoveryResult> {
  const { auth } = ctx.profile;
  const user = process.env[auth.credentialEnv.user];
  const password = process.env[auth.credentialEnv.password];

  if (!user || !password) {
    return {
      ok: false,
      note:
        `cannot re-authenticate: ${auth.credentialEnv.user} / ${auth.credentialEnv.password} are not set ` +
        `in the environment (credentials are never stored in the profile or the artifact)`,
    };
  }

  const loginUrl = new URL(auth.loginPath, ctx.tenant.baseUrl).toString();
  const nav = await ctx.surface.act({ type: 'navigate', url: loginUrl }, ctx.token());
  if (!nav.ok) return { ok: false, note: `could not reach sign-on: ${nav.error?.message}` };

  const steps: Array<[string, Awaited<ReturnType<Surface['act']>>]> = [];
  steps.push([
    'operator',
    await ctx.surface.act(
      { type: 'type', target: { kind: 'descriptor', descriptor: auth.operatorField }, value: user },
      ctx.token(),
    ),
  ]);
  steps.push([
    'password',
    await ctx.surface.act(
      { type: 'type', target: { kind: 'descriptor', descriptor: auth.passwordField }, value: password },
      ctx.token(),
    ),
  ]);
  steps.push([
    'submit',
    await ctx.surface.act(
      { type: 'click', target: { kind: 'descriptor', descriptor: auth.submitTarget } },
      ctx.token(),
    ),
  ]);

  for (const [what, res] of steps) {
    // NB: never include the value — only which field failed.
    if (!res.ok) return { ok: false, note: `sign-on failed at the ${what} field: ${res.error?.message}` };
  }

  const obs = await ctx.surface.observe();
  const cp = evaluateCheckpoint(auth.successCheckpoint, obs);
  if (!cp.ok) {
    return {
      ok: false,
      note: `re-authenticated but the sign-on screen is still displayed (${cp.failed.map((f) => f.observed).join('; ')})`,
    };
  }

  const back = await ctx.surface.act({ type: 'navigate', url: ctx.returnUrl }, ctx.token());
  if (!back.ok) {
    return { ok: false, note: `re-authenticated but could not return to ${ctx.returnUrl}: ${back.error?.message}` };
  }

  // Signing in again gets us a session, but NOT our place in the flow.
  //
  // A new session starts at the application's landing page. Any state the flow
  // had built up — a search executed, a form half filled — is gone with the old
  // session, and in a frameset app we cannot even reliably record where we were,
  // because the address bar never left the shell.
  //
  // Quietly continuing from the next step would then run that step against the
  // wrong screen. So we tell the caller the position is lost and let it decide:
  // it restarts read-only flows from the beginning, and escalates to a human if
  // anything irreversible has already been committed — because replaying a
  // partially-completed mutating flow is how you open the same account twice.
  return {
    ok: true,
    restartFlow: true,
    note: `re-authenticated as a new session; flow position was lost and must be re-established from the entry point`,
  };
}
