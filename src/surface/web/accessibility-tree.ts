/**
 * Perception: turn a live browser page into a surface-agnostic ElementNode[].
 *
 * Built on the **accessibility tree**, not the DOM, via CDP
 * `Accessibility.getFullAXTree` joined with `DOM.getBoxModel` for geometry.
 * (Playwright's `page.accessibility.snapshot()` is not enough — it gives no
 * coordinates, and coordinates are what let us act like a human and what let us
 * associate unlabelled inputs with their captions.)
 *
 * Why the AX tree rather than the DOM:
 *
 *   - It is the same abstraction Windows UI Automation and macOS AX expose, so
 *     a desktop surface produces the same ElementNode[] without changing
 *     anything downstream.
 *   - It is what a human operator perceives. A vendor can restructure their
 *     table markup freely; they cannot change the caption next to a field
 *     without the operator noticing. So it is the more stable signal.
 *   - Legacy apps have no test IDs and generated ids, so the DOM offers nothing
 *     durable to key on anyway.
 *
 * Two derivations here do real work:
 *
 *   `proximateLabels` — legacy forms put the caption in an adjacent <td> with no
 *   <label for>, so Chromium computes an EMPTY accessible name for the input.
 *   We recover the association geometrically. This is exactly what the human
 *   does, and it is available on any surface that reports bounds — including a
 *   screenshot.
 *
 *   `columnHeader` / `rowCells` — a table cell is identified by the row it is in
 *   and the column header above it, never by index. That is what lets a
 *   capability recorded against one tenant survive another tenant's build
 *   reordering the columns of the same table.
 */

import type { CDPSession, Page } from 'playwright';
import type { ElementNode, PageSignals, Rect } from '../types.js';

/** Guard rails: legacy pages can be enormous, and every lookup is a round trip. */
const MAX_NODES = 600;
const MAX_GEOMETRY_LOOKUPS = 400;
const MAX_DOM_HINTS = 40;

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'listbox',
]);

const CONTENT_ROLES = new Set([
  'heading',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'StaticText',
  'paragraph',
  'alert',
  'alertdialog',
  'dialog',
  'status',
]);

const STRUCTURAL_ROLES = new Set(['table', 'row', 'rowgroup', 'form', 'region', 'navigation', 'main', 'list']);

/** Roles that can serve as a geometric caption for an unnamed control. */
const LABEL_CANDIDATE_ROLES = new Set(['StaticText', 'cell', 'paragraph']);

const CELL_ROLES = ['cell', 'gridcell', 'columnheader', 'rowheader'];

export function isInteractive(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}

/* --------------------------------------------------------------- CDP types */

interface AXValue {
  type: string;
  value?: unknown;
}

interface AXProperty {
  name: string;
  value: AXValue;
}

interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

interface FrameInfo {
  frameId: string;
  /** Frame chain from the top document, e.g. ["main", "contentFrame"]. */
  path: string[];
  url: string;
}

function str(v: AXValue | undefined): string {
  if (!v || v.value == null) return '';
  return typeof v.value === 'string' ? v.value : JSON.stringify(v.value);
}

/* ------------------------------------------------------------ frame walking */

async function frameTree(cdp: CDPSession, page: Page): Promise<FrameInfo[]> {
  interface CdpFrame {
    frame: { id: string; name?: string; url: string };
    childFrames?: CdpFrame[];
  }
  const { frameTree: root } = (await cdp.send('Page.getFrameTree')) as { frameTree: CdpFrame };

  // Playwright knows the frame names as authored; CDP's `name` can be blank for
  // <frame> elements, so fall back to matching on URL.
  const byUrl = new Map<string, string>();
  for (const f of page.frames()) byUrl.set(f.url(), f.name());

  const out: FrameInfo[] = [];
  const walk = (node: CdpFrame, parentPath: string[]): void => {
    const label =
      parentPath.length === 0
        ? 'main'
        : node.frame.name || byUrl.get(node.frame.url) || node.frame.url.split('/').pop() || 'frame';
    const path = parentPath.length === 0 ? ['main'] : [...parentPath, label];
    out.push({ frameId: node.frame.id, path, url: node.frame.url });
    for (const child of node.childFrames ?? []) walk(child, path);
  };
  walk(root, []);
  return out;
}

/* ------------------------------------------------------------- tree helpers */

interface FrameIndex {
  nodes: AXNode[];
  byId: Map<string, AXNode>;
  subtreeText: (nodeId: string) => string;
  headingBefore: (index: number) => string | undefined;
  ancestors: (n: AXNode) => AXNode[];
}

function indexFrame(nodes: AXNode[]): FrameIndex {
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);

  const textCache = new Map<string, string>();
  const subtreeText = (nodeId: string, depth = 0): string => {
    if (depth > 8) return '';
    const cached = textCache.get(nodeId);
    if (cached !== undefined) return cached;
    const n = byId.get(nodeId);
    if (!n) return '';
    const role = str(n.role);
    let text = role === 'StaticText' ? str(n.name) : str(n.name).trim();
    if (!text) {
      text = (n.childIds ?? [])
        .map((c) => subtreeText(c, depth + 1))
        .filter(Boolean)
        .join(' ');
    }
    const norm = text.replace(/\s+/g, ' ').trim();
    textCache.set(nodeId, norm);
    return norm;
  };

  const headings: Array<{ index: number; text: string }> = [];
  nodes.forEach((n, i) => {
    if (str(n.role) !== 'heading') return;
    const t = subtreeText(n.nodeId);
    if (t) headings.push({ index: i, text: t });
  });
  const headingBefore = (index: number): string | undefined => {
    let best: string | undefined;
    for (const h of headings) {
      if (h.index > index) break;
      best = h.text;
    }
    return best;
  };

  const ancestors = (n: AXNode): AXNode[] => {
    const out: AXNode[] = [];
    let cur = n.parentId ? byId.get(n.parentId) : undefined;
    let guard = 0;
    while (cur && guard++ < 40) {
      out.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return out;
  };

  return { nodes, byId, subtreeText: (id) => subtreeText(id), headingBefore, ancestors };
}

/* -------------------------------------------------------- table structure */

interface CellContext {
  rowCells: string[];
  columnHeader?: string;
}

/**
 * Annotates every table cell with its row's contents and its governing column
 * header. Computed from AX roles alone, so it works on a `<table>`-based layout
 * with no semantic markup beyond the tags themselves.
 */
function computeTableContext(idx: FrameIndex): Map<string, CellContext> {
  const out = new Map<string, CellContext>();

  for (const table of idx.nodes) {
    if (str(table.role) !== 'table') continue;

    const rows: AXNode[] = [];
    const collectRows = (id: string, depth = 0): void => {
      if (depth > 6) return;
      const node = idx.byId.get(id);
      if (!node) return;
      if (str(node.role) === 'row') rows.push(node);
      for (const c of node.childIds ?? []) collectRows(c, depth + 1);
    };
    for (const c of table.childIds ?? []) collectRows(c);

    const cellsOf = (row: AXNode): AXNode[] =>
      (row.childIds ?? [])
        .map((id) => idx.byId.get(id))
        .filter((c): c is AXNode => !!c && CELL_ROLES.includes(str(c.role)));

    // The header row is the first row made entirely of columnheaders; failing
    // that, the first row at all — legacy tables often use <td> for headers.
    const headerRow =
      rows.find((r) => {
        const cs = cellsOf(r);
        return cs.length > 0 && cs.every((c) => str(c.role) === 'columnheader');
      }) ?? rows[0];
    const headerTexts = headerRow ? cellsOf(headerRow).map((c) => idx.subtreeText(c.nodeId)) : [];

    for (const row of rows) {
      const cells = cellsOf(row);
      const rowCells = cells.map((c) => idx.subtreeText(c.nodeId));
      cells.forEach((c, i) => {
        const header = headerTexts[i];
        out.set(c.nodeId, {
          rowCells,
          ...(header && row !== headerRow ? { columnHeader: header } : {}),
        });
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------- label pass */

interface TextBox {
  text: string;
  rect: Rect;
}

/**
 * Recovers the caption of an unnamed control from geometry.
 *
 * In a two-column table form the left-hand caption is definitive, and whatever
 * sits *above* the input is the previous row's caption — which would otherwise
 * make every field look like it might belong to the field above it. So a
 * left-hand label suppresses above-labels entirely rather than merely
 * outranking them.
 */
function labelsFor(
  rect: Rect | null,
  textBoxes: TextBox[],
  viewportWidth: number,
  opts: { captionsOnly?: boolean } = {},
): string[] {
  if (!rect) return [];
  const left: Array<{ text: string; d: number }> = [];
  const above: Array<{ text: string; d: number }> = [];
  const cy = rect.y + rect.height / 2;

  for (const t of textBoxes) {
    if (t.rect.width === 0 || t.rect.height === 0) continue;
    // Full-width banners and headers are page furniture, not field captions.
    if (t.rect.width > viewportWidth * 0.6) continue;
    // For a read-only VALUE, require the neighbour to look like a caption.
    //
    // Geometry alone is enough for a form control — anything to the left of an
    // input box is a caption by construction. It is nowhere near enough for a
    // run of text: every word on a page has something to its left, so applying
    // the same rule to values yields dozens of pairings like "F3" / "=Sign Off"
    // and buries the handful that mean something. A trailing colon is the
    // convention this class of application states a caption with, and it is the
    // signal a person reads too.
    if (opts.captionsOnly && !t.text.trimEnd().endsWith(':')) continue;

    const tcy = t.rect.y + t.rect.height / 2;
    const tRight = t.rect.x + t.rect.width;
    const tBottom = t.rect.y + t.rect.height;

    // How far out of line a caption may sit and still be this thing's caption.
    //
    // A form control is taller than its caption, so it needs slack. A read-only
    // value is exactly as tall as the caption beside it and sits in the same
    // table row, so it needs almost none — and giving it slack is actively
    // wrong: rows in a legacy table are ~18px apart, which the generous band
    // spans, so a value would pair with the caption from the row BELOW it. That
    // is how "Hopper, Grace" ends up labelled "Phone:" while "Name:", directly
    // to its left, loses on horizontal distance.
    const band = opts.captionsOnly
      ? Math.max(rect.height, 12) * 0.5
      : Math.max(rect.height, 22) * 0.9;

    if (tRight <= rect.x + 8 && Math.abs(tcy - cy) <= band) {
      const d = rect.x - tRight;
      if (d >= -8 && d < 320) left.push({ text: t.text, d });
      continue;
    }
    if (tBottom <= rect.y + 6 && Math.abs(t.rect.x - rect.x) < 120) {
      const gap = rect.y - tBottom;
      if (gap <= 26) above.push({ text: t.text, d: gap });
    }
  }

  return (left.length > 0 ? left : above)
    .slice()
    .sort((a, b) => a.d - b.d)
    .map((s) => s.text.replace(/[:\s]+$/, ''))
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, 3);
}

/* ---------------------------------------------------------------- geometry */

async function boxOf(cdp: CDPSession, backendNodeId: number): Promise<Rect | null> {
  try {
    const box = (await cdp.send('DOM.getBoxModel', { backendNodeId })) as {
      model: { content: number[] };
    };
    const q = box.model.content;
    const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
    const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  } catch {
    // Not rendered (display:none, detached) — legitimately has no geometry.
    return null;
  }
}

/* ------------------------------------------------- accessibility tree fetch */

/**
 * Fetches a frame's accessibility tree, retrying while the tree is clearly
 * behind the document.
 *
 * Chromium builds the accessibility tree lazily and asynchronously. Immediately
 * after a navigation commits, a frame can have `document.readyState === "complete"`
 * and fully populated `innerText`, while `Accessibility.getFullAXTree` still
 * returns a near-empty tree for it.
 *
 * That produced the nastiest bug in this system: a checkpoint asserting page
 * text would pass (the text is there), the observation captured alongside it
 * would contain none of the page's controls or table cells, and output
 * extraction would then fail with "declared output not found" — intermittently,
 * on about one run in three, and never when you went to look. The page was
 * fine; our picture of it was half-built.
 *
 * The reliable test is **text coverage**: sum the text the accessibility tree
 * accounts for and compare it to the document's own `innerText`. A tree that
 * covers a small fraction of a page full of text is not a sparse page, it is a
 * tree still under construction. A node count alone is not enough — the failing
 * case had a partially built tree with a plausible-looking handful of nodes and
 * none of the table.
 */
async function axTreeFor(cdp: CDPSession, page: Page, frame: FrameInfo): Promise<AXNode[] | undefined> {
  const MEANINGFUL_TEXT = 40;
  /** The tree should account for at least this share of the document's text. */
  const MIN_COVERAGE = 0.5;
  const ATTEMPTS = 5;

  const pw = page.frames().find((f) => f.url() === frame.url);
  const bodyTextLength = async (): Promise<number> => {
    if (!pw) return 0;
    try {
      return await pw.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length);
    } catch {
      return 0;
    }
  };

  const bodyLen = await bodyTextLength();

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let nodes: AXNode[];
    try {
      const res = (await cdp.send('Accessibility.getFullAXTree', { frameId: frame.frameId })) as {
        nodes: AXNode[];
      };
      nodes = res.nodes;
    } catch {
      // A frame can vanish mid-observation. Perception must never be the thing
      // that throws — an incomplete view is recoverable, an exception is not.
      return undefined;
    }

    // A genuinely near-empty document (a frameset shell, a spacer frame) is
    // fine and should not be waited on.
    if (bodyLen < MEANINGFUL_TEXT) return nodes;

    const axTextLength = nodes.reduce(
      (sum, n) => (!n.ignored && str(n.role) === 'StaticText' ? sum + str(n.name).replace(/\s+/g, ' ').trim().length : sum),
      0,
    );
    if (axTextLength >= bodyLen * MIN_COVERAGE || attempt === ATTEMPTS - 1) return nodes;

    await new Promise((r) => setTimeout(r, 80));
  }
  return undefined;
}

/* ------------------------------------------------------------- main entry */

export async function perceive(page: Page, cdp: CDPSession): Promise<ElementNode[]> {
  const frames = await frameTree(cdp, page);
  const viewportWidth = page.viewportSize()?.width ?? 1280;
  const all: ElementNode[] = [];
  let idCounter = 0;
  let geometryBudget = MAX_GEOMETRY_LOOKUPS;
  let hintBudget = MAX_DOM_HINTS;

  for (const frame of frames) {
    const axNodes = await axTreeFor(cdp, page, frame);
    if (axNodes === undefined) continue;

    const idx = indexFrame(axNodes);
    const cellContext = computeTableContext(idx);

    /* ---- selection ---- */
    const kept: Array<{ ax: AXNode; index: number }> = [];
    axNodes.forEach((ax, index) => {
      if (ax.ignored) return;
      const role = str(ax.role);
      if (!role) return;
      if (!INTERACTIVE_ROLES.has(role) && !CONTENT_ROLES.has(role) && !STRUCTURAL_ROLES.has(role)) return;
      // Structural containers with no name identify nothing.
      if (STRUCTURAL_ROLES.has(role) && !str(ax.name).trim()) return;
      if (role === 'StaticText' && !idx.subtreeText(ax.nodeId)) return;
      kept.push({ ax, index });
    });
    const selected = kept.slice(0, MAX_NODES);

    /* ---- geometry, only where it earns its keep ----
       Every box model is a CDP round trip. Interactive controls always need one
       (we click by coordinate). Text only needs one if there is something on
       this screen whose caption we have to recover geometrically. */
    const hasUnnamedInteractive = selected.some(
      ({ ax }) => INTERACTIVE_ROLES.has(str(ax.role)) && !str(ax.name).trim(),
    );

    /**
     * Does this screen lay values out as caption/value pairs?
     *
     * A legacy app states a read-only value as a caption cell beside a value
     * cell — "Member No.: | 100234", "Confirmation: | CN480196". When the
     * surrounding table is borderless, Chromium reports the whole thing as
     * presentational, so there are no cells to key on and the value arrives as
     * bare text with no identity of any kind. It is on screen, a person reads it
     * without difficulty, and nothing could address it.
     *
     * The caption is the answer, exactly as it is for an unnamed input — so the
     * same geometric recovery runs, gated on a cheap text test so screens
     * without this layout pay nothing for it.
     */
    const hasCaptionedValues = selected.some(({ ax }) => {
      if (str(ax.role) !== 'StaticText') return false;
      const t = idx.subtreeText(ax.nodeId);
      return t.length > 0 && t.length < 40 && t.trimEnd().endsWith(':');
    });

    const wantsLabels = hasUnnamedInteractive || hasCaptionedValues;
    const needsGeometry = (ax: AXNode): boolean => {
      const role = str(ax.role);
      if (INTERACTIVE_ROLES.has(role)) return true;
      return wantsLabels && LABEL_CANDIDATE_ROLES.has(role);
    };

    const bounds = new Map<string, Rect | null>();
    for (const { ax } of selected) {
      if (geometryBudget <= 0) break;
      if (ax.backendDOMNodeId === undefined || !needsGeometry(ax)) continue;
      geometryBudget -= 1;
      bounds.set(ax.nodeId, await boxOf(cdp, ax.backendDOMNodeId));
    }

    const textBoxes: TextBox[] = wantsLabels
      ? selected
          .filter(({ ax }) => LABEL_CANDIDATE_ROLES.has(str(ax.role)) && bounds.get(ax.nodeId))
          .map(({ ax }) => ({ text: idx.subtreeText(ax.nodeId), rect: bounds.get(ax.nodeId)! }))
          .filter((t) => t.text.length > 0 && t.text.length < 60)
      : [];

    /**
     * Which nodes get a caption recovered for them, and how strictly.
     *
     * An unnamed control: always, on geometry alone — whatever sits to the left
     * of an input box is its caption.
     *
     * A read-only value: only where the neighbour is punctuated like a caption,
     * and never for a caption itself ("the text left of 'Name:'" identifies
     * nothing and would double the label set).
     *
     * Everything else: nothing. A named button already knows what it is.
     */
    const labelsForNode = (role: string, name: string, rect: Rect | null): string[] => {
      if (INTERACTIVE_ROLES.has(role)) {
        return name ? [] : labelsFor(rect, textBoxes, viewportWidth);
      }
      if (role !== 'StaticText' || !wantsLabels || name.trimEnd().endsWith(':')) return [];
      return labelsFor(rect, textBoxes, viewportWidth, { captionsOnly: true });
    };

    /* ---- build ---- */
    const builtByAxId = new Map<string, ElementNode>();
    for (const { ax, index } of selected) {
      const role = str(ax.role);
      const rect = bounds.get(ax.nodeId) ?? null;
      const name = role === 'StaticText' ? idx.subtreeText(ax.nodeId) : str(ax.name).trim();

      const states: string[] = [];
      for (const p of ax.properties ?? []) {
        if (p.value?.value === true) states.push(p.name);
        else if (p.name === 'checked' || p.name === 'expanded') states.push(`${p.name}=${str(p.value)}`);
      }

      const container = idx
        .ancestors(ax)
        .find((a) => STRUCTURAL_ROLES.has(str(a.role)) && str(a.name).trim());
      const cellCtx = cellContext.get(ax.nodeId);
      const heading = idx.headingBefore(index);

      const node: ElementNode = {
        id: `e${++idCounter}`,
        role,
        name,
        framePath: frame.path,
        states,
        bounds: rect,
        // An unnamed control is identified by its caption; so is a read-only
        // value, whose own text is exactly the thing that differs run to run.
        // A caption cell is not itself given one — "the text left of 'Name:'"
        // identifies nothing useful, and it would double the label set.
        proximateLabels: labelsForNode(role, name, rect),
        context: {
          ...(heading ? { heading } : {}),
          ...(container ? { container: { role: str(container.role), name: str(container.name).trim() } } : {}),
          ...(cellCtx?.rowCells ? { rowCells: cellCtx.rowCells } : {}),
          ...(cellCtx?.columnHeader ? { columnHeader: cellCtx.columnHeader } : {}),
        },
      };

      const v = str(ax.value);
      if (v) node.value = v;
      if (ax.backendDOMNodeId !== undefined) node.handle = { backendNodeId: ax.backendDOMNodeId };

      builtByAxId.set(ax.nodeId, node);
      all.push(node);
    }

    /* ---- dom hints: weak corroboration and debugging only ---- */
    for (const { ax } of selected) {
      if (hintBudget <= 0) break;
      if (!INTERACTIVE_ROLES.has(str(ax.role)) || ax.backendDOMNodeId === undefined) continue;
      const target = builtByAxId.get(ax.nodeId);
      if (!target) continue;
      hintBudget -= 1;
      try {
        const desc = (await cdp.send('DOM.describeNode', { backendNodeId: ax.backendDOMNodeId })) as {
          node: { nodeName: string; attributes?: string[] };
        };
        const attrs = desc.node.attributes ?? [];
        let hint = desc.node.nodeName.toLowerCase();
        for (let i = 0; i < attrs.length; i += 2) {
          if (attrs[i] === 'id' && attrs[i + 1]) hint += `#${attrs[i + 1]}`;
        }
        target.domHint = hint;
      } catch {
        /* hints are optional by design */
      }
    }
  }

  return all;
}

/* ------------------------------------------------------------ page signals */

export async function readSignals(page: Page, cdp: CDPSession): Promise<PageSignals> {
  const frames = await frameTree(cdp, page);
  const texts: string[] = [];
  const frameUrls: string[] = [];
  for (const f of page.frames()) {
    frameUrls.push(f.url());
    try {
      // `evaluate` rather than `locator('body').innerText()`: a <frameset>
      // document has no <body> at all, so the locator form waits out its full
      // timeout on every observation of every frameset page — which is every
      // observation in this application. This returns immediately instead.
      texts.push(await f.evaluate(() => (document.body ? document.body.innerText : '')));
    } catch {
      /* detached or mid-navigation */
    }
  }
  let title = '';
  try {
    title = await page.title();
  } catch {
    /* navigating */
  }
  return {
    url: page.url(),
    title,
    visibleText: texts.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
    frames: frames.map((f) => f.path.join('/')),
    frameUrls,
  };
}
