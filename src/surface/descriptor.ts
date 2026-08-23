/**
 * ElementDescriptor — how a recorded flow says which control it means.
 *
 * This is the single most consequential type in the system. Get it wrong and
 * replay is a house of cards: CSS selectors in enterprise apps are generated
 * (`ctl00_ContentPlaceHolder1_txtMbrId`), change between vendor versions, and
 * differ per tenant configuration. XPath through a table layout is worse.
 *
 * The model here is: **describe the control the way a human operator would**,
 * with several independent signals, and let the resolver score them.
 *
 *   1. role           — what kind of control it is
 *   2. name           — its accessible name, when it has one
 *   3. anchors        — the caption beside it, the row it sits in, the column
 *                       header above it, the heading it lives under
 *   4. scope          — which frame and which container
 *   5. ordinal        — position among otherwise-identical candidates
 *   6. hints          — DOM selector and recorded geometry, weak signals only
 *
 * Signals 1–5 all survive a re-skin, a version bump, and a per-tenant relabel of
 * *other* controls. Signal 6 does not, which is exactly why it is a tiebreak and
 * never a match.
 *
 * The set is also the intersection of what a browser AX tree, Windows UI
 * Automation and macOS AX all expose — so the same descriptor shape describes a
 * control in a desktop app without changing the schema.
 */

import { z } from 'zod';
import type { ElementNode } from './types.js';

export const NameMatchSchema = z.enum(['exact', 'normalized', 'contains', 'regex']);
export type NameMatch = z.infer<typeof NameMatchSchema>;

/**
 * Relations to nearby content. Each is something a person would say out loud:
 * "the box next to 'Member ID'", "the Current Balance cell in the Savings row".
 */
export const AnchorSchema = z.discriminatedUnion('relation', [
  /** Caption sitting immediately left of / above an unnamed control. */
  z.object({ relation: z.literal('proximateLabel'), text: z.string() }),
  /** A table cell in the same row as this text. */
  z.object({ relation: z.literal('inRowWith'), text: z.string() }),
  /** A table cell under this column header. Survives column reordering. */
  z.object({ relation: z.literal('underColumn'), text: z.string() }),
  /** Lives beneath this section heading. */
  z.object({ relation: z.literal('nearHeading'), text: z.string() }),
]);
export type Anchor = z.infer<typeof AnchorSchema>;

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const ElementDescriptorSchema = z.object({
  /** Prose for the human reviewing this capability. Never used to resolve. */
  description: z.string(),

  role: z.string(),
  name: z.string().optional(),
  nameMatch: NameMatchSchema.default('normalized'),

  scope: z
    .object({
      framePath: z.array(z.string()).optional(),
      heading: z.string().optional(),
      container: z.object({ role: z.string(), name: z.string() }).optional(),
    })
    .default({}),

  anchors: z.array(AnchorSchema).default([]),

  /** Index among candidates that tie on every stronger signal. */
  ordinal: z.number().int().nonnegative().optional(),

  /**
   * Weak corroborating signals. `domHint` is intentionally not a selector field:
   * calling it a hint is a load-bearing naming decision, because the next person
   * to read this code must not be tempted to resolve by it.
   */
  hints: z
    .object({
      domHint: z.string().optional(),
      boundsAtRecord: RectSchema.optional(),
      proximateLabels: z.array(z.string()).optional(),
    })
    .default({}),
});

export type ElementDescriptor = z.infer<typeof ElementDescriptorSchema>;

/* ------------------------------------------------------------ normalisation */

/**
 * Collapses the differences that never matter: case, whitespace, trailing
 * colons, decorative punctuation, non-breaking spaces.
 *
 * "Member ID:" and "member id" normalise together. "Member ID" and "Member
 * Number" deliberately do NOT — that is a real relabel and the system should
 * notice it rather than paper over it.
 */
export function normalizeName(s: string): string {
  return s
    .replace(/ /g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim()
    .replace(/[:*…]+$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/* ----------------------------------------------------------------- capture */

/**
 * Builds a descriptor from something we just successfully acted on.
 *
 * Called at compile time (trace -> artifact), not during replay. It records
 * every signal available at recording time, so the resolver has fallbacks even
 * if the strongest signal later disappears.
 */
/**
 * Values that identify a *record* rather than a *kind of thing*: account
 * numbers, amounts, dates, reference codes. Useless as identity — they are
 * exactly what changes between one invocation and the next.
 */
function looksLikeRecordData(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^\d[\d\s-]{3,}$/.test(t)) return true; // account/reference numbers
  if (/^[$€£]?\s?-?[\d,]+\.\d{2}$/.test(t)) return true; // money
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t)) return true; // dates
  if (/^\d+(\.\d+)?%?$/.test(t)) return true; // bare numbers
  return false;
}

export function captureDescriptor(node: ElementNode, intent?: string): ElementDescriptor {
  const anchors: Anchor[] = [];

  // An unnamed control's identity is the caption beside it.
  if (!node.name.trim() && node.proximateLabels.length > 0) {
    anchors.push({ relation: 'proximateLabel', text: node.proximateLabels[0]! });
  }

  // Table cells are identified by their POSITION in the table — the column
  // header above them and a categorical value in their row — never by their own
  // contents. This is the difference between a capability that reads "the
  // savings balance" and one that reads "the cell containing $8,412.55", which
  // would work exactly once, for the member it was recorded against.
  const isDataCell = Boolean(node.context.columnHeader);

  if (node.context.columnHeader) {
    anchors.push({ relation: 'underColumn', text: node.context.columnHeader });
  }
  if (node.context.rowCells?.length) {
    // Prefer a row key that names a *category* ("Savings", "Open") over one that
    // identifies this particular record ("4820117735", "$8,412.55").
    const rowKey =
      node.context.rowCells.find((c) => c !== node.name && !looksLikeRecordData(c)) ??
      node.context.rowCells.find((c) => c !== node.name && c.trim().length > 0);
    if (rowKey) anchors.push({ relation: 'inRowWith', text: rowKey });
  }

  if (node.context.heading) {
    anchors.push({ relation: 'nearHeading', text: node.context.heading });
  }

  const descriptor: ElementDescriptor = {
    description: intent ?? describeNode(node),
    role: node.role,
    nameMatch: 'normalized',
    scope: {
      framePath: node.framePath,
      ...(node.context.heading ? { heading: node.context.heading } : {}),
      ...(node.context.container ? { container: node.context.container } : {}),
    },
    anchors,
    hints: {
      ...(node.domHint ? { domHint: node.domHint } : {}),
      ...(node.bounds ? { boundsAtRecord: node.bounds } : {}),
      ...(node.proximateLabels.length ? { proximateLabels: node.proximateLabels.slice(0, 3) } : {}),
    },
  };

  // A button's accessible name is its identity. A data cell's "name" is just
  // whatever value it happens to be showing, so it must never become one.
  if (node.name.trim() && !isDataCell) descriptor.name = node.name.trim();

  return descriptor;
}

/** Human-readable one-liner, used for artifact review and escalation context. */
export function describeNode(node: ElementNode): string {
  if (node.name.trim()) return `${node.role} "${node.name.trim()}"`;
  if (node.proximateLabels.length) return `${node.role} labelled "${node.proximateLabels[0]}"`;
  if (node.context.columnHeader && node.context.rowCells?.length) {
    return `${node.role} in the "${node.context.columnHeader}" column of the row containing "${node.context.rowCells[0]}"`;
  }
  return `unnamed ${node.role}`;
}

export function describeDescriptor(d: ElementDescriptor): string {
  const parts: string[] = [d.name ? `${d.role} "${d.name}"` : `unnamed ${d.role}`];
  for (const a of d.anchors) {
    switch (a.relation) {
      case 'proximateLabel':
        parts.push(`labelled "${a.text}"`);
        break;
      case 'inRowWith':
        parts.push(`in the row containing "${a.text}"`);
        break;
      case 'underColumn':
        parts.push(`under the "${a.text}" column`);
        break;
      case 'nearHeading':
        parts.push(`under the "${a.text}" heading`);
        break;
    }
  }
  if (d.scope.framePath?.length) parts.push(`in frame ${d.scope.framePath.join('/')}`);
  return parts.join(', ');
}
