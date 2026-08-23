/**
 * Tenant configuration.
 *
 * Every tenant runs the SAME vendor product ("CoreBank Servicing Console"),
 * configured, branded and versioned differently — which is precisely the
 * situation described in the brief: hundreds of institutions, many on the same
 * underlying software.
 *
 * The differences here are the realistic kind:
 *   - relabelled controls ("Member Search" -> "Find Member")
 *   - an extra mandatory interstitial one institution's compliance team added
 *   - a different product version with a reordered results table
 *
 * A capability recorded against `base` should survive these, or degrade in a
 * way we can detect and specialise — never require a fresh recording.
 */

export interface TenantConfig {
  id: string;
  institutionName: string;
  productVersion: string;
  /** Brand colour, purely cosmetic — proves visual drift doesn't break replay. */
  accent: string;
  labels: {
    searchNavLink: string;
    memberIdField: string;
    searchButton: string;
    accountsHeading: string;
    openSubAccountLink: string;
  };
  /** Columns of the member accounts table, in display order. */
  accountColumns: Array<'number' | 'type' | 'balance' | 'status' | 'openedOn'>;
  /** Compliance interstitial shown once per session before the first member detail view. */
  privacyInterstitial: boolean;
}

export const TENANTS: Record<string, TenantConfig> = {
  base: {
    id: 'base',
    institutionName: 'CoreBank Reference Install',
    productVersion: '8.2',
    accent: '#003366',
    labels: {
      searchNavLink: 'Member Search',
      memberIdField: 'Member ID',
      searchButton: 'Search',
      accountsHeading: 'Accounts',
      openSubAccountLink: 'Open Sub-Account',
    },
    accountColumns: ['number', 'type', 'balance', 'status', 'openedOn'],
    privacyInterstitial: false,
  },

  // Tenant A: same product, same version, relabelled controls.
  // Exercises normalized-name + anchor fallbacks in the resolver.
  firstvalley: {
    id: 'firstvalley',
    institutionName: 'First Valley Credit Union',
    productVersion: '8.2',
    accent: '#7a1f2b',
    labels: {
      searchNavLink: 'Find Member',
      memberIdField: 'Member Number',
      searchButton: 'Go',
      accountsHeading: 'Share Accounts',
      openSubAccountLink: 'Open Sub-Account',
    },
    accountColumns: ['number', 'type', 'balance', 'status', 'openedOn'],
    privacyInterstitial: false,
  },

  // Tenant B: newer product version, reordered table, plus a compliance
  // interstitial. Exercises a tenant override that adds a recoverable condition.
  harborcu: {
    id: 'harborcu',
    institutionName: 'Harbor Credit Union',
    productVersion: '9.0',
    accent: '#0b5c4a',
    labels: {
      searchNavLink: 'Member Search',
      memberIdField: 'Member ID',
      searchButton: 'Search',
      accountsHeading: 'Accounts',
      openSubAccountLink: 'New Sub-Account',
    },
    accountColumns: ['type', 'number', 'balance', 'status', 'openedOn'],
    privacyInterstitial: true,
  },
};

export function getTenant(id: string | undefined): TenantConfig {
  const t = TENANTS[id ?? 'base'];
  if (!t) {
    throw new Error(`Unknown tenant "${id}". Known: ${Object.keys(TENANTS).join(', ')}`);
  }
  return t;
}
