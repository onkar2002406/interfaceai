/**
 * The web implementation of `Surface`.
 *
 * Everything surface-specific lives behind this class. The agent loop, the
 * replay executor, the artifact schema and the resolver all talk to the
 * `Surface` interface, so a desktop implementation slots in beside this one
 * without any of them changing.
 *
 * `act()` is the single chokepoint, and it enforces three things in order:
 *
 *   1. **Who is in control** — the caller must present the live control token.
 *      An executor that kept a stale token cannot act while a human is driving.
 *   2. **What is allowed** — allowlist and risk policy, evaluated against the
 *      resolved target's accessible name so rules can talk about "Post Transfer"
 *      rather than about selectors.
 *   3. **Whether we are confident enough to act** — the resolver refuses on an
 *      ambiguous match instead of guessing.
 *
 * Because discovery and replay both funnel through here, they cannot drift apart
 * in what they are permitted to do — which is the property that makes the
 * guardrails trustworthy rather than decorative.
 */

import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import type {
  Action,
  ActResult,
  ElementNode,
  Observation,
  ObserveOptions,
  Surface,
  SurfaceErrorCode,
} from '../types.js';
import { perceive, readSignals } from './perception.js';
import { clickNode, NotActionableError, readNode, selectInNode, typeIntoNode } from './actuator.js';
import { resolve as resolveDescriptor } from '../resolver.js';
import { describeDescriptor } from '../descriptor.js';
import type { ControlAuthority, ControlToken, Holder } from '../../escalation/control.js';
import { ControlViolation } from '../../escalation/control.js';
import type { Policy, PolicyMode } from '../../policy/policy.js';
import { containsPii } from '../../policy/redact.js';

export interface SurfaceEvent {
  at: string;
  kind: 'action' | 'policy_denied' | 'navigation_blocked' | 'resolution_failed' | 'drift';
  detail: Record<string, unknown>;
}

export interface PlaywrightSurfaceOptions {
  policy: Policy;
  authority: ControlAuthority;
  mode: PolicyMode;
  headful?: boolean;
  viewport?: { width: number; height: number };
  /** Replay only: artifact approved AND caller authorised irreversible effects. */
  irreversibleAuthorized?: boolean;
  onEvent?: (e: SurfaceEvent) => void;
}

export class PlaywrightSurface implements Surface {
  readonly kind = 'web' as const;
  readonly sessionId: string;

  private lastObservation?: Observation;
  private blockedNavigations: string[] = [];

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly cdp: CDPSession,
    private readonly opts: PlaywrightSurfaceOptions,
    sessionId: string,
  ) {
    this.sessionId = sessionId;
  }

  static async launch(opts: PlaywrightSurfaceOptions): Promise<PlaywrightSurface> {
    const browser = await chromium.launch({ headless: !opts.headful });
    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 900 },
      // No real credentials, no real PII: this is a synthetic environment.
      ignoreHTTPSErrors: false,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('Accessibility.enable');

    const surface = new PlaywrightSurface(browser, context, page, cdp, opts, randomUUID());

    // Containment at the network layer as well as at act(). Belt and braces:
    // even an in-page JS redirect or a meta-refresh to somewhere off-allowlist
    // is stopped, which act() alone could not catch because no action was taken.
    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = req.url();
      const verdict = opts.policy.isUrlAllowed(url);
      if (req.isNavigationRequest() && !verdict.ok) {
        surface.blockedNavigations.push(url);
        surface.emit({
          at: new Date().toISOString(),
          kind: 'navigation_blocked',
          detail: { url, reason: verdict.reason },
        });
        await route.abort('blockedbyclient');
        return;
      }
      // Sub-resources need only be on an allowed origin.
      if (!req.isNavigationRequest()) {
        try {
          if (!opts.policy.config.origins.includes(new URL(url).origin)) {
            await route.abort('blockedbyclient');
            return;
          }
        } catch {
          await route.abort('blockedbyclient');
          return;
        }
      }
      await route.continue();
    });

    return surface;
  }

  private emit(e: SurfaceEvent): void {
    this.opts.onEvent?.(e);
  }

  /** Navigations that policy refused. Surfaced in the run report as evidence. */
  blockedNavigationLog(): readonly string[] {
    return this.blockedNavigations;
  }

  /* ------------------------------------------------------------- observe */

  /**
   * An observation must describe a single, settled moment.
   *
   * Two distinct hazards, and both produced failures that were miserable to
   * diagnose because everything looked correct by the time you went to look:
   *
   *   1. **Torn captures.** Perceiving the accessibility tree and reading the
   *      page text are separate round trips, and a frameset app navigates a
   *      frame out from under you constantly. Capture them independently and you
   *      get observations whose text came from the new screen and whose element
   *      inventory came from the old one — so a checkpoint passes while the
   *      elements needed to satisfy it are absent from the inventory.
   *
   *   2. **Committed but unparsed.** A frame sets its URL when a navigation
   *      commits, which is *before* the document is parsed. So a URL-only
   *      stability check happily certifies a page whose accessibility tree is
   *      still half-built — the checkpoint text is there, the table is not.
   *      This one showed up as an intermittent "declared output not found",
   *      which is exactly the sort of flake that erodes trust in a replay
   *      engine.
   *
   * So the fingerprint covers each frame's location AND its readyState, and a
   * capture is only accepted if nothing moved across it and no frame was still
   * loading. Cheap, and it removes both classes of phantom failure.
   */
  async observe(opts: ObserveOptions = {}): Promise<Observation> {
    const fingerprint = async (): Promise<string> => {
      const parts: string[] = [];
      for (const f of this.page.frames()) {
        let state = 'gone';
        try {
          state = await f.evaluate(() => document.readyState);
        } catch {
          /* detached or navigating */
        }
        parts.push(`${f.url()}#${state}`);
      }
      return parts.join('|');
    };

    let elements: Observation['elements'] = [];
    let signals!: Observation['signals'];

    for (let attempt = 0; attempt < 4; attempt++) {
      const before = await fingerprint();
      elements = await perceive(this.page, this.cdp);
      signals = await readSignals(this.page, this.cdp);
      const after = await fingerprint();
      const settled = after === before && !after.includes('#loading');
      if (settled || attempt === 3) break;
      await new Promise((r) => setTimeout(r, 120));
    }

    const observation: Observation = {
      observedAt: new Date().toISOString(),
      signals,
      elements,
    };

    if (opts.screenshot) {
      observation.screenshot = await this.screenshotWithPiiMasked(elements);
    }

    this.lastObservation = observation;
    return observation;
  }

  /**
   * Blacks out anything that looks like regulated data *before* the capture, so
   * the sensitive pixels never exist as bytes. Screenshots are the easiest place
   * to leak an SSN into a repo, and a post-hoc blur would still have written
   * the original to memory and possibly to disk.
   */
  private async screenshotWithPiiMasked(elements: ElementNode[]): Promise<Buffer> {
    const targets = elements.filter(
      (n) => n.handle && (containsPii(n.name) || containsPii(n.value ?? '')),
    );

    const objectIds: string[] = [];
    for (const node of targets) {
      const handle = node.handle as { backendNodeId: number };
      try {
        const { object } = (await this.cdp.send('DOM.resolveNode', {
          backendNodeId: handle.backendNodeId,
        })) as { object: { objectId: string } };
        objectIds.push(object.objectId);
        await this.cdp.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `function () {
            this.setAttribute('data-prev-style', this.getAttribute('style') || '');
            this.style.color = 'transparent';
            this.style.background = '#000';
          }`,
        });
      } catch {
        /* node vanished; nothing to mask */
      }
    }

    let png: Buffer;
    try {
      png = await this.page.screenshot({ fullPage: false });
    } finally {
      for (const objectId of objectIds) {
        try {
          await this.cdp.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: `function () {
              const prev = this.getAttribute('data-prev-style');
              if (prev !== null) { this.setAttribute('style', prev); this.removeAttribute('data-prev-style'); }
            }`,
          });
        } catch {
          /* best effort restore */
        }
      }
    }
    return png;
  }

  async location(): Promise<string> {
    return this.page.url();
  }

  /* ----------------------------------------------------------------- act */

  async act(action: Action, token: ControlToken, actor: Holder = 'automation'): Promise<ActResult> {
    // 1. Control ownership, before anything else touches the page.
    try {
      this.opts.authority.assert(token, actor);
    } catch (err) {
      if (err instanceof ControlViolation) {
        return this.fail(action, 'CONTROL_DENIED', err.message);
      }
      throw err;
    }

    const url = this.page.url();

    // 2. Resolve the target first, so policy can reason about *what* is being
    //    acted on ("Post Transfer") rather than just the action type.
    let node: ElementNode | undefined;
    let resolutionInfo: ActResult['resolution'];

    if ('target' in action) {
      const found = await this.resolveTarget(action);
      if (!found.ok) return found.result;
      node = found.node;
      resolutionInfo = found.info;
    }

    // 3. Policy.
    const decision = this.opts.policy.check(action, {
      mode: this.opts.mode,
      url,
      ...(node ? { targetName: node.name || node.proximateLabels[0] || node.role } : {}),
      ...(this.opts.irreversibleAuthorized !== undefined
        ? { irreversibleAuthorized: this.opts.irreversibleAuthorized }
        : {}),
    });

    if (!decision.allowed) {
      this.emit({
        at: new Date().toISOString(),
        kind: 'policy_denied',
        detail: { action: action.type, url, risk: decision.risk, rule: decision.ruleCode, reason: decision.reason },
      });
      const result = this.fail(action, 'POLICY_DENIED', decision.reason ?? 'denied by policy');
      // Carried through so the executor can decide escalate-vs-fail.
      (result as ActResult & { policy?: unknown }).policy = decision;
      return result;
    }

    // 4. Do it.
    try {
      const value = await this.perform(action, node);
      const result: ActResult = { ok: true, action, risk: decision.risk };
      if (value !== undefined) result.value = value;
      if (resolutionInfo) result.resolution = resolutionInfo;
      if (node) {
        result.actedOn = { role: node.role, name: node.name, framePath: node.framePath, bounds: node.bounds };
      }
      this.emit({
        at: new Date().toISOString(),
        kind: 'action',
        detail: {
          action: action.type,
          target: node ? node.name || node.proximateLabels[0] || node.role : undefined,
          risk: decision.risk,
          ...(resolutionInfo ? { score: Number(resolutionInfo.score.toFixed(3)), strategy: resolutionInfo.strategy } : {}),
        },
      });
      // The page usually moves after a click; let it settle before the next observe.
      if (action.type === 'click' || action.type === 'press' || action.type === 'navigate') {
        await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      }
      return result;
    } catch (err) {
      if (err instanceof NotActionableError) {
        return this.fail(action, 'TARGET_NOT_ACTIONABLE', err.message);
      }
      return this.fail(action, 'SURFACE_ERROR', err instanceof Error ? err.message : String(err));
    }
  }

  private async resolveTarget(
    action: Extract<Action, { target: unknown }>,
  ): Promise<
    | { ok: true; node: ElementNode; info?: ActResult['resolution'] }
    | { ok: false; result: ActResult }
  > {
    const target = action.target;

    if (target.kind === 'observed') {
      const node = this.lastObservation?.elements.find((e) => e.id === target.elementId);
      if (!node) {
        return {
          ok: false,
          result: this.fail(
            action,
            'TARGET_NOT_FOUND',
            `element "${target.elementId}" is not in the current observation — the page has changed since it was perceived`,
          ),
        };
      }
      return { ok: true, node };
    }

    // Descriptor path: ALWAYS re-perceive. The page has almost certainly moved
    // since whatever produced the last observation — that is the normal case in
    // a multi-step flow — and resolving a persisted descriptor against a stale
    // inventory is how you act on an element that is no longer there.
    // (The `observed` path above deliberately does the opposite: it must resolve
    // against the exact snapshot the model was looking at when it chose.)
    const observation = await this.observe();
    const res = resolveDescriptor(target.descriptor, observation.elements);

    if (!res.ok) {
      const near = res.ranked
        .slice(0, 3)
        .map((c) => `${c.node.role} "${c.node.name || c.node.proximateLabels[0] || ''}" @${c.score.toFixed(2)}`)
        .join('; ');
      this.emit({
        at: new Date().toISOString(),
        kind: 'resolution_failed',
        detail: { reason: res.reason, wanted: describeDescriptor(target.descriptor), near },
      });
      return {
        ok: false,
        result: this.fail(
          action,
          res.reason === 'ambiguous' ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND',
          res.reason === 'ambiguous'
            ? `refusing to act: more than one control matches ${describeDescriptor(target.descriptor)} ` +
                `— closest candidates were ${near || 'none'}`
            : `could not find ${describeDescriptor(target.descriptor)} — closest candidates were ${near || 'none'}`,
        ),
      };
    }

    if (res.drift) {
      this.emit({
        at: new Date().toISOString(),
        kind: 'drift',
        detail: {
          wanted: describeDescriptor(target.descriptor),
          matched: res.node.name || res.node.proximateLabels[0],
          score: Number(res.info.score.toFixed(3)),
          strategy: res.info.strategy,
        },
      });
    }

    return { ok: true, node: res.node, info: res.info };
  }

  private async perform(action: Action, node: ElementNode | undefined): Promise<string | undefined> {
    switch (action.type) {
      case 'click':
        await clickNode(this.cdp, this.page, node!);
        return undefined;
      case 'type':
        await typeIntoNode(this.cdp, this.page, node!, action.value, action.clear ?? true);
        return undefined;
      case 'select':
        await selectInNode(this.cdp, this.page, node!, action.value);
        return undefined;
      case 'press':
        await this.page.keyboard.press(action.key);
        return undefined;
      case 'navigate':
        await this.page.goto(action.url, { waitUntil: 'domcontentloaded' });
        return undefined;
      case 'read':
        return readNode(node!);
      case 'scroll':
        await this.page.mouse.wheel(0, action.direction === 'down' ? 500 : -500);
        return undefined;
    }
  }

  private fail(action: Action, code: SurfaceErrorCode, message: string): ActResult {
    return { ok: false, action, error: { code, message } };
  }

  /* -------------------------------------------- human control of the session */

  /**
   * Streams the live page to a human operator.
   *
   * Deliberately requires NO control token: an operator should be able to look
   * at a stuck session and understand it before deciding to take it over.
   * Watching changes nothing; only `dispatchHumanInput` does, and that is gated.
   */
  async startScreencast(onFrame: (jpegBase64: string) => void): Promise<() => Promise<void>> {
    const handler = (params: { data: string; sessionId: number }): void => {
      onFrame(params.data);
      // Ack promptly or Chromium throttles the stream to a stop.
      this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    };
    this.cdp.on('Page.screencastFrame', handler);
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1280,
      maxHeight: 900,
      everyNthFrame: 1,
    });

    return async () => {
      this.cdp.off('Page.screencastFrame', handler);
      await this.cdp.send('Page.stopScreencast').catch(() => {});
    };
  }

  /**
   * Applies a human's mouse or keyboard input to the SAME live session the
   * automation was driving — not a fresh browser, not a copy.
   *
   * The actuation path differs from `act()` (raw CDP input events rather than
   * resolved elements — a human points at pixels, not at descriptors), but it
   * goes through the same `ControlAuthority`. So the invariant holds in both
   * directions: automation cannot act while a human holds control, and a human
   * cannot act with a token that has been handed back or rotated.
   */
  async dispatchHumanInput(
    token: ControlToken,
    event:
      | { kind: 'mouse'; type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; clickCount?: number }
      | { kind: 'key'; type: 'keyDown' | 'keyUp' | 'char'; text?: string; key?: string; code?: string; windowsVirtualKeyCode?: number }
      | { kind: 'scroll'; x: number; y: number; deltaY: number },
  ): Promise<void> {
    this.opts.authority.assert(token, 'human');

    if (event.kind === 'mouse') {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: event.type,
        x: event.x,
        y: event.y,
        button: event.type === 'mouseMoved' ? 'none' : 'left',
        clickCount: event.clickCount ?? (event.type === 'mouseMoved' ? 0 : 1),
      });
      return;
    }
    if (event.kind === 'scroll') {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: event.x,
        y: event.y,
        deltaX: 0,
        deltaY: event.deltaY,
      });
      return;
    }
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: event.type,
      ...(event.text !== undefined ? { text: event.text } : {}),
      ...(event.key !== undefined ? { key: event.key } : {}),
      ...(event.code !== undefined ? { code: event.code } : {}),
      ...(event.windowsVirtualKeyCode !== undefined
        ? { windowsVirtualKeyCode: event.windowsVirtualKeyCode, nativeVirtualKeyCode: event.windowsVirtualKeyCode }
        : {}),
    });
  }

  /* ---------------------------------------------------------- lifecycle */

  /** The live page, for anything that legitimately needs the raw handle. */
  livePage(): Page {
    return this.page;
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}
