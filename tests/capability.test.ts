/**
 * The artifact schema, tenant overrides, and value extraction.
 *
 * The schema is the contract everything else is written against, so these tests
 * pin the properties that make it trustworthy: it round-trips, it rejects
 * malformed capabilities, overrides cannot smuggle in an invalid spec, and a
 * recorded run's values never reach the file.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilitySchema, interpolate, templateRefs, type Capability } from '../src/capability/schema.js';
import { CapabilityStore, bumpVersion, compareSemver } from '../src/capability/store.js';
import { getByPointer, OverrideError, resolveForTenant, setByPointer } from '../src/capability/tenant-overrides.js';
import { applyTransform, TransformError } from '../src/surface/element-values.js';
import { cardOf, inputSchemaOf, toolDefinitionsOf } from '../src/capability/catalog.js';

function fixture(): Capability {
  return CapabilitySchema.parse({
    apiVersion: 'capability.interface.ai/v1',
    kind: 'Capability',
    metadata: {
      id: 'cap_test',
      name: 'lookup_thing',
      version: '1.0.0',
      title: 'Look up a thing',
      summary: 'Finds a thing and reads its value.',
      createdAt: '2026-08-23T00:00:00.000Z',
      app: { product: 'corebank-servicing', productVersion: '8.2', tenant: 'base', entryPoint: '/' },
      approval: 'approved',
      provenance: {
        discoveryRunId: 'r1',
        model: 'none',
        surfaceKind: 'web',
        traceRef: 'none',
        traceSha256: '0'.repeat(64),
      },
    },
    spec: {
      preconditions: { authState: 'authenticated' },
      inputs: [
        { name: 'memberId', type: 'string', description: 'id', required: true, pattern: '^[0-9]+$', sensitivity: 'pii' },
      ],
      outputs: [
        {
          name: 'balance',
          type: 'money',
          description: 'balance',
          sensitivity: 'pii',
          from: {
            afterStep: 's2',
            transform: 'money',
            target: { description: 'balance cell', role: 'cell' },
          },
        },
      ],
      steps: [
        {
          id: 's1',
          intent: 'Open search.',
          action: { type: 'click', target: { description: 'search link', role: 'link', name: 'Member Search' } },
          guard: { risk: 'safe' },
        },
        {
          id: 's2',
          intent: 'Type the id.',
          action: {
            type: 'type',
            value: '{{memberId}}',
            target: { description: 'id box', role: 'textbox' },
          },
          guard: { risk: 'mutating' },
        },
      ],
      successCheckpoint: { describe: 'done', all: [{ kind: 'textPresent', text: 'Member Detail' }] },
      outcomes: { business: [{ code: 'MEMBER_NOT_FOUND', meaning: 'no such member' }] },
    },
    overrides: {
      firstvalley: {
        note: 'relabelled',
        patches: [{ path: '/steps/0/action/target/name', value: 'Find Member', why: 'their menu says Find Member' }],
      },
    },
  });
}

describe('schema', () => {
  it('round-trips through the store unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'caps-'));
    const store = new CapabilityStore(dir);
    const original = fixture();
    store.save(original);
    const loaded = store.load('lookup_thing@1.0.0');
    expect(loaded).toEqual(original);
  });

  it('rejects a name that is not a callable identifier', () => {
    const bad = fixture();
    bad.metadata.name = 'Look Up Thing';
    expect(() => CapabilitySchema.parse(bad)).toThrow();
  });

  it('rejects a non-semver version', () => {
    const bad = fixture();
    bad.metadata.version = 'v1';
    expect(() => CapabilitySchema.parse(bad)).toThrow();
  });

  it('rejects a capability with no steps', () => {
    const bad = fixture();
    bad.spec.steps = [];
    expect(() => CapabilitySchema.parse(bad)).toThrow();
  });

  it('applies documented defaults so hand-authored YAML stays terse', () => {
    const c = fixture();
    expect(c.spec.steps[0]!.optional).toBe(false);
    expect(c.spec.escalation.onIrreversible).toBe('require_approval');
    expect(c.spec.successCheckpoint.timeoutMs).toBe(10000);
  });

  it('stores a parameter REFERENCE, never a captured value', () => {
    const c = fixture();
    const typed = c.spec.steps[1]!.action;
    expect(typed.type === 'type' && typed.value).toBe('{{memberId}}');
    expect(JSON.stringify(c)).not.toContain('10001');
  });
});

describe('interpolation', () => {
  it('substitutes references', () => {
    expect(interpolate('/member/{{memberId}}', { memberId: '10001' })).toBe('/member/10001');
  });

  it('leaves an unsupplied reference intact rather than emitting "undefined"', () => {
    expect(interpolate('{{missing}}', {})).toBe('{{missing}}');
  });

  it('lists the references a template needs', () => {
    expect(templateRefs('{{a}}/{{b}}')).toEqual(['a', 'b']);
  });
});

describe('versions', () => {
  it('orders semver numerically, not lexically', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0);
  });
  it('bumps', () => {
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
  });
});

describe('tenant overrides', () => {
  it('leaves a tenant with no overrides untouched', () => {
    const { capability, appliedOverrides } = resolveForTenant(fixture(), 'harborcu');
    expect(appliedOverrides).toHaveLength(0);
    expect(capability.spec.steps[0]!.action).toMatchObject({ target: { name: 'Member Search' } });
  });

  it('applies patches for a tenant that has them', () => {
    const { capability, appliedOverrides } = resolveForTenant(fixture(), 'firstvalley');
    expect(appliedOverrides).toHaveLength(1);
    const target = capability.spec.steps[0]!.action;
    expect(target.type === 'click' && target.target.name).toBe('Find Member');
  });

  it('never mutates the stored artifact', () => {
    const original = fixture();
    resolveForTenant(original, 'firstvalley');
    const target = original.spec.steps[0]!.action;
    expect(target.type === 'click' && target.target.name).toBe('Member Search');
  });

  it('refuses a patch whose path does not exist', () => {
    // Far more likely to be a stale override than an intentional addition, and
    // silently growing a new branch would hide that.
    const c = fixture();
    c.overrides.firstvalley!.patches = [{ path: '/steps/9/nope', value: 'x', why: 'stale' }];
    expect(() => resolveForTenant(c, 'firstvalley')).toThrow(OverrideError);
  });

  it('re-validates, so an override cannot produce an invalid spec', () => {
    const c = fixture();
    c.overrides.firstvalley!.patches = [{ path: '/steps/0/guard/risk', value: 'catastrophic', why: 'nope' }];
    expect(() => resolveForTenant(c, 'firstvalley')).toThrow();
  });

  it('reads and writes JSON pointers', () => {
    const doc = { a: [{ b: 1 }] };
    expect(getByPointer(doc, '/a/0/b')).toBe(1);
    setByPointer(doc, '/a/0/b', 2);
    expect(doc.a[0]!.b).toBe(2);
  });
});

describe('value transforms', () => {
  it('parses money into a number the caller can do arithmetic on', () => {
    expect(applyTransform('$8,412.55', 'money')).toBe(8412.55);
    expect(applyTransform('($1,200.00)', 'money')).toBe(-1200);
  });
  it('trims', () => {
    expect(applyTransform('  4820117735  ', 'trim')).toBe('4820117735');
  });
  it('refuses to invent a number from text', () => {
    expect(() => applyTransform('not a balance', 'money')).toThrow(TransformError);
  });
});

describe('agent-facing catalog', () => {
  it('projects inputs into a JSON Schema an agent can call with', () => {
    const schema = inputSchemaOf(fixture());
    expect(schema.required).toEqual(['memberId']);
    expect(schema.properties.memberId).toMatchObject({ type: 'string', pattern: '^[0-9]+$' });
    expect(schema.additionalProperties).toBe(false);
  });

  it('advertises business outcomes so an agent does not retry a legitimate "no"', () => {
    const [tool] = toolDefinitionsOf([fixture()]);
    expect(tool!.description).toContain('MEMBER_NOT_FOUND');
    expect(tool!.description).toContain('not errors');
  });

  it('flags a capability that contains an irreversible step', () => {
    const c = fixture();
    c.spec.steps[0]!.guard.risk = 'irreversible';
    expect(cardOf(c).hasIrreversibleStep).toBe(true);
    expect(toolDefinitionsOf([c])[0]!.description).toContain('IRREVERSIBLE');
  });

  it('describes a read-only capability as safe to call speculatively', () => {
    expect(toolDefinitionsOf([fixture()])[0]!.description).toContain('Read-only');
  });
});
