/**
 * Typed access to the panel's HTTP surface.
 *
 * Every route here already existed and is already exercised by the CLI, the
 * agent-facing API or the legacy page. The React app is a *third* consumer of
 * the same endpoints, not a reason to add endpoints — if a pane needs something
 * the API cannot express, the fix is upstream, because a front end that computes
 * its own version of a result is how two answers to the same question appear.
 *
 * The types below are hand-written mirrors of what the server sends. They are
 * documentation with teeth rather than a contract: the server is the authority,
 * and anything derived from a capability artifact (input schemas, business
 * outcomes, the irreversibility flag) is deliberately left as loose JSON Schema
 * and rendered generically, so a new capability needs no front-end change.
 */

export interface JsonSchema {
  type?: string;
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
}

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  pattern?: string;
  examples?: unknown[];
}

export interface CapabilityCard {
  name: string;
  version: string;
  title: string;
  summary: string;
  approval: 'draft' | 'approved';
  hasIrreversibleStep: boolean;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  businessOutcomes: Array<{ code: string; meaning: string }>;
}

export interface Tenant {
  id: string;
  label: string;
  baseUrl: string;
  productVersion: string;
  credentialEnv: { user: string; password: string };
  extraConditions: string[];
}

export interface Identity {
  id: string;
  credentialEnv: { user: string; password: string };
}

export interface Catalog {
  capabilities: CapabilityCard[];
  tenants: Tenant[];
  product: string;
  defaultTenant: string;
  identities: Identity[];
  faults: string[];
  /**
   * Front-door copy for the product this panel is pointed at. Two panels share
   * this bundle, so the openers cannot be a constant in the Chat pane — they
   * are a property of the console and its users, and come from the profile.
   */
  chat?: { audience?: string; suggestions: string[] };
  operatorUrl: string;
  provider: { name: string; live: boolean; describe: string };
  error: string | null;
}

export interface RunEvent {
  at: string;
  seq: number;
  kind: string;
  detail: Record<string, unknown>;
}

/** The four arms of the result contract, as the panel receives them. */
export interface ReplayResult {
  status: 'success' | 'business_outcome' | 'escalated' | 'failed';
  capability?: string;
  outputs?: Record<string, unknown>;
  code?: string;
  message?: string;
  reason?: string;
  resolution?: string;
  interventionId?: string;
  atStep?: string;
  operatorNote?: string;
  error?: { class?: string; message?: string; step?: string; expected?: string; observed?: string; screenshot?: string };
  driftSignals?: unknown[];
  durationMs?: number;
  evidenceDir?: string;
}

export interface RunSummary {
  id: string;
  kind: 'replay' | 'discovery';
  capability: string;
  goal: string | null;
  tenant: string;
  identity: string | null;
  fault: string | null;
  viaChat: boolean;
  startedAt: string;
  state: 'running' | 'done' | 'error';
  status: string | null;
  code: string | null;
  evidenceDir: string;
}

export interface InterventionRequest {
  id: string;
  capability: { name: string; version: string; title: string };
  tenant: string;
  atStep: { id: string; intent: string; index: number; total: number };
  reasonClass: string;
  reason: string;
  params: Record<string, unknown>;
  screenshotPath?: string;
  observedText?: string;
  resumeContract: { describe: string };
}

export interface EvidenceRun {
  dir: string;
  curated: boolean;
  status: string;
  capability?: string | null;
  tenant?: string | null;
  code?: string | null;
  startedAt?: string | null;
  durationMs?: number | null;
  files?: string[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly problems?: string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // A non-JSON body from an API route almost always means the route is not
    // there — an older panel process, or a typo. Say that rather than throwing
    // a parse error the reader has to decode.
    throw new ApiError(
      res.status === 404
        ? `no such route: ${path}. This panel process may predate it — restart it.`
        : `unexpected non-JSON response from ${path} (${res.status})`,
      res.status,
    );
  }
  if (!res.ok) {
    const b = body as { error?: string; problems?: string[] };
    throw new ApiError(b.error ?? `request failed (${res.status})`, res.status, b.problems);
  }
  return body as T;
}

const postJson = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const api = {
  catalog: () => request<Catalog>('/api/catalog'),
  health: () =>
    request<{ tenants: Array<{ id: string; label: string; baseUrl: string; up: boolean }>; allUp: boolean; selfHosted: boolean }>(
      '/api/health',
    ),
  policy: () => request<Record<string, unknown>>('/api/policy'),
  tools: () => request<{ tools: Array<{ name: string; description: string; parameters: unknown }> }>('/api/tools'),

  runs: () => request<{ runs: RunSummary[] }>('/api/runs'),
  run: (id: string) =>
    request<{
      id: string;
      kind: string;
      state: string;
      events: RunEvent[];
      result: ReplayResult | null;
      discovered: unknown;
      crash: string | null;
      evidenceDir: string;
    }>(`/api/runs/${id}`),

  evidence: () => request<{ runs: EvidenceRun[] }>('/api/evidence'),
  evidenceFileUrl: (path: string) => `/api/evidence-file?path=${encodeURIComponent(path)}`,

  approve: (name: string, approved: boolean) =>
    postJson<{ card: CapabilityCard }>(`/api/capabilities/${encodeURIComponent(name)}/approve`, { approved }),

  replay: (body: {
    capability: string;
    tenant?: string;
    identity?: string;
    params: Record<string, string>;
    authorizeIrreversible?: boolean;
    fault?: string;
  }) => postJson<{ runId: string; evidenceDir: string }>('/api/replay', body),

  discover: (body: {
    goal: string;
    tenant?: string;
    params?: Record<string, string>;
    targetUrl?: string;
    maxSteps?: number;
    name?: string;
  }) => postJson<{ runId: string; evidenceDir: string; provider: string; targetUrl: string }>('/api/discover', body),

  /* ------------------------------------------------------- interventions */

  interventions: () =>
    request<{ open: InterventionRequest[]; resolved: Array<{ id: string; resolution: string }>; operatorUrl: string }>(
      '/api/interventions',
    ),
  intervention: (id: string) =>
    request<{ request: InterventionRequest; state: string; operator: string | null; actions: unknown[] }>(
      `/api/interventions/${id}`,
    ),
  claim: (id: string, operator: string) => postJson<{ ok: true }>(`/api/interventions/${id}/claim`, { operator }),
  handBack: (id: string, note: string) => postJson<{ ok: true }>(`/api/interventions/${id}/handback`, { note }),
  abandon: (id: string, reason: string) => postJson<{ ok: true }>(`/api/interventions/${id}/abandon`, { reason }),
};
