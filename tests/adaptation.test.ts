/**
 * The changes MERIDIAN CORE forced on the core, each pinned by the case that
 * forced it.
 *
 * Every test here corresponds to something that was silently wrong the first
 * time the engine was pointed at a second product. They are written as
 * regressions rather than as unit tests of new functions, because the value is
 * in the *case*: each one is a real screen shape that CoreBank never had and
 * that a third target will probably have again.
 *
 * The generic point they defend: a capability must be portable across records,
 * not merely across tenants. CoreBank's tables were keyed by category
 * ("Savings"), which hid a whole class of assumption; MERIDIAN's are keyed by
 * record identifier ("101555-CERT-4"), which exposed it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  captureDescriptor,
  interpolateDescriptor,
  type ElementDescriptor,
} from '../src/surface/element-descriptor.js';
import { resolve as resolveDescriptor } from '../src/surface/element-resolver.js';
import { interpolateCheckpoint, RecoveryActionSchema, type Checkpoint } from '../src/capability/schema.js';
import { AppProfileSchema, credentialEnvFor, policyPathFor } from '../src/capability/application-profile.js';
import { Policy } from '../src/policy/guardrails.js';
import { planFault, availableFaults, FaultUnsupportedError } from '../src/target/faults.js';
import type { ElementNode } from '../src/surface/types.js';

/* ------------------------------------------------------------- fixtures */

function cell(shareId: string, type: string, balance: string, status: string, column: string): ElementNode {
  const rowCells = [shareId, type, balance, status];
  const byColumn: Record<string, string> = {
    'Share ID': shareId,
    Type: type,
    Balance: balance,
    Status: status,
  };
  return {
    id: `e-${shareId}-${column}`,
    role: 'cell',
    name: byColumn[column]!,
    framePath: ['main'],
    states: [],
    bounds: { x: 0, y: 0, width: 80, height: 13 },
    proximateLabels: [],
    context: { rowCells, columnHeader: column, heading: 'MEMBER RECORD' },
  };
}

/** The shares table as the live app actually serves it — many rows, one member. */
function sharesTable(): ElementNode[] {
  return [
    ...['Share ID', 'Type', 'Balance', 'Status'].map((c) => cell('101555-S0001', 'Regular Shares', '$18,015.00', 'HOLD', c)),
    ...['Share ID', 'Type', 'Balance', 'Status'].map((c) => cell('101555-CERT', 'Certificate', '$25,000.00', 'HOLD', c)),
    ...['Share ID', 'Type', 'Balance', 'Status'].map((c) => cell('101555-CERT-4', 'Certificate', '$1,000.00', 'OPEN', c)),
    ...['Share ID', 'Type', 'Balance', 'Status'].map((c) => cell('101555-S0001-5', 'Regular Shares', '$100.00', 'OPEN', c)),
  ];
}

const balanceOfShare: ElementDescriptor = {
  description: 'the balance of share {{shareId}}',
  role: 'cell',
  nameMatch: 'normalized',
  scope: { framePath: ['main'], heading: 'MEMBER RECORD' },
  anchors: [
    { relation: 'underColumn', text: 'Balance' },
    { relation: 'inRowWith', text: '{{shareId}}' },
  ],
  hints: {},
};

/* --------------------------------------------------- parameterised anchors */

describe('a descriptor can name the record the caller asked about', () => {
  it('resolves the balance of exactly the requested share', () => {
    const bound = interpolateDescriptor(balanceOfShare, { shareId: '101555-CERT-4' });
    const r = resolveDescriptor(bound, sharesTable());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.name).toBe('$1,000.00');
  });

  it('resolves a different share on the next invocation, from the same artifact', () => {
    const table = sharesTable();
    const first = resolveDescriptor(interpolateDescriptor(balanceOfShare, { shareId: '101555-CERT-4' }), table);
    const second = resolveDescriptor(interpolateDescriptor(balanceOfShare, { shareId: '101555-S0001-5' }), table);
    expect(first.ok && first.node.name).toBe('$1,000.00');
    expect(second.ok && second.node.name).toBe('$100.00');
  });

  it('distinguishes a share id from the one it is a prefix of', () => {
    // `101555-CERT` is a prefix of `101555-CERT-4`. Scoring a partial row-key
    // match close to an exact one put the two inside the ambiguity margin, and
    // the resolver refused a match it should have made. CoreBank's categorical
    // row keys never produced a prefix pair.
    const r = resolveDescriptor(interpolateDescriptor(balanceOfShare, { shareId: '101555-CERT' }), sharesTable());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.name).toBe('$25,000.00');
  });

  it('leaves an unresolved reference intact rather than matching an arbitrary row', () => {
    // A missing argument must fail loudly. Substituting an empty string would
    // make the anchor match everything and silently return the first row.
    const bound = interpolateDescriptor(balanceOfShare, {});
    expect(bound.anchors.find((a) => a.relation === 'inRowWith')?.text).toBe('{{shareId}}');
    expect(resolveDescriptor(bound, sharesTable()).ok).toBe(false);
  });

  it('parameterises only the row key, never a column header or a heading', () => {
    // A structural label is a property of the screen, not of the record. If
    // `underColumn` were parameterised too, an argument that happened to equal
    // "Balance" would rewrite the column the descriptor reads from.
    const bound = interpolateDescriptor(
      { ...balanceOfShare, anchors: [{ relation: 'underColumn', text: 'Balance' }, { relation: 'nearHeading', text: 'MEMBER RECORD' }] },
      { shareId: 'Balance' },
    );
    expect(bound.anchors[0]!.text).toBe('Balance');
    expect(bound.anchors[1]!.text).toBe('MEMBER RECORD');
  });
});

describe('checkpoints are bound to the invocation too', () => {
  it('asserts about the requested record, not the recorded one', () => {
    // Missing this site was the subtlest of the lot: every step passed and the
    // run failed at the success checkpoint, having actually succeeded.
    const cp: Checkpoint = {
      describe: 'the declared values are on screen',
      all: [{ kind: 'elementPresent', target: balanceOfShare }],
      any: [],
      timeoutMs: 1000,
      pollMs: 100,
    };
    const bound = interpolateCheckpoint(cp, { shareId: '101555-CERT-4' });
    const target = (bound.all[0] as { target: ElementDescriptor }).target;
    expect(target.anchors.find((a) => a.relation === 'inRowWith')?.text).toBe('101555-CERT-4');
  });

  it('leaves text and url predicates alone', () => {
    const cp: Checkpoint = {
      describe: 'x',
      all: [{ kind: 'textPresent', text: 'MEMBER RECORD' }, { kind: 'urlMatches', pattern: '/members/[0-9]+' }],
      any: [],
      timeoutMs: 1000,
      pollMs: 100,
    };
    expect(interpolateCheckpoint(cp, { shareId: 'x' })).toEqual(cp);
  });
});

/* ------------------------------------------------- caption-identified values */

describe('a value stated as a caption/value pair', () => {
  // MERIDIAN prints the confirmation number of a posted transfer in a
  // borderless table, which Chromium reports as presentational — so there is no
  // cell to key on and the value arrives as bare text. Its own text is the one
  // thing that must never become its identity: it differs on every single run.
  const confirmation: ElementNode = {
    id: 'e1',
    role: 'StaticText',
    name: 'CN480196',
    framePath: ['main'],
    states: [],
    bounds: { x: 200, y: 100, width: 70, height: 13 },
    proximateLabels: ['Confirmation'],
    context: { heading: 'TRANSFER POSTED' },
  };

  it('is identified by its caption, never by the value it happens to hold', () => {
    const d = captureDescriptor(confirmation);
    expect(d.name).toBeUndefined();
    expect(d.anchors).toContainEqual({ relation: 'proximateLabel', text: 'Confirmation' });
  });

  it('still resolves when the value has changed since recording', () => {
    const d = captureDescriptor(confirmation);
    const nextRun = { ...confirmation, id: 'e9', name: 'CN991122' };
    const r = resolveDescriptor(d, [nextRun]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.name).toBe('CN991122');
  });

  it('keeps a named control identified by its name', () => {
    const button: ElementNode = {
      id: 'e2',
      role: 'button',
      name: 'Post Transfer',
      framePath: ['main'],
      states: [],
      bounds: { x: 0, y: 0, width: 90, height: 16 },
      proximateLabels: [],
      context: {},
    };
    expect(captureDescriptor(button).name).toBe('Post Transfer');
  });
});

/* ------------------------------------------------------------ recovery */

describe('retry_request', () => {
  it('is part of the closed handler set', () => {
    const parsed = RecoveryActionSchema.parse({ handler: 'retry_request' });
    expect(parsed).toEqual({ handler: 'retry_request', waitMs: 1500, maxAttempts: 2 });
  });

  it('still refuses a handler nobody reviewed', () => {
    // The closed set is what makes a recorded artifact reviewable. An
    // open-ended "run this to recover" field would be the obvious place to
    // smuggle unreviewed behaviour into the deterministic path.
    expect(() => RecoveryActionSchema.parse({ handler: 'run_script', script: 'rm -rf /' })).toThrow();
  });
});

/* ------------------------------------------------------------- identity */

describe('operator identity is separate from tenant', () => {
  const profile = AppProfileSchema.parse({
    product: 'p',
    description: 'd',
    conditions: [],
    identities: {
      teller: { user: 'T_USER', password: 'T_PASS' },
      supervisor: { user: 'S_USER', password: 'S_PASS' },
    },
    auth: {
      loginPath: '/signon',
      credentialEnv: { user: 'D_USER', password: 'D_PASS' },
      operatorField: { description: 'o', role: 'textbox' },
      passwordField: { description: 'p', role: 'textbox' },
      submitTarget: { description: 's', role: 'button', name: 'Sign On' },
      successCheckpoint: { describe: 'in' },
    },
    tenants: [
      { id: 'one', label: 'One', baseUrl: 'https://one.example', productVersion: '1' },
      { id: 'two', label: 'Two', baseUrl: 'https://two.example', productVersion: '1', credentialEnv: { user: 'TWO_USER', password: 'TWO_PASS' } },
    ],
  });

  it('resolves identity first, then tenant, then the product default', () => {
    const [one, two] = profile.tenants as [typeof profile.tenants[0], typeof profile.tenants[0]];
    expect(credentialEnvFor(profile, one).user).toBe('D_USER');
    expect(credentialEnvFor(profile, two).user).toBe('TWO_USER');
    expect(credentialEnvFor(profile, two, 'supervisor').user).toBe('S_USER');
  });

  it('refuses an identity the product does not declare, naming the ones it does', () => {
    expect(() => credentialEnvFor(profile, profile.tenants[0]!, 'auditor')).toThrow(/teller, supervisor/);
  });

  it('never carries a credential value, only a variable name', () => {
    const serialised = JSON.stringify(profile);
    expect(serialised).toContain('T_USER');
    expect(serialised).not.toMatch(/password"\s*:\s*"(?!.*_PASS)/);
  });
});

/* --------------------------------------------------------------- faults */

describe('fault arming is an adapter concern', () => {
  const base = {
    product: 'p',
    description: 'd',
    conditions: [],
    auth: {
      loginPath: '/signon',
      credentialEnv: { user: 'U', password: 'P' },
      operatorField: { description: 'o', role: 'textbox' },
      passwordField: { description: 'p', role: 'textbox' },
      submitTarget: { description: 's', role: 'button', name: 'Sign On' },
      successCheckpoint: { describe: 'in' },
    },
    tenants: [{ id: 't', label: 'T', baseUrl: 'https://t.example', productVersion: '1' }],
  };

  it('plans a session-scoped rewrite where the target honours a query parameter', () => {
    const profile = AppProfileSchema.parse({
      ...base,
      faults: { strategy: 'request_inject', param: 'inject', routes: { maintenance: '/members/*' } },
    });
    const armed = planFault(profile, profile.tenants[0]!, 'maintenance');
    expect(armed.via).toBe('surface');
    if (armed.via === 'surface') {
      // One-shot and route-targeted: it cannot disturb a shared install, and it
      // fires on the request the scenario is about rather than the first one.
      expect(armed.fault).toEqual({ kind: 'maintenance', param: 'inject', route: '/members/*', times: 1 });
    }
  });

  it('plans an out-of-band call where the target exposes an admin endpoint', () => {
    const profile = AppProfileSchema.parse({
      ...base,
      faults: { strategy: 'admin_endpoint', path: '/_admin/fault', routes: { session: '/member/*' } },
    });
    expect(planFault(profile, profile.tenants[0]!, 'session').via).toBe('endpoint');
  });

  it('refuses a fault the product cannot produce, listing the ones it can', () => {
    const profile = AppProfileSchema.parse({
      ...base,
      faults: { strategy: 'request_inject', routes: { server: '/x' } },
    });
    expect(() => planFault(profile, profile.tenants[0]!, 'nonsense')).toThrow(FaultUnsupportedError);
    expect(availableFaults(profile)).toEqual(['server']);
  });

  it('says so plainly when a product declares no mechanism at all', () => {
    const profile = AppProfileSchema.parse(base);
    expect(() => planFault(profile, profile.tenants[0]!, 'server')).toThrow(FaultUnsupportedError);
    expect(availableFaults(profile)).toEqual([]);
  });
});

/* ------------------------------------------- the MERIDIAN adapter itself */

describe('the MERIDIAN CORE adapter', () => {
  const profile = AppProfileSchema.parse(
    parseYaml(readFileSync('config/apps/meridian-core.yaml', 'utf8')),
  );
  const policy = Policy.fromFile(policyPathFor(profile, 'config/policy.json'));

  it('declares its own guardrails, so one flag switches target', () => {
    expect(policyPathFor(profile, 'config/policy.json')).toBe('config/policy.meridian.json');
    expect(policy.config.origins).toEqual(['https://web-sample.interface-hiring.com']);
  });

  it('orders the taxonomy business -> recoverable -> fatal', () => {
    const kinds = profile.conditions.map((c) => c.then.kind);
    const firstRecover = kinds.indexOf('recover');
    const firstFail = kinds.indexOf('fail');
    expect(kinds.lastIndexOf('business')).toBeLessThan(firstRecover);
    expect(firstRecover).toBeLessThan(firstFail);
  });

  it('treats a permission refusal as an answer, not a failure', () => {
    const c = profile.conditions.find((x) => x.id === 'supervisor_required');
    expect(c?.then.kind).toBe('business');
  });

  it('maps both wordings of "no such member" to one outcome code', () => {
    // Opening an unknown record gives RECORD NOT FOUND; searching for one gives
    // a different sentence on the inquiry form. A caller does not care which
    // route the vendor chose to express it.
    const codes = profile.conditions
      .filter((c) => c.then.kind === 'business' && c.then.code === 'MEMBER_NOT_FOUND')
      .map((c) => c.id);
    expect(codes).toHaveLength(2);
  });

  it('keeps the automation out of the fault console it is tested with', () => {
    expect(policy.isUrlAllowed('https://web-sample.interface-hiring.com/settings').ok).toBe(false);
    expect(policy.isUrlAllowed('https://web-sample.interface-hiring.com/members/101555').ok).toBe(true);
  });

  it('refuses any other origin outright', () => {
    expect(policy.isUrlAllowed('https://evil.example/members/1').ok).toBe(false);
  });

  it('classifies each posting control as irreversible, by its on-screen name', () => {
    const irreversible = (url: string, name: string) =>
      policy.check({ type: 'click', target: { kind: 'descriptor', descriptor: {} as ElementDescriptor } }, {
        mode: 'replay',
        url,
        targetName: name,
      }).risk;

    const base = 'https://web-sample.interface-hiring.com';
    expect(irreversible(`${base}/members/1/transfer/review`, 'Post Transfer')).toBe('irreversible');
    expect(irreversible(`${base}/members/1/hold/review`, 'Apply Hold')).toBe('irreversible');
    expect(irreversible(`${base}/members/1/open-share/review`, 'Open Share')).toBe('irreversible');
    // Continue only moves to the review screen; nothing is committed by it.
    expect(irreversible(`${base}/members/1/transfer`, 'Continue')).toBe('safe');
    // Editing contact details is reversible: type the old value back.
    expect(irreversible(`${base}/members/1/update`, 'Save Changes')).toBe('mutating');
  });

  it('tells the discovery model which controls it will be refused', () => {
    // Derived from the policy rather than restated in a prompt, so the two
    // cannot disagree. A model left to guess refuses to save an edit.
    const named = policy.irreversibleControlNames();
    expect(named).toContain('post transfer');
    expect(named).toContain('apply hold');
    expect(named).toContain('open share');
  });

  it('can produce every runtime state the brief lists', () => {
    // Containment, not equality: the assertion is that each named state is
    // producible, and the profile also declares narrower variants aimed at the
    // posting routes (`validation_on_transfer_post` and friends). Pinning the
    // exact set would make adding a scenario a test failure, which is the wrong
    // signal — the risk worth guarding against is one of these going missing.
    const faults = availableFaults(profile);
    for (const kind of ['maintenance', 'notfound', 'permission', 'server', 'timeout', 'validation']) {
      expect(faults).toContain(kind);
    }
  });

  it('can aim a fault at the commit rather than at the lookup', () => {
    // The broad `/members/**` routes fire on the member lookup, three screens
    // before a posting flow reaches anything irreversible. A posting scenario
    // needs the fault to land on the submission itself, or it demonstrates the
    // inquiry error path again rather than the posting one.
    const routes = profile.faults?.routes ?? {};
    expect(routes.validation_on_transfer_post).toBe('/members/*/transfer/post');
    expect(routes.permission_on_hold_post).toBe('/members/*/hold/post');
    expect(routes.validation).toBe('/members/**');
  });
});

/* --------------------------------------------------- policy back-compat */

describe('the original target is unaffected', () => {
  it('still resolves its own policy and keeps its admin path denied', () => {
    const corebank = AppProfileSchema.parse(
      parseYaml(readFileSync('config/apps/corebank-servicing.yaml', 'utf8')),
    );
    const policy = Policy.fromFile(policyPathFor(corebank, 'config/policy.json'));
    expect(policy.isUrlAllowed('http://localhost:4000/_admin/fault').ok).toBe(false);
    expect(policy.isUrlAllowed('http://localhost:4000/member/10001').ok).toBe(true);
    expect(corebank.tenants).toHaveLength(3);
  });

  it('falls back to the shared policy when a profile names none', () => {
    const minimal = { policy: undefined } as unknown as Parameters<typeof policyPathFor>[0];
    expect(policyPathFor(minimal, 'config/policy.json')).toBe('config/policy.json');
  });
});
