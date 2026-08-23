/**
 * Surface-agnostic helpers for reading values off perceived elements.
 *
 * Kept out of the web surface on purpose: extracting a declared output must
 * work identically whether the node came from a browser accessibility tree, a
 * Windows UIAutomation element, or an OCR pass over a screenshot.
 */

import type { ElementNode } from './types.js';

/** What a human would read off this control. */
export function elementText(node: ElementNode): string {
  if (node.value && node.value.trim()) return node.value.trim();
  if (node.name && node.name.trim()) return node.name.trim();
  if (node.context.rowCells?.length) return node.context.rowCells.join(' ').trim();
  return '';
}

export type Transform = 'text' | 'trim' | 'money' | 'number';

export class TransformError extends Error {}

/**
 * Coerces a screen-read string into the declared output type.
 *
 * Money is parsed rather than passed through as a string deliberately: the
 * calling agent gets a number it can compare and arithmetic on, and the currency
 * symbol/thousands separators — which differ per tenant locale — never become
 * part of the contract.
 */
export function applyTransform(raw: string, transform: Transform): string | number {
  switch (transform) {
    case 'text':
      return raw;
    case 'trim':
      return raw.trim();
    case 'money': {
      const cleaned = raw.replace(/[^0-9.\-()]/g, '');
      const negative = /\(.*\)/.test(raw) || raw.trim().startsWith('-');
      const n = Number.parseFloat(cleaned.replace(/[()]/g, ''));
      if (Number.isNaN(n)) throw new TransformError(`"${raw}" is not a monetary amount`);
      return negative ? -Math.abs(n) : n;
    }
    case 'number': {
      const n = Number.parseFloat(raw.replace(/[^0-9.\-]/g, ''));
      if (Number.isNaN(n)) throw new TransformError(`"${raw}" is not a number`);
      return n;
    }
  }
}
