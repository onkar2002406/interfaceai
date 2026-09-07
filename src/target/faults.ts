/**
 * Arming a runtime fault on the target — the harness's side of the error-path
 * demonstrations.
 *
 * This module exists because "how do I make this application misbehave on
 * purpose" turned out to be a genuinely per-product question, and the first
 * version of this system answered it in two places at once: an `armFault()`
 * copied between the CLI and the control panel, each hard-coding the bundled
 * CoreBank app's `POST /_admin/fault`. Pointing the engine at a second product
 * made that the only real duplication in the codebase, so it moves here and the
 * product profile says which mechanism its target speaks.
 *
 * Two strategies, and the difference between them is worth stating because it
 * is a genuine trade-off rather than an accident of two vendors:
 *
 *   `admin_endpoint` — the application exposes a control that arms a fault for
 *   the next N matching requests. Simple, but it is *global to the install*:
 *   fine for a local app you own, wrong for a shared one.
 *
 *   `request_inject` — the application honours a query parameter on any
 *   request, and the harness rewrites one request in flight from inside the
 *   browser session the run already owns. Session-scoped, one-shot, and it can
 *   be aimed at a specific mid-flow request. Strictly better where the target
 *   supports it, and the only responsible choice against a shared public demo
 *   instance that other people are using at the same time.
 *
 * What is common to both, and is the actual invariant: **the automation cannot
 * arm its own faults.** Both mechanisms are driven from outside the agent loop —
 * `admin_endpoint` over plain HTTP from the harness process, `request_inject`
 * from the network interceptor the agent never sees — and both targets keep
 * their fault console on the policy DENY list. A system that could arm the
 * errors it reports would not be evidence of anything.
 */

import type { AppProfile, TenantProfile } from '../capability/application-profile.js';
import type { SurfaceFault } from '../surface/web/playwright-surface.js';

/** What a caller has to do to make the requested fault happen. */
export type ArmedFault =
  /** Nothing to do up front; hand this to the surface when it launches. */
  | { via: 'surface'; fault: SurfaceFault }
  /** Call `arm()` before the run and `disarm()` after it, whatever happens. */
  | { via: 'endpoint'; arm: () => Promise<void>; disarm: () => Promise<void> };

export class FaultUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaultUnsupportedError';
  }
}

/**
 * Works out how to produce `kind` on this product, or explains why it cannot.
 *
 * Deliberately returns a plan rather than performing anything: the two
 * strategies happen at different moments in a run (one before the browser
 * launches, one as part of launching it), and a function that quietly did
 * nothing for one of them would be the kind of seam that looks fine until the
 * demo needs it.
 */
export function planFault(
  profile: AppProfile,
  tenant: TenantProfile,
  kind: string,
): ArmedFault {
  const config = profile.faults;
  if (!config) {
    throw new FaultUnsupportedError(
      `product "${profile.product}" does not declare a fault-injection mechanism, ` +
        `so runtime faults cannot be armed against it. Add a \`faults:\` block to its profile.`,
    );
  }

  const route = config.routes[kind];
  if (!route) {
    const known = Object.keys(config.routes);
    throw new FaultUnsupportedError(
      `"${kind}" is not a fault this product knows how to produce. ` +
        `Known faults: ${known.length ? known.join(', ') : '(none configured)'}.`,
    );
  }

  if (config.strategy === 'request_inject') {
    return {
      via: 'surface',
      fault: { kind, param: config.param, route, times: 1 },
    };
  }

  // admin_endpoint. Over plain HTTP from this process, never through the
  // browser surface — the admin path is on the policy deny list precisely so
  // the automation cannot reach its own test hooks.
  const endpoint = new URL(config.path, tenant.baseUrl).toString();
  const post = async (mode: string): Promise<void> => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, times: 1, route }),
    });
    if (!res.ok) {
      throw new Error(`could not arm fault "${mode}" on ${tenant.label}: ${res.status} ${await res.text()}`);
    }
  };

  return {
    via: 'endpoint',
    arm: () => post(kind),
    // Best-effort: a run that already failed should not also fail to report
    // itself because the cleanup call could not reach the app.
    disarm: () => post('none').catch(() => undefined),
  };
}

/** The faults this product can produce, for CLI help and the panel's dropdown. */
export function availableFaults(profile: AppProfile): string[] {
  return Object.keys(profile.faults?.routes ?? {});
}
