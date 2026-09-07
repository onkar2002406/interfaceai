/**
 * The durable run store.
 *
 * These cover the in-memory implementation and the pure helpers, not a live
 * MongoDB — a unit suite that needs a database running is a suite that gets
 * skipped. What matters here is the *contract* both implementations share, so
 * that swapping one for the other cannot change observable behaviour:
 *
 *   - runs upsert by id (a run is written on start and again on every state
 *     change, so the same id arrives repeatedly by design)
 *   - authorisations append (two identical approvals are two facts)
 *   - everything reads back newest-first
 *
 * Plus the one thing that is a security property rather than a behaviour: a
 * connection string carries a password and must never reach a log line intact.
 */

import { describe, expect, it } from 'vitest';
import { MemoryRunStore, newestFirst, type StoredRun } from '../src/store/run-store.js';
import { redactUri } from '../src/store/mongo.js';
import { storedRunOf, type PanelRun } from '../src/panel/server.js';

function run(id: string, startedAt: string, state: StoredRun['state'] = 'running'): StoredRun {
  return {
    id,
    kind: 'replay',
    capability: 'get_balance',
    tenant: 'base',
    startedAt,
    state,
    evidenceDir: `evidence/runs/replay-${id}`,
  };
}

describe('the run registry', () => {
  it('upserts by id, because a run is saved again on every state change', async () => {
    const store = new MemoryRunStore();
    await store.saveRun(run('a', '2026-09-05T10:00:00Z'));
    await store.saveRun(run('a', '2026-09-05T10:00:00Z', 'done'));

    const all = await store.listRuns();
    expect(all).toHaveLength(1);
    expect(all[0]!.state).toBe('done');
  });

  it('reads back newest first', async () => {
    const store = new MemoryRunStore();
    await store.saveRun(run('old', '2026-09-05T10:00:00Z'));
    await store.saveRun(run('new', '2026-09-05T12:00:00Z'));

    expect((await store.listRuns()).map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('honours the limit, so a long-lived panel does not return everything', async () => {
    const store = new MemoryRunStore();
    for (let i = 0; i < 10; i++) await store.saveRun(run(`r${i}`, `2026-09-05T10:0${i}:00Z`));

    expect(await store.listRuns(3)).toHaveLength(3);
  });
});

describe('the irreversible-authorisation audit', () => {
  it('appends rather than upserting — two identical approvals are two facts', async () => {
    const store = new MemoryRunStore();
    const entry = { capability: 'funds_transfer', tenant: 'meridian', identity: 'super1', at: '2026-09-05T10:00:00Z' };

    await store.recordAuthorization(entry);
    await store.recordAuthorization({ ...entry, at: '2026-09-05T10:01:00Z' });

    // Upserting here would silently erase the fact that it happened twice,
    // which is precisely the thing an audit exists to record.
    expect(await store.listAuthorizations()).toHaveLength(2);
  });

  it('keeps a null identity distinct from an absent one', async () => {
    const store = new MemoryRunStore();
    await store.recordAuthorization({
      capability: 'open_new_share',
      tenant: 'base',
      identity: null,
      at: '2026-09-05T10:00:00Z',
    });

    expect((await store.listAuthorizations())[0]!.identity).toBeNull();
  });
});

describe('escalations', () => {
  it('upserts, so resolving one updates the row it raised', async () => {
    const store = new MemoryRunStore();
    await store.saveIntervention({
      id: 'int_1',
      capability: 'open_sub_account',
      reasonClass: 'policy_irreversible',
      reason: 'irreversible step requires approval',
      raisedAt: '2026-09-05T10:00:00Z',
    });
    await store.saveIntervention({
      id: 'int_1',
      capability: 'open_sub_account',
      reasonClass: 'policy_irreversible',
      reason: 'irreversible step requires approval',
      raisedAt: '2026-09-05T10:00:00Z',
      resolvedAt: '2026-09-05T10:04:00Z',
      resolution: 'resumed',
      operator: 'j.okafor',
    });

    const all = await store.listInterventions();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ resolution: 'resumed', operator: 'j.okafor' });
  });
});

describe('the database is a write boundary too', () => {
  /**
   * A regression. The first version of the store wrote `run.result` straight
   * through, so an account number that appears as `[pii:…7735]` in the
   * committed evidence sat in plaintext in a collection that outlives the
   * process and is far easier to query than a directory of JSONL.
   *
   * The filesystem boundary is covered by `RunRecorder`; this pins the second
   * one. Anything that adds a third — an S3 sink, a log shipper — needs the
   * same treatment and should grow a case here.
   */
  function panelRun(): PanelRun {
    return {
      id: 'r1',
      kind: 'replay',
      capability: 'lookup_member_savings_balance@1.0.0',
      tenant: 'base',
      params: { memberId: '10001' },
      startedAt: '2026-09-06T04:00:00Z',
      state: 'done',
      events: [],
      evidenceDir: 'evidence/runs/replay-r1',
      subscribers: new Set(),
      listeners: new Set(),
      // Only the fields this test is about. The full envelope carries eleven
      // more that redaction does not treat differently, and spelling them out
      // would bury the one line that matters.
      result: {
        status: 'success',
        outputs: { savingsBalance: 8412.55, savingsAccountNumber: '4820117735' },
      } as unknown as PanelRun['result'],
    };
  }

  it('redacts an account number on its way into the run store', () => {
    const outputs = (storedRunOf(panelRun()).result as { outputs: Record<string, unknown> }).outputs;

    expect(outputs.savingsAccountNumber).not.toBe('4820117735');
    expect(String(outputs.savingsAccountNumber)).toMatch(/^\[pii:/);
    // The non-sensitive value is untouched — redaction that scrubbed the
    // balance too would make the stored run useless for the run history it
    // exists to serve.
    expect(outputs.savingsBalance).toBe(8412.55);
  });

  it('produces the same redaction the evidence file gets', () => {
    // Same salt within a process, so the two boundaries agree and a run can be
    // correlated between the database and its evidence directory.
    const a = (storedRunOf(panelRun()).result as { outputs: Record<string, unknown> }).outputs;
    const b = (storedRunOf(panelRun()).result as { outputs: Record<string, unknown> }).outputs;
    expect(a.savingsAccountNumber).toBe(b.savingsAccountNumber);
  });

  it('never stores a raw crash message unredacted', () => {
    const run = { ...panelRun(), state: 'error' as const, crash: 'failed for member ssn 412-55-9087' };
    expect(storedRunOf(run).crash).not.toContain('412-55-9087');
  });
});

describe('connection strings', () => {
  it('strips the password before anything is logged', () => {
    expect(redactUri('mongodb://admin:hunter2@cluster0.example.net/interface')).toBe(
      'mongodb://admin:***@cluster0.example.net/interface',
    );
  });

  it('leaves a credential-free URI alone', () => {
    expect(redactUri('mongodb://localhost:27017/interface')).toBe('mongodb://localhost:27017/interface');
  });
});

describe('newestFirst', () => {
  it('sorts ISO timestamps descending', () => {
    const sorted = newestFirst(
      [{ at: '2026-01-01T00:00:00Z' }, { at: '2026-06-01T00:00:00Z' }, { at: '2026-03-01T00:00:00Z' }],
      (x) => x.at,
    );
    expect(sorted.map((x) => x.at)).toEqual([
      '2026-06-01T00:00:00Z',
      '2026-03-01T00:00:00Z',
      '2026-01-01T00:00:00Z',
    ]);
  });
});
