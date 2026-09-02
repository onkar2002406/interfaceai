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

export const AppProfileSchema = z.object({
  product: z.string(),
  description: z.string(),

  /**
   * Product-wide runtime conditions, evaluated after EVERY step of EVERY
   * capability for this product. Ordering matters and is preserved: business
   * outcomes are declared before recoverable ones before fatal ones, and the
   * classifier takes the first match.
   */
  conditions: z.array(ConditionSchema),

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
 * Which credentials this tenant signs on with — its own if it declares a pair,
 * otherwise the product-wide default.
 *
 * The same specialisation rule as conditions: tenant overrides product. That is
 * what keeps a capability portable. The artifact never names an operator; it
 * declares that it needs a session, and the runtime decides whose.
 */
export function credentialEnvFor(profile: AppProfile, tenant: TenantProfile): CredentialEnv {
  return tenant.credentialEnv ?? profile.auth.credentialEnv;
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
