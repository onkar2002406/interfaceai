/**
 * Guardrails: redaction, allowlist, risk classification, control transfer.
 *
 * These are the tests that would catch a regulated-data leak or an unattended
 * irreversible action, so they check the *negative* cases hardest: what must
 * NOT happen, and what must be refused.
 */

import { describe, expect, it } from 'vitest';
import { containsPii, hashPii, maskValue, redactDeep, redactParams, redactText } from '../src/policy/redaction.js';
import { Policy, globToRegExp, type PolicyConfig } from '../src/policy/guardrails.js';
import { ControlAuthority, ControlViolation } from '../src/escalation/control-authority.js';
import { AGENT_TOOLS, toolsPermittedBy } from '../src/discovery/model-prompt.js';

/* ------------------------------------------------------------- redaction */

describe('redaction', () => {
  it('never writes a secret in any form, not even hashed', () => {
    expect(maskValue('hunter2', 'secret')).toBe('[REDACTED:secret]');
    expect(maskValue('hunter2', 'secret')).not.toContain('hunter2');
  });

  it('hashes PII stably within a run so events can be correlated', () => {
    const a = hashPii('412-55-9087');
    const b = hashPii('412-55-9087');
    expect(a).toBe(b);
    expect(a).not.toContain('412-55');
    expect(hashPii('412-55-9087')).not.toBe(hashPii('412-55-9088'));
  });

  it('scrubs SSNs, account numbers and emails out of free text', () => {
    const out = redactText('Member 412-55-9087 holds account 4820117735 (dana.whitfield@example.invalid)');
    expect(out).not.toContain('412-55-9087');
    expect(out).not.toContain('4820117735');
    expect(out).not.toContain('dana.whitfield@example.invalid');
  });

  it('does not mangle a capability reference that merely looks like an email', () => {
    // `lookup_member_savings_balance@1.0.0` is not an email address, and
    // redacting it would make every log line naming a version unreadable.
    expect(redactText('lookup_member_savings_balance@1.0.0')).toBe('lookup_member_savings_balance@1.0.0');
  });

  it('redacts by key name as well as by pattern', () => {
    const out = redactDeep({ operator: 'svc.demo', password: 'demo1234', nested: { token: 'abc' } }) as Record<
      string,
      unknown
    >;
    expect(out.password).toBe('[REDACTED:secret]');
    expect((out.nested as Record<string, unknown>).token).toBe('[REDACTED:secret]');
  });

  it('treats an undeclared parameter as PII rather than as public', () => {
    // Failing closed is the only safe default when the schema is silent.
    const out = redactParams({ mystery: '4820117735' }, {});
    expect(String(out.mystery)).not.toContain('4820117735');
  });

  it('honours a declared `public` sensitivity so logs stay readable', () => {
    const out = redactParams({ accountType: 'Savings' }, { accountType: 'public' });
    expect(out.accountType).toBe('Savings');
  });

  it('detects PII so screenshots can be masked before capture', () => {
    expect(containsPii('412-55-9087')).toBe(true);
    expect(containsPii('Member Detail')).toBe(false);
  });

  it('scrubs provider API keys, whatever prefix they use', () => {
    // A key that reaches a log is unrecoverable, so each provider's shape is
    // listed explicitly rather than left to a generic heuristic.
    // Fabricated, and deliberately so: never paste a real key into a test, not
    // even a truncated one. A prefix is still a prefix.
    for (const key of [
      'sk-proj-EXAMPLEexampleEXAMPLEexample0000',
      'gsk_EXAMPLEexampleEXAMPLEexample00000000',
      'ghp_EXAMPLEexampleEXAMPLEexample00000000',
    ]) {
      const out = redactText(`authorization header was ${key} at 12:04`);
      expect(out).not.toContain(key);
      expect(out).toContain('[REDACTED:apiKey]');
    }
  });
});

/* ------------------------------------------------------------- allowlist */

const CONFIG: PolicyConfig = {
  version: 1,
  origins: ['http://localhost:4000'],
  routes: { allow: ['/', '/search', '/member/*', '/member/*/transfer'], deny: ['/_admin/**'] },
  actions: ['click', 'type', 'navigate', 'read'],
  limits: { maxSteps: 40, maxRuntimeMs: 300000, maxRecoveries: 4 },
  risk: {
    irreversible: [
      {
        code: 'FUNDS_TRANSFER',
        description: 'posts a transfer',
        when: { actionType: 'click', routePattern: '^/member/[^/]+/transfer' },
      },
      {
        code: 'IRREVERSIBLE_SUBMIT',
        description: 'commits a record',
        when: { actionType: 'click', namePattern: '^(submit|post|delete)\\b' },
      },
    ],
    mutating: [{ code: 'FORM_INPUT', description: 'types', when: { actionType: 'type' } }],
  },
};

const policy = new Policy(CONFIG);
const click = { type: 'click' as const, target: { kind: 'observed' as const, elementId: 'e1' } };

describe('route globs', () => {
  it('* matches one segment, ** matches many', () => {
    expect(globToRegExp('/member/*').test('/member/10001')).toBe(true);
    expect(globToRegExp('/member/*').test('/member/10001/transfer')).toBe(false);
    expect(globToRegExp('/_admin/**').test('/_admin/fault')).toBe(true);
  });
});

describe('allowlist', () => {
  it('permits an allowed origin and route', () => {
    expect(policy.isUrlAllowed('http://localhost:4000/member/10001').ok).toBe(true);
  });

  it('refuses an off-allowlist origin', () => {
    const v = policy.isUrlAllowed('https://evil.example.com/member/10001');
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('origin');
  });

  it('refuses a route that is explicitly denied even though the origin is fine', () => {
    // The agent must not be able to reach the app's own test hooks.
    const v = policy.isUrlAllowed('http://localhost:4000/_admin/fault');
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('denied');
  });

  it('refuses an unlisted route', () => {
    expect(policy.isUrlAllowed('http://localhost:4000/secret').ok).toBe(false);
  });

  it('checks a navigation against its DESTINATION, not the current page', () => {
    const d = policy.check(
      { type: 'navigate', url: 'https://evil.example.com/' },
      { mode: 'replay', url: 'http://localhost:4000/' },
    );
    expect(d.allowed).toBe(false);
    // No human can consent us out of the containment boundary.
    expect(d.escalatable).toBe(false);
  });

  it('refuses an action type that is not permitted at all', () => {
    const d = policy.check({ type: 'press', key: 'Enter' }, { mode: 'replay', url: 'http://localhost:4000/' });
    expect(d.allowed).toBe(false);
  });
});

describe('the model is only offered tools policy permits', () => {
  // A refusal ends a discovery run, so a tool the allowlist forbids is worse
  // than useless: it is a way for one unlucky turn to abort a flow that would
  // otherwise have completed.
  it('withholds a tool whose action type is not on the allowlist', () => {
    const names = toolsPermittedBy(['click', 'type', 'select']).map((t) => t.name);
    expect(names).not.toContain('press');
    expect(names).toEqual(expect.arrayContaining(['click', 'type', 'select']));
  });

  it('always keeps the tools that end the run rather than act', () => {
    expect(toolsPermittedBy([]).map((t) => t.name)).toEqual(['finish', 'give_up']);
  });

  it('offers every acting tool when policy allows them all', () => {
    const all = AGENT_TOOLS.map((t) => t.name);
    expect(toolsPermittedBy(all).map((t) => t.name)).toEqual(all);
  });
});

describe('risk classification', () => {
  it('classifies by target name', () => {
    const d = policy.classifyRisk(click, {
      mode: 'replay',
      url: 'http://localhost:4000/member/10001',
      targetName: 'Submit Application',
    });
    expect(d.risk).toBe('irreversible');
    expect(d.rule?.code).toBe('IRREVERSIBLE_SUBMIT');
  });

  it('classifies by route', () => {
    const d = policy.classifyRisk(click, {
      mode: 'replay',
      url: 'http://localhost:4000/member/10001/transfer',
      targetName: 'Confirm',
    });
    expect(d.risk).toBe('irreversible');
    expect(d.rule?.code).toBe('FUNDS_TRANSFER');
  });

  it('leaves ordinary reads safe', () => {
    expect(
      policy.classifyRisk(click, { mode: 'replay', url: 'http://localhost:4000/search', targetName: 'Search' }).risk,
    ).toBe('safe');
  });
});

describe('discovery / replay asymmetry', () => {
  const ctx = { url: 'http://localhost:4000/member/10001', targetName: 'Submit Application' };

  it('NEVER lets a model take an irreversible action while exploring', () => {
    const d = policy.check(click, { ...ctx, mode: 'discovery' });
    expect(d.allowed).toBe(false);
    expect(d.risk).toBe('irreversible');
    // A human could complete it — so this escalates rather than fails.
    expect(d.escalatable).toBe(true);
  });

  it('blocks an irreversible replay step without explicit authorisation', () => {
    const d = policy.check(click, { ...ctx, mode: 'replay', irreversibleAuthorized: false });
    expect(d.allowed).toBe(false);
    expect(d.escalatable).toBe(true);
  });

  it('permits it once the caller has authorised this invocation', () => {
    const d = policy.check(click, { ...ctx, mode: 'replay', irreversibleAuthorized: true });
    expect(d.allowed).toBe(true);
  });

  it('still permits safe actions during discovery', () => {
    expect(
      policy.check(click, { mode: 'discovery', url: 'http://localhost:4000/search', targetName: 'Search' }).allowed,
    ).toBe(true);
  });
});

/* -------------------------------------------------------- control transfer */

describe('control transfer', () => {
  it('starts with automation holding a usable token', () => {
    const a = new ControlAuthority('run-1');
    expect(a.currentState()).toBe('AUTOMATION');
    expect(() => a.assert(a.automationToken(), 'automation')).not.toThrow();
  });

  it('invalidates the automation token the moment control is ceded', () => {
    const a = new ControlAuthority('run-1');
    const stale = a.automationToken();
    a.requestIntervention('needs a human');
    // This is the race the token model exists to prevent: an executor holding a
    // copy of the old token must not be able to act while a human is driving.
    expect(() => a.assert(stale, 'automation')).toThrow(ControlViolation);
  });

  it('refuses a human acting before they have claimed', () => {
    const a = new ControlAuthority('run-1');
    a.requestIntervention('needs a human');
    const notAToken = { id: 'made-up', holder: 'human' as const, sessionId: 'run-1' };
    expect(() => a.assert(notAToken, 'human')).toThrow(ControlViolation);
  });

  it('gives the operator a working token on claim, and only them', () => {
    const a = new ControlAuthority('run-1');
    a.requestIntervention('needs a human');
    const human = a.claim('j.okafor');
    expect(a.currentState()).toBe('HUMAN');
    expect(() => a.assert(human, 'human')).not.toThrow();
    expect(() => a.assert(a.automationToken(), 'automation')).toThrow(ControlViolation);
  });

  it('does NOT return control to automation on hand back — it moves to RESUMING', () => {
    // A human saying "done" is a claim. The executor must verify the resume
    // contract before it is allowed to touch the page again.
    const a = new ControlAuthority('run-1');
    a.requestIntervention('needs a human');
    const human = a.claim('j.okafor');
    a.handBack('did it');
    expect(a.currentState()).toBe('RESUMING');
    expect(() => a.assert(human, 'human')).toThrow(ControlViolation);
    expect(() => a.assert(a.automationToken(), 'automation')).toThrow(ControlViolation);
  });

  it('only hands control back to automation on an explicit resume', () => {
    const a = new ControlAuthority('run-1');
    a.requestIntervention('x');
    a.claim('op');
    a.handBack('done');
    const resumed = a.resumeAutomation('contract verified');
    expect(a.currentState()).toBe('AUTOMATION');
    expect(() => a.assert(resumed, 'automation')).not.toThrow();
  });

  it('rejects transitions that skip the state machine', () => {
    const a = new ControlAuthority('run-1');
    expect(() => a.claim('op')).toThrow(ControlViolation);
    expect(() => a.handBack('nope')).toThrow(ControlViolation);
    expect(() => a.resumeAutomation('nope')).toThrow(ControlViolation);
  });

  it('records every transition for the audit trail', () => {
    const a = new ControlAuthority('run-1');
    a.requestIntervention('irreversible step');
    a.claim('j.okafor');
    a.handBack('submitted manually');
    a.resumeAutomation('verified');
    expect(a.history().map((h) => h.to)).toEqual(['PENDING_HUMAN', 'HUMAN', 'RESUMING', 'AUTOMATION']);
    expect(a.history()[1]!.reason).toContain('j.okafor');
  });
});
