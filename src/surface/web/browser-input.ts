/**
 * Acting on a web surface.
 *
 * The bias here is toward the mechanism that would still work if there were no
 * clean DOM: **move the mouse to a coordinate and click, focus and type on the
 * keyboard**. That is what a human does, it is what an OS-level automation
 * framework does, and it does not care whether the page is a React app or a
 * 2004 frameset. Coordinates come from the accessibility tree's reported
 * bounds, so we never needed a selector to find them.
 *
 * One deliberate exception, and it is worth being explicit about rather than
 * hiding: **`select` on a native <select> is driven programmatically**, not by
 * clicking. A native dropdown renders an OS-level popup that lives outside the
 * page's coordinate space, so a synthetic click on the option is unreliable
 * across platforms. The escape hatch used here is the platform's *accessibility
 * action* — set the value and fire the change event — which is exactly what a
 * desktop surface would do through UI Automation's ValuePattern / SelectionItem
 * pattern. It is the same idea, not a DOM shortcut: "ask the platform to
 * perform the control's semantic action" rather than "find it with CSS".
 */

import type { CDPSession, Page } from 'playwright';
import type { ElementNode } from '../types.js';

export interface WebHandle {
  backendNodeId: number;
}

export function handleOf(node: ElementNode): WebHandle | undefined {
  const h = node.handle as WebHandle | undefined;
  return h && typeof h.backendNodeId === 'number' ? h : undefined;
}

export class NotActionableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotActionableError';
  }
}

/** Brings the control into view and returns its click point in page coordinates. */
async function pointFor(cdp: CDPSession, page: Page, node: ElementNode): Promise<{ x: number; y: number }> {
  const handle = handleOf(node);
  if (handle) {
    try {
      await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: handle.backendNodeId });
    } catch {
      // Non-fatal: some nodes (e.g. in a detached frame) can't be scrolled.
    }
  }

  // Re-read geometry after scrolling — the recorded bounds are now stale.
  let rect = node.bounds;
  if (handle) {
    try {
      const box = (await cdp.send('DOM.getBoxModel', { backendNodeId: handle.backendNodeId })) as {
        model: { content: number[] };
      };
      const q = box.model.content;
      const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
      const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      rect = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    } catch {
      /* fall back to the observed bounds */
    }
  }

  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new NotActionableError(
      `"${node.name || node.proximateLabels[0] || node.role}" has no usable geometry — it is present in the ` +
        `accessibility tree but not rendered (hidden, zero-sized, or detached)`,
    );
  }

  const vp = page.viewportSize() ?? { width: 1280, height: 900 };
  const x = Math.min(Math.max(rect.x + rect.width / 2, 1), vp.width - 1);
  const y = Math.min(Math.max(rect.y + rect.height / 2, 1), vp.height - 1);
  return { x, y };
}

export async function clickNode(cdp: CDPSession, page: Page, node: ElementNode): Promise<void> {
  const { x, y } = await pointFor(cdp, page, node);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
}

export async function typeIntoNode(
  cdp: CDPSession,
  page: Page,
  node: ElementNode,
  value: string,
  clear = true,
): Promise<void> {
  const { x, y } = await pointFor(cdp, page, node);
  await page.mouse.click(x, y);
  if (clear) {
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
  }
  await page.keyboard.type(value, { delay: 12 });
}

/**
 * Sets a listbox/combobox value via the platform's semantic action.
 * See the note at the top of this file for why this one is not coordinate-driven.
 */
export async function selectInNode(cdp: CDPSession, node: ElementNode, value: string): Promise<void> {
  const handle = handleOf(node);
  if (!handle) {
    throw new NotActionableError(`cannot set a value on "${node.name || node.role}" — no live handle`);
  }

  const { object } = (await cdp.send('DOM.resolveNode', { backendNodeId: handle.backendNodeId })) as {
    object: { objectId: string };
  };

  const result = (await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: `function (wanted) {
      if (this.tagName !== 'SELECT') return 'not-a-select';
      const norm = (s) => String(s).trim().toLowerCase();
      const opt = Array.from(this.options).find(
        (o) => norm(o.value) === norm(wanted) || norm(o.text) === norm(wanted),
      );
      if (!opt) return 'no-such-option:' + Array.from(this.options).map((o) => o.text).join('|');
      this.value = opt.value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    }`,
    arguments: [{ value }],
    returnByValue: true,
  })) as { result: { value: string } };

  if (result.result.value !== 'ok') {
    throw new NotActionableError(
      `could not select "${value}" on "${node.name || node.proximateLabels[0] || node.role}": ${result.result.value}`,
    );
  }
}

/** Reads a control's user-visible value — what a human would read off the screen. */
export function readNode(node: ElementNode): string {
  if (node.value && node.value.trim()) return node.value.trim();
  if (node.name && node.name.trim()) return node.name.trim();
  if (node.context.rowCells?.length) return node.context.rowCells.join(' ');
  return '';
}
