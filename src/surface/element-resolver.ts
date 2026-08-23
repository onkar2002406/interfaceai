/**
 * Descriptor -> live element resolution.
 *
 * This is scoring, not lookup. A selector engine answers "does this string
 * match"; that is the wrong question for an app whose selectors are generated
 * and whose labels differ per tenant. The right question is "which of the
 * things currently on screen best matches this description, and am I confident
 * enough to act on it".
 *
 * Two properties matter more than raw hit rate:
 *
 *   1. **It refuses when unsure.** If the best candidate doesn't clear an
 *      absolute threshold, or doesn't beat the runner-up by a margin, we return
 *      AMBIGUOUS rather than picking. In a bank, clicking the wrong button is far
 *      worse than not clicking at all — a stalled run escalates to a human, a
 *      confident wrong click posts a transaction.
 *
 *   2. **It reports how it won.** Every resolution carries its score and the
 *      strategy that carried it. A capability that used to match on accessible
 *      name and now only matches structurally still works, but that degradation
 *      is the earliest available signal that a tenant has drifted — so we surface
 *      it instead of silently absorbing it.
 *
 * Note this module imports nothing browser-specific. It scores ElementNodes,
 * which a desktop surface produces just as well as a web one.
 */

import { normalizeName, type Anchor, type ElementDescriptor } from './element-descriptor.js';
import type { ElementNode, ResolutionInfo, Rect } from './types.js';

/** Best candidate must reach this to be actionable at all. */
export const MIN_SCORE = 0.55;
/** ...and must beat the runner-up by this, or we call it ambiguous. */
export const MIN_MARGIN = 0.12;
/** Below this, we resolved but flag drift for review. */
export const DRIFT_SCORE = 0.8;

/**
 * Roles that legitimately substitute for one another across versions and
 * toolkits. `<input type=text>` becomes a searchbox when a vendor adds a
 * `type=search`; a desktop toolkit reports "edit" where the web reports
 * "textbox". Treating those as total mismatches would be brittle for no gain.
 */
const ROLE_FAMILIES: string[][] = [
  ['textbox', 'searchbox', 'combobox', 'edit', 'spinbutton'],
  ['button', 'menuitem', 'tab'],
  ['link', 'menuitem'],
  ['cell', 'gridcell', 'rowheader', 'columnheader'],
  ['checkbox', 'switch', 'menuitemcheckbox'],
  ['radio', 'menuitemradio'],
  ['heading', 'columnheader'],
  ['StaticText', 'text', 'paragraph', 'generic'],
];

function roleAffinity(descriptorRole: string, nodeRole: string): number {
  if (descriptorRole === nodeRole) return 1;
  const a = descriptorRole.toLowerCase();
  const b = nodeRole.toLowerCase();
  if (a === b) return 1;
  for (const fam of ROLE_FAMILIES) {
    const lower = fam.map((r) => r.toLowerCase());
    if (lower.includes(a) && lower.includes(b)) return 0.7;
  }
  return 0;
}

const WEIGHTS = {
  role: 25,
  name: 40,
  proximateLabel: 30,
  underColumn: 25,
  inRowWith: 25,
  nearHeading: 10,
  framePath: 15,
  container: 10,
  domHint: 5,
  geometry: 5,
} as const;

export interface ScoredCandidate {
  node: ElementNode;
  score: number;
  /** Which signals contributed, strongest first — for evidence and debugging. */
  matched: string[];
  strategy: string;
}

export type Resolution =
  | { ok: true; node: ElementNode; info: ResolutionInfo; drift: boolean; ranked: ScoredCandidate[] }
  | {
      ok: false;
      reason: 'not_found' | 'ambiguous';
      /** Top few candidates, so a failure report can say what it *did* see. */
      ranked: ScoredCandidate[];
    };

/* ------------------------------------------------------------ signal tests */

function nameScore(d: ElementDescriptor, node: ElementNode): number {
  if (!d.name) return 0;
  const want = d.name;
  const got = node.name ?? '';
  switch (d.nameMatch) {
    case 'exact':
      return got === want ? 1 : 0;
    case 'contains':
      return normalizeName(got).includes(normalizeName(want)) ? 1 : 0;
    case 'regex':
      try {
        return new RegExp(want, 'i').test(got) ? 1 : 0;
      } catch {
        return 0;
      }
    case 'normalized':
    default: {
      const n = normalizeName(got);
      const w = normalizeName(want);
      if (!n && !w) return 0;
      if (n === w) return 1;
      // Partial credit: one contains the other ("Search" vs "Search Members").
      if (n && w && (n.includes(w) || w.includes(n))) return 0.6;
      return 0;
    }
  }
}

function anchorScore(anchor: Anchor, node: ElementNode): number {
  const want = normalizeName(anchor.text);
  if (!want) return 0;

  switch (anchor.relation) {
    case 'proximateLabel': {
      const labels = node.proximateLabels.map(normalizeName);
      if (labels.length === 0) return 0;
      if (labels[0] === want) return 1; // the nearest caption is an exact hit
      // Merely being *somewhere* in the vicinity is much weaker evidence than
      // being the closest caption. Scoring these close together made adjacent
      // rows of a table-layout form indistinguishable, which the resolver then
      // (correctly, but uselessly) reported as ambiguous.
      if (labels.includes(want)) return 0.35;
      if (labels[0] && (labels[0].includes(want) || want.includes(labels[0]))) return 0.5;
      return 0;
    }
    case 'underColumn': {
      const h = normalizeName(node.context.columnHeader ?? '');
      if (!h) return 0;
      return h === want ? 1 : h.includes(want) || want.includes(h) ? 0.6 : 0;
    }
    case 'inRowWith': {
      const cells = (node.context.rowCells ?? []).map(normalizeName);
      if (cells.length === 0) return 0;
      if (cells.includes(want)) return 1;
      return cells.some((c) => c.includes(want) || want.includes(c)) ? 0.6 : 0;
    }
    case 'nearHeading': {
      const h = normalizeName(node.context.heading ?? '');
      if (!h) return 0;
      return h === want ? 1 : h.includes(want) || want.includes(h) ? 0.6 : 0;
    }
  }
}

function framePathScore(want: string[] | undefined, got: string[]): number {
  if (!want || want.length === 0) return 0;
  if (want.join('/') === got.join('/')) return 1;
  // A frame renamed but the depth preserved is worth partial credit.
  if (want.length === got.length) return 0.4;
  return 0;
}

function geometryScore(want: Rect | undefined, got: Rect | null): number {
  if (!want || !got) return 0;
  const dx = want.x + want.width / 2 - (got.x + got.width / 2);
  const dy = want.y + want.height / 2 - (got.y + got.height / 2);
  const dist = Math.hypot(dx, dy);
  // Full credit within 40px, decaying to nothing by 600px.
  if (dist <= 40) return 1;
  if (dist >= 600) return 0;
  return 1 - (dist - 40) / 560;
}

/* ------------------------------------------------------------------ scorer */

export function scoreCandidate(d: ElementDescriptor, node: ElementNode): ScoredCandidate | null {
  const affinity = roleAffinity(d.role, node.role);
  if (affinity === 0) return null; // wrong kind of control entirely

  let earned = 0;
  let applicable = 0;
  const matched: string[] = [];

  earned += WEIGHTS.role * affinity;
  applicable += WEIGHTS.role;
  if (affinity === 1) matched.push('role');
  else matched.push('role~');

  if (d.name) {
    const s = nameScore(d, node);
    earned += WEIGHTS.name * s;
    applicable += WEIGHTS.name;
    if (s === 1) matched.push(`name:${d.nameMatch}`);
    else if (s > 0) matched.push('name:partial');
  }

  for (const a of d.anchors) {
    const w = WEIGHTS[a.relation];
    const s = anchorScore(a, node);
    earned += w * s;
    applicable += w;
    if (s >= 0.8) matched.push(`anchor:${a.relation}`);
  }

  if (d.scope.framePath) {
    const s = framePathScore(d.scope.framePath, node.framePath);
    earned += WEIGHTS.framePath * s;
    applicable += WEIGHTS.framePath;
    if (s === 1) matched.push('frame');
  }

  if (d.scope.container) {
    const same =
      normalizeName(d.scope.container.name) === normalizeName(node.context.container?.name ?? '') &&
      d.scope.container.role === node.context.container?.role;
    earned += WEIGHTS.container * (same ? 1 : 0);
    applicable += WEIGHTS.container;
    if (same) matched.push('container');
  }

  // Weak corroboration only. Present in the numerator and denominator alike, so
  // a stale hint costs a little confidence but can never veto a good match.
  if (d.hints.domHint) {
    const same = d.hints.domHint === node.domHint;
    earned += WEIGHTS.domHint * (same ? 1 : 0);
    applicable += WEIGHTS.domHint;
    if (same) matched.push('domHint');
  }

  if (d.hints.boundsAtRecord) {
    const s = geometryScore(d.hints.boundsAtRecord, node.bounds);
    earned += WEIGHTS.geometry * s;
    applicable += WEIGHTS.geometry;
    if (s > 0.7) matched.push('geometry');
  }

  const score = applicable === 0 ? 0 : earned / applicable;

  return { node, score, matched, strategy: primaryStrategy(matched) };
}

/** The strongest signal that fired — this is what the drift report keys on. */
function primaryStrategy(matched: string[]): string {
  const order = [
    'name:exact',
    'name:normalized',
    'name:contains',
    'name:regex',
    'anchor:proximateLabel',
    'anchor:underColumn',
    'anchor:inRowWith',
    'name:partial',
    'anchor:nearHeading',
    'container',
    'frame',
    'geometry',
    'domHint',
    'role',
  ];
  for (const o of order) if (matched.includes(o)) return o;
  return 'structural';
}

/* ---------------------------------------------------------------- resolve */

export function resolve(descriptor: ElementDescriptor, elements: ElementNode[]): Resolution {
  const ranked = elements
    .map((n) => scoreCandidate(descriptor, n))
    .filter((c): c is ScoredCandidate => c !== null)
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  if (!top || top.score < MIN_SCORE) {
    return { ok: false, reason: 'not_found', ranked: ranked.slice(0, 5) };
  }

  const runnerUp = ranked[1];
  const runnerUpScore = runnerUp?.score ?? 0;

  if (runnerUp && top.score - runnerUpScore < MIN_MARGIN) {
    // Exact ties are legitimately disambiguated by recorded position — that is
    // deterministic, not a guess. Anything else, we refuse.
    const tied = ranked.filter((c) => Math.abs(c.score - top.score) < 1e-9);
    if (descriptor.ordinal !== undefined && tied.length > 1 && descriptor.ordinal < tied.length) {
      const chosen = tied[descriptor.ordinal]!;
      return {
        ok: true,
        node: chosen.node,
        info: {
          score: chosen.score,
          runnerUpScore,
          strategy: `${chosen.strategy}+ordinal`,
          matchedName: chosen.node.name,
          candidatesConsidered: ranked.length,
          drift: chosen.score < DRIFT_SCORE,
        },
        drift: chosen.score < DRIFT_SCORE,
        ranked: ranked.slice(0, 5),
      };
    }
    return { ok: false, reason: 'ambiguous', ranked: ranked.slice(0, 5) };
  }

  // Resolved, but not by the signal we recorded it with — the earliest warning
  // that this tenant's UI has moved and may need an override.
  const drift =
    top.score < DRIFT_SCORE || (!!descriptor.name && !top.matched.some((m) => m.startsWith('name:')));

  return {
    ok: true,
    node: top.node,
    info: {
      score: top.score,
      runnerUpScore,
      strategy: top.strategy,
      matchedName: top.node.name,
      candidatesConsidered: ranked.length,
      drift,
    },
    drift,
    ranked: ranked.slice(0, 5),
  };
}
