/**
 * The error taxonomy.
 *
 * The single most important property: a business outcome is a *different kind
 * of result* from a failure, and it wins whenever both could apply. The brief
 * names conflating them as the most common design mistake here, so it gets a
 * test rather than a comment.
 */

import { describe, expect, it } from 'vitest';
import { classify } from '../src/replay/replay-result.js';
import { evaluateCheckpoint, evaluatePredicate } from '../src/replay/checkpoints.js';
import type { Condition } from '../src/capability/schema.js';
import type { Observation } from '../src/surface/types.js';

function obs(text: string, url = 'http://localhost:4000/', frameUrls: string[] = []): Observation {
  return {
    observedAt: new Date().toISOString(),
    signals: { url, title: 'CoreBank', visibleText: text, frames: ['main'], frameUrls: [url, ...frameUrls] },
    elements: [],
  };
}

const businessCondition: Condition = {
  id: 'member_not_found',
  description: 'no such member',
  when: { kind: 'textPresent', text: 'No records found' },
  then: { kind: 'business', code: 'MEMBER_NOT_FOUND', message: 'No member matches the supplied identifier.' },
};

const recoverCondition: Condition = {
  id: 'session_expired',
  description: 'session timed out',
  when: { kind: 'textPresent', text: 'session has expired' },
  then: { kind: 'recover', action: { handler: 'reauthenticate', maxAttempts: 1 } },
};

const failCondition: Condition = {
  id: 'app_error',
  description: 'app blew up',
  when: { kind: 'textPresent', text: 'Unexpected System Error' },
  then: { kind: 'fail', errorClass: 'surface_error', message: 'the application returned its error page' },
};

const ALL = [businessCondition, recoverCondition, failCondition];

describe('classify', () => {
  it('returns none when nothing matches', () => {
    expect(classify(ALL, obs('Member Detail — Whitfield, Dana')).kind).toBe('none');
  });

  it('reports "no records found" as a business outcome, not a failure', () => {
    const c = classify(ALL, obs('Search Results. No records found. Return to Member Search'));
    expect(c.kind).toBe('business');
    if (c.kind === 'business') expect(c.code).toBe('MEMBER_NOT_FOUND');
  });

  it('recognises a recoverable condition', () => {
    const c = classify(ALL, obs('Your session has expired. Please sign on again.'));
    expect(c.kind).toBe('recover');
  });

  it('recognises a hard failure', () => {
    const c = classify(ALL, obs('Unexpected System Error. Reference: SYS-ABC'));
    expect(c.kind).toBe('fail');
    if (c.kind === 'fail') expect(c.errorClass).toBe('surface_error');
  });

  it('takes the FIRST match, so ordering is the taxonomy', () => {
    // A screen showing both. Ordered business-first, the caller gets the answer
    // rather than a retry loop.
    const both = obs('No records found. Unexpected System Error also occurred.');
    expect(classify(ALL, both).kind).toBe('business');
    // Reorder the conditions and the classification follows — the taxonomy is
    // data, not code.
    expect(classify([failCondition, businessCondition], both).kind).toBe('fail');
  });

  it('carries the evidence that fired, for the failure report', () => {
    const c = classify(ALL, obs('Unexpected System Error'));
    expect(c.kind).toBe('fail');
    if (c.kind === 'fail') expect(c.evidence.observed).toContain('Unexpected System Error');
  });
});

describe('predicates', () => {
  it('matches text case- and whitespace-insensitively', () => {
    expect(evaluatePredicate({ kind: 'textPresent', text: 'no records FOUND' }, obs('No   Records found')).ok).toBe(true);
  });

  it('reports what it saw instead, not just false', () => {
    const r = evaluatePredicate({ kind: 'textPresent', text: 'Member Detail' }, obs('Access Restricted'));
    expect(r.ok).toBe(false);
    expect(r.observed).toContain('Access Restricted');
  });

  it('checks urlMatches against every frame, not just the top document', () => {
    // A frameset app never changes its top URL. A top-only check would be inert.
    const o = obs('anything', 'http://localhost:4000/', ['http://localhost:4000/member/10001']);
    expect(evaluatePredicate({ kind: 'urlMatches', pattern: '/member/[0-9]+$' }, o).ok).toBe(true);
  });

  it('survives an invalid regex without throwing', () => {
    expect(evaluatePredicate({ kind: 'urlMatches', pattern: '([' }, obs('x')).ok).toBe(false);
  });
});

describe('checkpoints', () => {
  const cp = (all: Array<{ kind: 'textPresent'; text: string }>) => ({
    describe: 'test',
    all,
    any: [],
    timeoutMs: 1000,
    pollMs: 100,
  });

  it('requires every predicate in `all`', () => {
    const o = obs('Member Detail');
    expect(evaluateCheckpoint(cp([{ kind: 'textPresent', text: 'Member Detail' }]), o).ok).toBe(true);
    expect(
      evaluateCheckpoint(
        cp([
          { kind: 'textPresent', text: 'Member Detail' },
          { kind: 'textPresent', text: 'Accounts' },
        ]),
        o,
      ).ok,
    ).toBe(false);
  });

  it('is satisfied when it asserts nothing — typing changes nothing observable', () => {
    expect(evaluateCheckpoint(cp([]), obs('anything')).ok).toBe(true);
  });

  it('collects failures for the report', () => {
    const r = evaluateCheckpoint(cp([{ kind: 'textPresent', text: 'Accounts' }]), obs('Access Restricted'));
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.expected).toContain('Accounts');
  });
});
