/**
 * Redaction.
 *
 * This system operates on regulated financial data, and it writes a lot to disk:
 * run logs, screenshots, AX snapshots, capability artifacts. Every one of those
 * is a place a member's SSN can end up in a git repo forever.
 *
 * The design rule is that redaction happens at the **write boundary**, not at
 * the call sites. Anything on its way to disk or to a model goes through here.
 * Relying on each caller to remember to redact is how leaks happen.
 *
 * Two tiers, because they need different treatment:
 *
 *   secret  — credentials, tokens. Never written in any form, not even hashed.
 *             There is no debugging use for a password.
 *   pii     — SSNs, account numbers, emails. Written as a stable per-run hash
 *             plus a short suffix, so you can still tell "the same account
 *             appeared at step 3 and step 9" while debugging, without the value
 *             ever existing in the log.
 *
 * Structural note: capability artifacts hold parameter *references*
 * (`{{memberId}}`), never captured values, so the strongest protection is that
 * there is nothing to redact in them in the first place. This module is the
 * backstop for logs and evidence, where real values legitimately pass through.
 */

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const SensitivitySchema = z.enum(['public', 'pii', 'secret']);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

/**
 * Per-run salt. Regenerated each run unless pinned via REDACTION_SALT, so
 * hashes correlate within a run but not across runs — a compromised log from
 * one run can't be used to confirm values in another.
 */
const SALT = process.env.REDACTION_SALT || randomBytes(16).toString('hex');

export function maskValue(value: string, sensitivity: Sensitivity): string {
  if (sensitivity === 'public') return value;
  if (sensitivity === 'secret') return '[REDACTED:secret]';
  return hashPii(value);
}

export function hashPii(value: string): string {
  const digest = createHash('sha256').update(SALT).update(value).digest('hex').slice(0, 8);
  const tail = value.replace(/\s/g, '').slice(-4);
  return `[pii:${digest}…${tail}]`;
}

/* --------------------------------------------------------------- patterns */

interface Pattern {
  name: string;
  re: RegExp;
  /** Optional extra test to cut false positives (e.g. Luhn for card numbers). */
  validate?: (m: string) => boolean;
}

function luhn(digits: string): boolean {
  const s = digits.replace(/\D/g, '');
  if (s.length < 13) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const PATTERNS: Pattern[] = [
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'card', re: /\b(?:\d[ -]?){13,19}\b/g, validate: luhn },
  // The TLD must be alphabetic. Without that, `capability_name@1.0.0` reads as
  // an email address and every log line naming a capability version gets
  // redacted into uselessness.
  { name: 'email', re: /\b[\w.+-]+@[\w-]+(?:\.[a-zA-Z]{2,})+\b/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
  { name: 'apiKey', re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g },
  // Institution account numbers in this product are 10 digits starting 482.
  // Real deployments would configure this per vendor product.
  { name: 'accountNumber', re: /\b482\d{7}\b/g },
];

/**
 * True if this text contains something that must not be persisted in the clear.
 * Used to decide which on-screen elements to black out *before* a screenshot is
 * taken, so the sensitive pixels never exist in the first place.
 */
export function containsPii(text: string): boolean {
  if (!text) return false;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    const m = text.match(p.re);
    if (!m) continue;
    if (p.validate && !m.some((x) => p.validate!(x))) continue;
    return true;
  }
  return false;
}

/** Scrubs free text — page text, error messages, model output, screenshots' alt text. */
export function redactText(input: string): string {
  let out = input;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (m) => {
      if (p.validate && !p.validate(m)) return m;
      if (p.name === 'bearer' || p.name === 'apiKey') return `[REDACTED:${p.name}]`;
      return hashPii(m);
    });
  }
  return out;
}

/** Recursively scrubs a structure on its way to a log file. */
export function redactDeep<T>(value: T, secretKeys: string[] = []): T {
  const secrets = new Set(
    ['password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'api_key', 'authorization', ...secretKeys].map((k) =>
      k.toLowerCase(),
    ),
  );

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = secrets.has(k.toLowerCase()) ? '[REDACTED:secret]' : walk(val);
      }
      return out;
    }
    return v;
  };

  return walk(value) as T;
}

/**
 * Redacts a set of input parameters using their declared sensitivity from the
 * capability schema. Declared sensitivity beats pattern matching — a member ID
 * that happens to look innocuous is still PII if the capability says so.
 */
export function redactParams(
  params: Record<string, unknown>,
  declared: Record<string, Sensitivity>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    const sens = declared[k] ?? 'pii'; // undeclared params are treated as PII
    out[k] = typeof v === 'string' ? maskValue(v, sens) : redactDeep(v);
  }
  return out;
}
