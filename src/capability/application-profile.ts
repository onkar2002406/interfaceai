/**
 * App profile — everything true about a *vendor product* rather than about one
 * recorded flow.
 *
 * This exists because of a reuse problem. Session expiry looks identical on
 * every screen of CoreBank. So does the app-error page, and the maintenance
 * overlay. If each recording had to rediscover them, you would end up with
 * twenty capabilities that each handle timeouts slightly differently, and fixing
 * the handling would mean re-recording twenty flows.
 *
 * So the taxonomy is authored once per product and inherited by every capability
 * for that product. A capability may add *local* conditions (a validation error
 * specific to its form); it never has to restate the global ones.
 *
 * This is also the multi-tenant seam. Tenants of the same product share the
 * profile and differ only in their entry in `tenants` — base URL, product
 * version, and any per-tenant condition additions. Adding the 300th institution
 * running CoreBank is a config entry, not an engineering project.
 *
 * Credentials are deliberately NOT in here. The profile says *which fields* to
 * fill to re-authenticate; the values come from the environment at runtime and
 * are never written to disk.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ElementDescriptorSchema } from '../surface/element-descriptor.js';
import { CheckpointSchema, ConditionSchema } from './schema.js';

/** Names of the env vars holding a set of credentials. Never the values. */
const CredentialEnvSchema = z.object({ user: z.string(), password: z.string() });
export type CredentialEnv = z.infer<typeof CredentialEnvSchema>;

export const TenantSchema = z.object({
  id: z.string(),
  label: z.string(),
  baseUrl: z.string().url(),
  productVersion: z.string(),
  /** Conditions this tenant adds on top of the product-wide set. */
  extraConditions: z.array(ConditionSchema).default([]),
  /**
   * Where THIS institution's operator credentials live, when it has its own.
   * Each tenant runs its own directory, so an operator valid at one install is
   * rejected at the next. Still only variable *names* — the profile is
   * committed to the repo and must never carry a value.
   */
  credentialEnv: CredentialEnvSchema.optional(),
});
export type TenantProfile = z.infer<typeof TenantSchema>;

/**
 * How the harness makes a product produce a runtime fault on demand.
 *
 * Declared per product because it is a property of the vendor's build, and it is
 * the one thing about a target that the *automation itself* must never be able
 * to reach — a system that can arm its own faults cannot be trusted to report
 * them. Every strategy here is driven from outside the agent loop, and the
 * routes each fault attaches to are named rather than left to chance: an
 * untargeted session fault fires on whichever request arrives first, which
 * tests "sign-on is broken" instead of "the session expired mid-flow".
 */
export const FaultConfigSchema = z.discriminatedUnion('strategy', [
  /**
   * The product exposes an admin endpoint that arms a fault for the next N
   * matching requests. Used by the bundled CoreBank app.
   */
  z.object({
    strategy: z.literal('admin_endpoint'),
    path: z.string().default('/_admin/fault'),
    routes: z.record(z.string(), z.string()).default({}),
  }),
  /**
   * The product honours a query parameter on any request. The harness rewrites
   * one in-flight request from inside the browser session the run already owns,
   * which keeps the fault session-scoped (it cannot disturb anyone else on a
   * shared install), one-shot (nothing is left armed if a run crashes), and
   * precisely placed (it can fire on a mid-flow `post` rather than only on the
   * entry navigation).
   */
  z.object({
    strategy: z.literal('request_inject'),
    param: z.string().default('inject'),
    routes: z.record(z.string(), z.string()).default({}),
  }),
]);
export type FaultConfig = z.infer<typeof FaultConfigSchema>;

/**
 * What the chat front door says about *this* product before anyone types.
 *
 * The openers used to be a constant in the React pane, which was fine while
 * there was one panel and wrong the moment there were two: a CoreBank operator
 * was offered MERIDIAN share ids that do not exist on their console, so the
 * first thing the demo did was ask a model to invent an identifier.
 *
 * They belong here rather than being derived from the capability list because a
 * good opener is not "the name of a capability" — it is a sentence a member of
 * *this* institution's staff would actually say, carrying identifiers that exist
 * in *this* product's data. That is knowledge about the customer base, which is
 * exactly what a product profile is for. The set is deliberately chosen to walk
 * the four arms of the result contract, so whichever panel you open, the first
 * four clicks show success, a business outcome, an entitlement refusal and an
 * irreversible action stopping for a human.
 */
export const ChatProfileSchema = z
  .object({
    /** Who uses this console and what they ask it for. Goes into the system prompt. */
    audience: z.string().optional(),
    /** Openers offered on an empty transcript. Empty is legal — the pane just shows none. */
    suggestions: z.array(z.string()).default([]),
  })
  .default({ suggestions: [] });
export type ChatProfile = z.infer<typeof ChatProfileSchema>;

export const AppProfileSchema = z.object({
  product: z.string(),
  description: z.string(),

  /** Front-door copy for this product: who the caller is, and what to offer them. */
  chat: ChatProfileSchema,

  /**
   * The guardrails this product is replayed under, as a path to a policy file.
   *
   * Origins, route allowlist and risk rules are all statements about a specific
   * product, so they travel with it. Naming the policy here is what makes
   * `--profile <app>.yaml` the single switch for pointing the engine at a
   * different target, instead of two flags that can be forgotten independently
   * — and forgetting the policy flag would silently run the new target under
   * the old target's containment boundary.
   */
  policy: z.string().optional(),

  /**
   * Product-wide runtime conditions, evaluated after EVERY step of EVERY
   * capability for this product. Ordering matters and is preserved: business
   * outcomes are declared before recoverable ones before fatal ones, and the
   * classifier takes the first match.
   */
  conditions: z.array(ConditionSchema),

  /** How the harness arms this product's runtime faults, if it can at all. */
  faults: FaultConfigSchema.optional(),

  /** Used by the `reauthenticate` recovery handler. Field targets only. */
  auth: z.object({
    loginPath: z.string(),
    operatorField: ElementDescriptorSchema,
    passwordField: ElementDescriptorSchema,
    submitTarget: ElementDescriptorSchema,
    successCheckpoint: CheckpointSchema,
    /** Product-wide default. A tenant may point at its own pair instead. */
    credentialEnv: CredentialEnvSchema,
  }),

  /**
   * Named operator identities — WHO is signed on, as distinct from WHICH
   * install is being driven.
   *
   * These are different questions and conflating them was tempting, because
   * `credentialEnv` already hangs off the tenant. But a tenant is an
   * institution with its own base URL and its own staff directory, whereas a
   * teller and a supervisor at the same institution share both and differ only
   * in entitlement. Products that gate a function on the operator's role — a
   * supervisor-only account hold, say — need the *same capability* runnable
   * under either identity, returning a legitimately different answer in each
   * case. Modelling that as two tenants would say "institution" where it means
   * "operator", and would make the run report lie about where the work happened.
   *
   * Names only, as everywhere else in this file.
   */
  identities: z.record(z.string(), CredentialEnvSchema).default({}),

  tenants: z.array(TenantSchema),
});
export type AppProfile = z.infer<typeof AppProfileSchema>;

export function loadAppProfile(path: string): AppProfile {
  return AppProfileSchema.parse(parseYaml(readFileSync(path, 'utf8')));
}

export function tenantOf(profile: AppProfile, tenantId: string): TenantProfile {
  const t = profile.tenants.find((x) => x.id === tenantId);
  if (!t) {
    throw new Error(
      `Tenant "${tenantId}" is not configured for product "${profile.product}". ` +
        `Known tenants: ${profile.tenants.map((x) => x.id).join(', ')}`,
    );
  }
  return t;
}

/**
 * Which credentials this run signs on with.
 *
 * Specialisation runs most-specific-first, the same rule as conditions:
 *
 *   identity (who the caller asked to act as)
 *     -> tenant (this institution's own staff directory)
 *       -> product default
 *
 * That ordering is what keeps a capability portable. The artifact never names an
 * operator; it declares that it needs an authenticated session, and the runtime
 * decides whose. The same recorded steps therefore replay as a teller and as a
 * supervisor, and any difference in the result is the application's answer about
 * entitlement rather than a difference in the recording.
 */
export function credentialEnvFor(
  profile: AppProfile,
  tenant: TenantProfile,
  identity?: string,
): CredentialEnv {
  if (identity !== undefined) {
    const named = profile.identities[identity];
    if (!named) {
      const known = Object.keys(profile.identities);
      throw new Error(
        `Identity "${identity}" is not configured for product "${profile.product}". ` +
          `Known identities: ${known.length ? known.join(', ') : '(none declared)'}.`,
      );
    }
    return named;
  }
  return tenant.credentialEnv ?? profile.auth.credentialEnv;
}

/**
 * Where this profile's guardrails live. Falls back to the shared default so a
 * profile that predates the `policy` field keeps working unchanged.
 */
export function policyPathFor(profile: AppProfile, fallback: string): string {
  return profile.policy ?? fallback;
}

/**
 * The full condition set in evaluation order for a given tenant:
 * step-local first (most specific), then tenant, then product-wide.
 */
export function conditionsFor(
  profile: AppProfile,
  tenant: TenantProfile,
  stepLocal: z.infer<typeof ConditionSchema>[],
): z.infer<typeof ConditionSchema>[] {
  return [...stepLocal, ...tenant.extraConditions, ...profile.conditions];
}
