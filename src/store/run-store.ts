/**
 * Durable state for the things that were previously only in RAM.
 *
 * Three stores lived in module-level `Map`s and `Array`s, and all three lost
 * everything on restart: the run registry, the escalation queue, and the audit
 * trail of explicit irreversible authorisations. The last of those is the one
 * that mattered — a regulator-facing record that disappears when a process
 * recycles is not a record.
 *
 * **What this can and cannot do, stated plainly.** It persists the *durable
 * projection* of each store, not the live objects. A `PanelRun` holds open SSE
 * `Response` handles and a set of in-process listeners; a parked intervention
 * holds the promise resolver that a blocked replay is waiting on. Neither is
 * serialisable, and neither would be meaningful in another process — the
 * browser session a parked run is holding died with the process that launched
 * it. So a restart recovers the *history and the audit*, and does not resume a
 * parked session. Claiming otherwise would be the kind of durability that reads
 * well and fails in production.
 *
 * The interface exists rather than calling Mongo directly because the repo has
 * to keep working with no database at all: `npm install && npm run panel` is
 * the first thing anyone does, and requiring a running MongoDB to see the panel
 * would be a bad trade for a property most demos never need.
 */

export type RunState = 'running' | 'done' | 'failed';

/** The serialisable projection of a panel run. */
export interface StoredRun {
  id: string;
  kind: 'replay' | 'discovery';
  capability: string;
  goal?: string;
  tenant?: string;
  identity?: string;
  fault?: string;
  viaChat?: boolean;
  params?: Record<string, string>;
  startedAt: string;
  finishedAt?: string;
  state: RunState;
  evidenceDir: string;
  /** The four-arm contract for a replay, or the discovery outcome. */
  result?: unknown;
  crash?: string;
}

/** The serialisable projection of an escalation, including how it ended. */
export interface StoredIntervention {
  id: string;
  runId?: string;
  capability: string;
  tenant?: string;
  reasonClass: string;
  reason: string;
  atStep?: string;
  raisedAt: string;
  resolvedAt?: string;
  resolution?: string;
  operator?: string;
  note?: string;
  humanActions?: number;
}

/** An explicit authorisation of an irreversible action, via the API header. */
export interface StoredAuthorization {
  capability: string;
  tenant: string;
  identity: string | null;
  at: string;
  runId?: string;
}

export interface RunStore {
  readonly backend: 'mongodb' | 'memory';
  saveRun(run: StoredRun): Promise<void>;
  listRuns(limit?: number): Promise<StoredRun[]>;
  saveIntervention(i: StoredIntervention): Promise<void>;
  listInterventions(limit?: number): Promise<StoredIntervention[]>;
  recordAuthorization(a: StoredAuthorization): Promise<void>;
  listAuthorizations(limit?: number): Promise<StoredAuthorization[]>;
  close(): Promise<void>;
}

/**
 * The default: keeps the current behaviour exactly.
 *
 * Not a null object that silently drops writes — it keeps them in memory, so
 * `listRuns()` answers correctly within a process and only a restart loses
 * anything. That is precisely the behaviour the panel had before, which makes
 * "no MONGODB_URI" a genuine no-op rather than a regression.
 */
export class MemoryRunStore implements RunStore {
  readonly backend = 'memory' as const;
  private readonly runs = new Map<string, StoredRun>();
  private readonly interventions = new Map<string, StoredIntervention>();
  private readonly authorizations: StoredAuthorization[] = [];

  async saveRun(run: StoredRun): Promise<void> {
    this.runs.set(run.id, run);
  }

  async listRuns(limit = 100): Promise<StoredRun[]> {
    return newestFirst([...this.runs.values()], (r) => r.startedAt).slice(0, limit);
  }

  async saveIntervention(i: StoredIntervention): Promise<void> {
    this.interventions.set(i.id, i);
  }

  async listInterventions(limit = 100): Promise<StoredIntervention[]> {
    return newestFirst([...this.interventions.values()], (i) => i.raisedAt).slice(0, limit);
  }

  async recordAuthorization(a: StoredAuthorization): Promise<void> {
    this.authorizations.push(a);
  }

  async listAuthorizations(limit = 100): Promise<StoredAuthorization[]> {
    return newestFirst([...this.authorizations], (a) => a.at).slice(0, limit);
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

export function newestFirst<T>(items: T[], at: (t: T) => string): T[] {
  return items.sort((a, b) => at(b).localeCompare(at(a)));
}
