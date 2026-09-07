/**
 * The MongoDB-backed `RunStore`.
 *
 * Three collections, keyed on the ids the system already generates, so a
 * restart re-reads exactly what it wrote:
 *
 *   - `runs`                        run registry and history
 *   - `interventions`               escalations and how each was resolved
 *   - `irreversible_authorizations` append-only audit of explicit approvals
 *
 * Two things deliberately do NOT move here, and saying which is part of the
 * design rather than an omission:
 *
 *   - **`capabilities/*.yaml` stays in git.** Approval by a human is what gates
 *     unattended irreversible replay, so the artifact's home is where code
 *     review already happens — a reviewer reads the step list in a diff and
 *     approving is a commit. See `src/capability/store.ts`.
 *   - **`evidence/**` stays on the filesystem.** It is append-only run
 *     evidence including screenshots; it belongs in object storage, not in a
 *     document database. `events.jsonl` is written with `appendFileSync` so a
 *     crashed run still leaves everything up to the crash, and routing that
 *     through a network round trip per event would trade that guarantee away.
 */

import { MongoClient, type Collection, type Db } from 'mongodb';
import {
  newestFirst,
  type RunStore,
  type StoredAuthorization,
  type StoredIntervention,
  type StoredRun,
} from './run-store.js';

export class MongoRunStore implements RunStore {
  readonly backend = 'mongodb' as const;

  private constructor(
    private readonly client: MongoClient,
    private readonly runsC: Collection<StoredRun>,
    private readonly intsC: Collection<StoredIntervention>,
    private readonly authC: Collection<StoredAuthorization>,
  ) {}

  /**
   * Connects and ensures indexes.
   *
   * `serverSelectionTimeoutMS` is short on purpose. If `MONGODB_URI` points at
   * something that is not there, the useful outcome is a clear message in a few
   * seconds — not a panel that hangs for half a minute on boot before failing.
   */
  static async connect(uri: string, dbName?: string): Promise<MongoRunStore> {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
    await client.connect();
    const db: Db = dbName ? client.db(dbName) : client.db();

    const runsC = db.collection<StoredRun>('runs');
    const intsC = db.collection<StoredIntervention>('interventions');
    const authC = db.collection<StoredAuthorization>('irreversible_authorizations');

    await Promise.all([
      runsC.createIndex({ id: 1 }, { unique: true }),
      runsC.createIndex({ startedAt: -1 }),
      intsC.createIndex({ id: 1 }, { unique: true }),
      intsC.createIndex({ raisedAt: -1 }),
      authC.createIndex({ at: -1 }),
    ]);

    return new MongoRunStore(client, runsC, intsC, authC);
  }

  /**
   * Upsert rather than insert: a run is written when it starts and again on
   * every state change, so the same id is saved several times by design.
   */
  async saveRun(run: StoredRun): Promise<void> {
    await this.runsC.updateOne({ id: run.id }, { $set: strip(run) }, { upsert: true });
  }

  async listRuns(limit = 100): Promise<StoredRun[]> {
    return this.runsC.find({}, { projection: { _id: 0 } }).sort({ startedAt: -1 }).limit(limit).toArray();
  }

  async saveIntervention(i: StoredIntervention): Promise<void> {
    await this.intsC.updateOne({ id: i.id }, { $set: strip(i) }, { upsert: true });
  }

  async listInterventions(limit = 100): Promise<StoredIntervention[]> {
    return this.intsC.find({}, { projection: { _id: 0 } }).sort({ raisedAt: -1 }).limit(limit).toArray();
  }

  /**
   * Insert, never upsert. This is the audit trail: every authorisation is its
   * own event, and two identical approvals a minute apart are two facts, not
   * one fact written twice.
   */
  async recordAuthorization(a: StoredAuthorization): Promise<void> {
    await this.authC.insertOne({ ...a });
  }

  async listAuthorizations(limit = 100): Promise<StoredAuthorization[]> {
    const rows = await this.authC.find({}, { projection: { _id: 0 } }).sort({ at: -1 }).limit(limit).toArray();
    return newestFirst(rows, (r) => r.at);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * Drops `undefined` values before writing.
 *
 * The driver would otherwise store explicit nulls for optional fields that were
 * simply absent, which makes a document claim "this run had no tenant" where
 * the truth is "nobody said". It also keeps a re-saved run from resurrecting a
 * field that a later state legitimately cleared.
 */
function strip<T extends object>(doc: T): T {
  return Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Builds the store the process should use.
 *
 * Returns `null` when no URI is configured, so the caller falls back to the
 * in-memory store and the repo still runs with nothing installed. A bad URI is
 * reported and then tolerated for the same reason: losing run *history* is a
 * far smaller failure than a control panel that will not start.
 */
export async function connectRunStore(uri = process.env.MONGODB_URI): Promise<RunStore | null> {
  if (!uri) return null;
  try {
    const store = await MongoRunStore.connect(uri, process.env.MONGODB_DB);
    console.log(`  Run store: MongoDB (${redactUri(uri)})`);
    return store;
  } catch (err) {
    console.warn(
      `  Run store: MongoDB at ${redactUri(uri)} is unreachable ` +
        `(${err instanceof Error ? err.message : String(err)}).\n` +
        '  Continuing in memory — run history and the authorisation audit will not survive a restart.',
    );
    return null;
  }
}

/** A connection string carries a password. It must never reach a log line intact. */
export function redactUri(uri: string): string {
  return uri.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:***@');
}
