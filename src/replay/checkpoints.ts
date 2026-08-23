/**
 * Predicate and checkpoint evaluation.
 *
 * Every predicate is evaluated against an `Observation` — never against the
 * live page directly. That indirection is what makes checkpoints surface-
 * agnostic: the same `textPresent` check works on a browser, on a desktop app's
 * accessibility tree, and on OCR'd pixels, because all three produce an
 * Observation.
 *
 * Each evaluation returns what it actually *observed*, not just a boolean. A
 * failure report that says "expected the Member Detail heading, saw a page
 * titled 'Access Restricted'" is debuggable; one that says `false` is not.
 */

import type { Predicate, Checkpoint } from '../capability/schema.js';
import { resolve } from '../surface/element-resolver.js';
import { describeDescriptor } from '../surface/element-descriptor.js';
import type { Observation } from '../surface/types.js';

export interface PredicateResult {
  ok: boolean;
  /** Human-readable statement of what was required. */
  expected: string;
  /** Human-readable statement of what was actually there. */
  observed: string;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** A short excerpt of the page, for "what did we see instead" reporting. */
function excerpt(obs: Observation, max = 220): string {
  const t = obs.signals.visibleText.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function evaluatePredicate(p: Predicate, obs: Observation): PredicateResult {
  switch (p.kind) {
    case 'textPresent': {
      const ok = norm(obs.signals.visibleText).includes(norm(p.text));
      return {
        ok,
        expected: `text "${p.text}" present`,
        observed: ok ? `found "${p.text}"` : `not found; page reads: ${excerpt(obs)}`,
      };
    }
    case 'textAbsent': {
      const ok = !norm(obs.signals.visibleText).includes(norm(p.text));
      return {
        ok,
        expected: `text "${p.text}" absent`,
        observed: ok ? `absent` : `still present: "${p.text}"`,
      };
    }
    case 'elementPresent': {
      const r = resolve(p.target, obs.elements);
      return {
        ok: r.ok,
        expected: `${describeDescriptor(p.target)} present`,
        observed: r.ok
          ? `matched "${r.node.name || r.node.proximateLabels[0] || r.node.role}" (score ${r.info.score.toFixed(2)}, via ${r.info.strategy})`
          : `${r.reason}; closest candidates: ${
              r.ranked
                .slice(0, 3)
                .map((c) => `${c.node.role} "${c.node.name || c.node.proximateLabels[0] || ''}" @${c.score.toFixed(2)}`)
                .join('; ') || 'none'
            }`,
      };
    }
    case 'elementAbsent': {
      const r = resolve(p.target, obs.elements);
      return {
        ok: !r.ok,
        expected: `${describeDescriptor(p.target)} absent`,
        observed: r.ok ? `still present ("${r.node.name || r.node.role}")` : 'absent',
      };
    }
    case 'urlMatches': {
      // Checked against every frame's location, not just the top document.
      // In a frameset app the top URL never moves, so a top-only check would
      // silently pass (or fail) forever.
      const candidates = [obs.signals.url, ...obs.signals.frameUrls];
      let re: RegExp;
      try {
        re = new RegExp(p.pattern);
      } catch {
        return { ok: false, expected: `url matches /${p.pattern}/`, observed: 'invalid pattern' };
      }
      const hit = candidates.find((u) => re.test(u));
      return {
        ok: Boolean(hit),
        expected: `some frame's url matches /${p.pattern}/`,
        observed: hit ? `matched ${hit}` : `frame urls: ${candidates.join(', ')}`,
      };
    }
    case 'titleMatches': {
      let ok = false;
      try {
        ok = new RegExp(p.pattern).test(obs.signals.title);
      } catch {
        return { ok: false, expected: `title matches /${p.pattern}/`, observed: `invalid pattern` };
      }
      return { ok, expected: `title matches /${p.pattern}/`, observed: obs.signals.title || '(no title)' };
    }
  }
}

export interface CheckpointResult {
  ok: boolean;
  describe: string;
  failed: PredicateResult[];
  passed: PredicateResult[];
}

/**
 * `all` must every pass; `any` needs one. A checkpoint with neither is treated
 * as satisfied — used for steps whose only assertion is "the action didn't
 * error", which is legitimate for e.g. typing into a field.
 */
export function evaluateCheckpoint(cp: Checkpoint, obs: Observation): CheckpointResult {
  const allResults = cp.all.map((p) => evaluatePredicate(p, obs));
  const anyResults = cp.any.map((p) => evaluatePredicate(p, obs));

  const allOk = allResults.every((r) => r.ok);
  const anyOk = anyResults.length === 0 || anyResults.some((r) => r.ok);

  return {
    ok: allOk && anyOk,
    describe: cp.describe,
    failed: [...allResults.filter((r) => !r.ok), ...(anyOk ? [] : anyResults)],
    passed: [...allResults.filter((r) => r.ok), ...anyResults.filter((r) => r.ok)],
  };
}
