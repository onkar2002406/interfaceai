/**
 * Where a goal-driven run starts.
 *
 * The brief asks the agent loop to accept `(goal, target_url)`. The loop already
 * took an `entryUrl` — what was missing was any way for a caller to *say* one;
 * it was always derived from the tenant profile's base URL.
 *
 * The reason this is a module rather than two lines inlined at each call site is
 * the validation. A caller-supplied target URL is, structurally, a request to
 * point the automation somewhere new — which is precisely what the containment
 * boundary exists to refuse. If `--url` or a JSON body field could move the run
 * off the allowlist, the allowlist would be advisory. So every entry point
 * resolves through here, and the check is the same `Policy.isUrlAllowed` the
 * surface enforces on every navigation, not a second opinion about it.
 *
 * Note the asymmetry with the tenant default: the derived URL is validated too.
 * A profile whose base URL is not on its own policy's origin list is a
 * misconfiguration, and finding that out here — before a browser launches — is
 * considerably cheaper than finding it out as a blocked navigation three
 * seconds in.
 */

import type { Policy } from '../policy/guardrails.js';
import type { TenantProfile } from '../capability/application-profile.js';

export class EntryUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntryUrlError';
  }
}

/**
 * Resolves the URL a discovery run should open, refusing anything off-policy.
 *
 * @param requested a caller-supplied target URL, or undefined to use the tenant's.
 */
export function resolveEntryUrl(
  policy: Policy,
  tenant: TenantProfile,
  requested?: string | undefined,
): string {
  const raw = (requested ?? '').trim();

  if (!raw) {
    const derived = new URL('/', tenant.baseUrl).toString();
    const check = policy.isUrlAllowed(derived);
    if (!check.ok) {
      throw new EntryUrlError(
        `tenant "${tenant.id}" has base URL ${tenant.baseUrl}, which this product's policy refuses: ` +
          `${check.reason}. The profile and its policy disagree — fix one of them.`,
      );
    }
    return derived;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new EntryUrlError(
      `"${raw}" is not a valid absolute URL. Supply a full target URL including the scheme, ` +
        `e.g. ${new URL('/', tenant.baseUrl).toString()}`,
    );
  }

  const check = policy.isUrlAllowed(parsed.toString());
  if (!check.ok) {
    throw new EntryUrlError(
      `target URL ${parsed.toString()} is refused by policy: ${check.reason}. ` +
        `Allowed origins: ${policy.config.origins.join(', ')}. ` +
        `Pointing the agent at a new target is a policy change, not a flag — ` +
        `add the origin to the product's policy file if it belongs there.`,
    );
  }

  return parsed.toString();
}
