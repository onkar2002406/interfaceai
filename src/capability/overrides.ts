/**
 * Per-tenant specialisation of a capability.
 *
 * The problem this solves: hundreds of institutions run the same vendor
 * product, and a capability recorded against one of them mostly works on the
 * others — but not entirely. First Valley renamed "Member Search" to "Find
 * Member". Harbor added a compliance interstitial and upgraded to a build that
 * reorders a table's columns.
 *
 * The tempting answer is to re-record per tenant. That gives you N copies that
 * drift independently, N places to fix a bug, and no way to see how tenant 47
 * differs from the reference install.
 *
 * So instead: one base spec, plus a list of JSON-Pointer patches per tenant.
 * The *difference* becomes the reviewable unit. You can read exactly what First
 * Valley overrides and why, in about four lines, and nothing else is duplicated.
 *
 * Most tenants need no patches at all, because the locator model already
 * tolerates re-skinning, re-branding and column reordering. Overrides are for
 * genuine relabels and genuine flow differences — and the drift signal emitted
 * during replay is what tells you when a tenant has earned one.
 */

import type { Capability, CapabilitySpec } from './schema.js';
import { CapabilitySchema } from './schema.js';

export class OverrideError extends Error {}

/** RFC 6901 pointer segment unescaping. */
function unescapeSegment(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function getByPointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  if (!pointer.startsWith('/')) throw new OverrideError(`JSON Pointer must start with "/": ${pointer}`);
  let cur: unknown = root;
  for (const rawSeg of pointer.slice(1).split('/')) {
    const seg = unescapeSegment(rawSeg);
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i)) throw new OverrideError(`"${seg}" is not an array index in ${pointer}`);
      cur = cur[i];
    } else if (cur && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Sets a value at a pointer. Refuses to create missing intermediate nodes:
 * an override whose path doesn't exist in the base spec is far more likely to
 * be a stale patch than an intentional addition, and silently growing a new
 * branch would hide that.
 */
export function setByPointer(root: unknown, pointer: string, value: unknown): void {
  if (!pointer.startsWith('/')) throw new OverrideError(`JSON Pointer must start with "/": ${pointer}`);
  const segs = pointer.slice(1).split('/').map(unescapeSegment);
  const last = segs.pop();
  if (last === undefined) throw new OverrideError(`empty JSON Pointer`);

  let cur: unknown = root;
  for (const seg of segs) {
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) {
        throw new OverrideError(`override path ${pointer} does not exist in the base spec (at "${seg}")`);
      }
      cur = cur[i];
    } else if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      throw new OverrideError(`override path ${pointer} does not exist in the base spec (at "${seg}")`);
    }
  }

  if (Array.isArray(cur)) {
    const i = Number(last);
    if (!Number.isInteger(i) || i < 0 || i >= cur.length) {
      throw new OverrideError(`override path ${pointer} is out of range`);
    }
    cur[i] = value;
  } else if (cur && typeof cur === 'object') {
    (cur as Record<string, unknown>)[last] = value;
  } else {
    throw new OverrideError(`override path ${pointer} does not address a settable location`);
  }
}

export interface ResolvedCapability {
  capability: Capability;
  /** Which tenant's overrides were applied, and what they changed. */
  appliedOverrides: Array<{ tenant: string; path: string; why: string }>;
}

/**
 * Produces the spec that will actually run for a given tenant.
 *
 * Resolution order is base -> tenant patches. A product-version overlay would
 * slot in between; it is not implemented because the two versions in play here
 * differ only in ways the locator model already absorbs, and building the layer
 * without a case that needs it would be speculative.
 */
export function resolveForTenant(capability: Capability, tenantId: string): ResolvedCapability {
  const override = capability.overrides[tenantId];
  if (!override) return { capability, appliedOverrides: [] };

  // Deep clone so the stored artifact is never mutated by a replay.
  const clone = structuredClone(capability) as Capability;
  const applied: ResolvedCapability['appliedOverrides'] = [];

  for (const patch of override.patches) {
    setByPointer(clone.spec as unknown as CapabilitySpec, patch.path, patch.value);
    applied.push({ tenant: tenantId, path: patch.path, why: patch.why });
  }

  // Re-validate: an override must not be able to produce a spec that would have
  // been rejected had it been written by hand.
  const revalidated = CapabilitySchema.parse(clone);
  return { capability: revalidated, appliedOverrides: applied };
}
