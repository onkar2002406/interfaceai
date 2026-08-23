/**
 * Locator resolution.
 *
 * The two behaviours worth protecting are the ones that are easy to regress
 * into something that "works" on the happy path:
 *
 *   1. it refuses when unsure, rather than picking the best of two similar
 *      candidates — in a bank, a confident wrong click is worse than a stall;
 *   2. it reports *how* it matched, so degradation is visible before it becomes
 *      breakage.
 */

import { describe, expect, it } from 'vitest';
import { resolve, MIN_SCORE, DRIFT_SCORE } from '../src/surface/element-resolver.js';
import { captureDescriptor, normalizeName, type ElementDescriptor } from '../src/surface/element-descriptor.js';
import type { ElementNode } from '../src/surface/types.js';

function node(partial: Partial<ElementNode> & { id: string; role: string }): ElementNode {
  return {
    name: '',
    framePath: ['main', 'contentFrame'],
    states: [],
    bounds: { x: 0, y: 0, width: 100, height: 20 },
    proximateLabels: [],
    context: {},
    ...partial,
  };
}

function descriptor(partial: Partial<ElementDescriptor> & { role: string }): ElementDescriptor {
  return {
    description: 'test',
    nameMatch: 'normalized',
    scope: {},
    anchors: [],
    hints: {},
    ...partial,
  };
}

describe('normalizeName', () => {
  it('collapses differences that never matter', () => {
    expect(normalizeName('Member ID:')).toBe(normalizeName('  member   id '));
    expect(normalizeName('Search…')).toBe('search');
  });

  it('does NOT collapse a genuine relabel', () => {
    // "Member ID" -> "Member Number" is a real tenant difference. Papering over
    // it would hide exactly the drift we want reported.
    expect(normalizeName('Member ID')).not.toBe(normalizeName('Member Number'));
  });
});

describe('resolve', () => {
  it('matches a named control by accessible name', () => {
    const els = [node({ id: 'e1', role: 'button', name: 'Search' }), node({ id: 'e2', role: 'link', name: 'Home' })];
    const r = resolve(descriptor({ role: 'button', name: 'Search' }), els);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node.id).toBe('e1');
      expect(r.info.strategy).toBe('name:normalized');
      expect(r.drift).toBe(false);
    }
  });

  it('identifies an UNNAMED legacy input by the caption beside it', () => {
    // The defining case: legacy markup gives text inputs no accessible name.
    const els = [
      node({ id: 'e1', role: 'textbox', proximateLabels: ['Member ID'] }),
      node({ id: 'e2', role: 'textbox', proximateLabels: ['Branch Code'] }),
    ];
    const r = resolve(
      descriptor({ role: 'textbox', anchors: [{ relation: 'proximateLabel', text: 'Member ID' }] }),
      els,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.id).toBe('e1');
  });

  it('REFUSES to act when two candidates are too close together', () => {
    const els = [
      node({ id: 'e1', role: 'button', name: 'Delete Account' }),
      node({ id: 'e2', role: 'button', name: 'Delete Account' }),
    ];
    const r = resolve(descriptor({ role: 'button', name: 'Delete Account' }), els);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ambiguous');
  });

  it('uses a recorded ordinal to break an exact tie deterministically', () => {
    const els = [
      node({ id: 'e1', role: 'button', name: 'Edit' }),
      node({ id: 'e2', role: 'button', name: 'Edit' }),
    ];
    const r = resolve(descriptor({ role: 'button', name: 'Edit', ordinal: 1 }), els);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node.id).toBe('e2');
      expect(r.info.strategy).toContain('ordinal');
    }
  });

  it('reports not_found rather than returning a weak match', () => {
    const els = [node({ id: 'e1', role: 'button', name: 'Cancel' })];
    const r = resolve(descriptor({ role: 'button', name: 'Post Transfer' }), els);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });

  it('never matches across incompatible roles', () => {
    const els = [node({ id: 'e1', role: 'link', name: 'Submit' })];
    const r = resolve(descriptor({ role: 'checkbox', name: 'Submit' }), els);
    expect(r.ok).toBe(false);
  });

  it('finds a table cell by column header and row, not by index', () => {
    // The same cell in two tenants whose columns are ordered differently.
    const base = [
      node({ id: 'e1', role: 'cell', name: '4820117735', context: { columnHeader: 'Account No.', rowCells: ['4820117735', 'Savings', '$8,412.55'] } }),
      node({ id: 'e2', role: 'cell', name: 'Savings', context: { columnHeader: 'Type', rowCells: ['4820117735', 'Savings', '$8,412.55'] } }),
      node({ id: 'e3', role: 'cell', name: '$8,412.55', context: { columnHeader: 'Current Balance', rowCells: ['4820117735', 'Savings', '$8,412.55'] } }),
    ];
    const reordered = [
      node({ id: 'x1', role: 'cell', name: 'Savings', context: { columnHeader: 'Type', rowCells: ['Savings', '4820117735', '$8,412.55'] } }),
      node({ id: 'x2', role: 'cell', name: '4820117735', context: { columnHeader: 'Account No.', rowCells: ['Savings', '4820117735', '$8,412.55'] } }),
      node({ id: 'x3', role: 'cell', name: '$8,412.55', context: { columnHeader: 'Current Balance', rowCells: ['Savings', '4820117735', '$8,412.55'] } }),
    ];

    const d = descriptor({
      role: 'cell',
      anchors: [
        { relation: 'underColumn', text: 'Current Balance' },
        { relation: 'inRowWith', text: 'Savings' },
      ],
    });

    const a = resolve(d, base);
    const b = resolve(d, reordered);
    expect(a.ok && a.node.id).toBe('e3');
    expect(b.ok && b.node.id).toBe('x3');
  });

  it('flags drift when a named control resolves only structurally', () => {
    // A tenant relabelled the field. It still resolves — it is the only text box
    // in the frame — but the system should say so rather than absorb it silently.
    const els = [node({ id: 'e1', role: 'textbox', proximateLabels: ['Member Number'] })];
    const r = resolve(
      descriptor({
        role: 'textbox',
        anchors: [{ relation: 'proximateLabel', text: 'Member ID' }],
        scope: { framePath: ['main', 'contentFrame'] },
      }),
      els,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.drift).toBe(true);
      expect(r.info.score).toBeGreaterThanOrEqual(MIN_SCORE);
      expect(r.info.score).toBeLessThan(DRIFT_SCORE);
    }
  });

  it('treats a stale DOM hint as a lost tiebreak, never as a veto', () => {
    const els = [node({ id: 'e1', role: 'button', name: 'Search', domHint: 'input#ctl99_NEW' })];
    const r = resolve(
      descriptor({ role: 'button', name: 'Search', hints: { domHint: 'input#ctl00_OLD' } }),
      els,
    );
    expect(r.ok).toBe(true);
  });
});

describe('captureDescriptor', () => {
  it('never records a data cell\'s own value as its identity', () => {
    // Recording `name: "$8,412.55"` would produce a capability that works
    // exactly once — for the member it was recorded against.
    const cell = node({
      id: 'e1',
      role: 'cell',
      name: '$8,412.55',
      context: { columnHeader: 'Current Balance', rowCells: ['4820117735', 'Savings', '$8,412.55'] },
    });
    const d = captureDescriptor(cell);
    expect(d.name).toBeUndefined();
    expect(d.anchors).toContainEqual({ relation: 'underColumn', text: 'Current Balance' });
  });

  it('prefers a categorical row key over a record identifier', () => {
    const cell = node({
      id: 'e1',
      role: 'cell',
      name: '$8,412.55',
      context: { columnHeader: 'Current Balance', rowCells: ['4820117735', 'Savings', '$8,412.55', '2014-03-11'] },
    });
    const d = captureDescriptor(cell);
    const rowAnchor = d.anchors.find((a) => a.relation === 'inRowWith');
    // "Savings" is a kind of thing; "4820117735" is one particular account.
    expect(rowAnchor?.text).toBe('Savings');
  });

  it('keeps a button\'s accessible name, which IS its identity', () => {
    const d = captureDescriptor(node({ id: 'e1', role: 'button', name: 'Submit Application' }));
    expect(d.name).toBe('Submit Application');
  });
});
