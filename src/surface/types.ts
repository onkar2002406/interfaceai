/**
 * The surface abstraction — the seam between "how we perceive and act on some
 * application" and "the recorded flow".
 *
 * Nothing in this file mentions the DOM, CSS, Playwright or HTTP. That is the
 * whole point: the capability artifact and the replay engine are written
 * against these types, so adding a legacy-web or desktop surface means writing
 * one new `Surface` implementation, not touching the schema or the executor.
 *
 * The vocabulary — role, accessible name, value, states, bounds — is chosen
 * because it is the intersection of what every relevant platform exposes:
 * the browser accessibility tree, Windows UI Automation, macOS AX API, and
 * (with OCR filling in `name`) a bare screenshot.
 */

import type { ControlToken } from '../escalation/control.js';
import type { ElementDescriptor } from './descriptor.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One perceivable control or piece of content.
 *
 * `name` is the accessible name — what a screen reader would announce, and
 * usually what a human would call the thing. It is the primary identity signal.
 * In legacy apps it is frequently EMPTY for text inputs (no <label for>), which
 * is why the structural and spatial context below is not optional decoration.
 */
export interface ElementNode {
  /** Stable only within a single Observation. Never persisted into an artifact. */
  id: string;
  role: string;
  name: string;
  value?: string;
  states: string[];
  bounds: Rect | null;
  /** Frame chain from the top document, e.g. ["main", "contentFrame"]. */
  framePath: string[];
  /**
   * Text sitting immediately left of or above this control, nearest first.
   * This is the identity of an unnamed legacy input: the caption in the
   * adjacent table cell that the markup never programmatically associated.
   * Derived from geometry, so it works on any surface that reports bounds.
   */
  proximateLabels: string[];
  context: {
    /** Nearest preceding heading / section label. */
    heading?: string;
    /** Nearest enclosing named container (form, table, region). */
    container?: { role: string; name: string };
    /** For table cells: the text of every cell in this cell's row. */
    rowCells?: string[];
    /** For table cells: the column header governing this cell. */
    columnHeader?: string;
  };
  /**
   * A DOM selector, recorded for debugging and as a weak corroborating signal.
   * Deliberately named a *hint*: the resolver may use it to break a tie, never
   * to make a match. A changed selector must not break replay.
   */
  domHint?: string;

  /**
   * Opaque, surface-owned reference to the live control (a CDP backend node id
   * here; a UIAutomation element on a desktop surface). Only the surface that
   * produced this node may interpret it, it is valid only for the lifetime of
   * the Observation, and it is NEVER serialised into an artifact — descriptors
   * are how identity persists across runs.
   */
  handle?: unknown;
}

export interface PageSignals {
  url: string;
  title: string;
  httpStatus?: number;
  /** Normalised, whitespace-collapsed visible text of the whole surface. */
  visibleText: string;
  /** Frames present, for debugging perception problems. */
  frames: string[];
  /**
   * Locations of every frame, not just the top document.
   *
   * In a frameset app the top URL never changes — you can navigate the whole
   * application and `page.url()` stays on the shell. Any location-based
   * checkpoint that only looked at the top URL would be meaningless, which is
   * exactly the trap a legacy surface sets.
   */
  frameUrls: string[];
}

export interface Observation {
  observedAt: string;
  signals: PageSignals;
  elements: ElementNode[];
  /** PNG bytes. Present only when the caller asked for it. */
  screenshot?: Buffer;
}

/* ------------------------------------------------------------------ actions */

/**
 * Two ways to name a target, unified so both the discovery loop and the
 * deterministic executor funnel through the *same* `act()` chokepoint:
 *
 *   - `observed`   the LLM points at something it can currently see, by the id
 *                  we handed it in the observation. It never sees a selector.
 *   - `descriptor` the executor points at a recorded, persisted description and
 *                  the resolver has to find it again.
 */
export type ActionTarget =
  | { kind: 'observed'; elementId: string }
  | { kind: 'descriptor'; descriptor: ElementDescriptor };

export type Action =
  | { type: 'click'; target: ActionTarget }
  | { type: 'type'; target: ActionTarget; value: string; clear?: boolean }
  | { type: 'select'; target: ActionTarget; value: string }
  | { type: 'press'; key: string }
  | { type: 'navigate'; url: string }
  | { type: 'read'; target: ActionTarget }
  | { type: 'scroll'; direction: 'up' | 'down' };

export type ActionType = Action['type'];

/** How a descriptor got matched — fed into the per-tenant drift signal. */
export interface ResolutionInfo {
  score: number;
  runnerUpScore: number;
  strategy: string;
  matchedName: string;
  candidatesConsidered: number;
  /**
   * True when the match succeeded but not by the signal it was recorded with —
   * the earliest cheap warning that this tenant's UI has moved.
   */
  drift: boolean;
}

export interface ActResult {
  ok: boolean;
  action: Action;
  /** Extracted text, for `read`. */
  value?: string;
  /**
   * The risk class policy actually assigned. Returned so the executor can
   * cross-check it against what the artifact *declared* — policy is
   * authoritative, but a mismatch means the artifact misdescribes what it does,
   * which is a reviewability problem worth surfacing.
   */
  risk?: string;
  resolution?: ResolutionInfo;
  /** Element actually acted on, for evidence. */
  actedOn?: Pick<ElementNode, 'role' | 'name' | 'framePath' | 'bounds'>;
  error?: { code: SurfaceErrorCode; message: string };
}

export type SurfaceErrorCode =
  | 'TARGET_NOT_FOUND'
  | 'AMBIGUOUS_TARGET'
  | 'TARGET_NOT_ACTIONABLE'
  | 'POLICY_DENIED'
  | 'CONTROL_DENIED'
  | 'SURFACE_ERROR';

/* ---------------------------------------------------------------- surface */

export interface ObserveOptions {
  /** Capture a screenshot alongside the element inventory. */
  screenshot?: boolean;
  /** Draw numbered marks over interactive elements (set-of-marks prompting). */
  annotate?: boolean;
  /** Mask these elements in the screenshot before the bytes ever exist. */
  maskDescriptors?: ElementDescriptor[];
}

export interface Surface {
  readonly kind: 'web' | 'desktop';
  readonly sessionId: string;

  observe(opts?: ObserveOptions): Promise<Observation>;

  /**
   * The single chokepoint. Allowlist, risk policy and control-token ownership
   * are all enforced here, which is why discovery and replay cannot drift apart
   * in what they are permitted to do.
   */
  act(action: Action, token: ControlToken): Promise<ActResult>;

  /** Current surface location, in whatever form the surface uses. */
  location(): Promise<string>;

  close(): Promise<void>;
}
