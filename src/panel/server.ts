/**
 * Control panel — the operator-facing web surface for the automation itself.
 *
 * Everything this serves already existed as a library call or a CLI command.
 * That is the point, and the constraint the file is written under: the panel
 * composes `Catalog`, `replay()` and `RunRecorder`, and reimplements none of
 * them. A run started from a browser and a run started from `npm run replay`
 * go through the identical code path, produce the identical evidence directory,
 * and honour the identical guardrails. If the panel could reach a behaviour the
 * CLI could not, the panel would have become a second engine to keep correct.
 *
 * What it adds is visibility. The system's whole story — a typed capability
 * contract, a deterministic run, the four arms of the result contract, and the
 * evidence left behind — was previously only legible as terminal scrollback.
 *
 * Escalation is wired through to the real operator console rather than mocked
 * here: when a run stops for a human, the panel hands over the same
 * `InterventionBroker` the CLI uses, so the person takes control of the live
 * browser session the run is holding open.
 */

import express, { type Request, type Response } from 'express';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { Catalog, CapabilityInputError, cardOf, type CapabilityCard } from '../capability/catalog.js';
import { CapabilityStore } from '../capability/store.js';
import type { Capability } from '../capability/schema.js';
import {
  loadAppProfile,
  policyPathFor,
  tenantOf,
  type AppProfile,
} from '../capability/application-profile.js';
import { Policy } from '../policy/guardrails.js';
import { availableFaults, planFault, type ArmedFault } from '../target/faults.js';
import { mountCapabilityApi } from '../api/server.js';
import { mountChat } from '../api/chat.js';
import { RunRecorder, type RunEvent } from '../observability/run-recorder.js';
import { replay, validateInputs } from '../replay/executor.js';
import type { ReplayResult } from '../replay/replay-result.js';
import { renderDiscoverySummary, renderReplaySummary } from '../cli/run-reports.js';
import { connectToOperatorConsole, type AttachedConsole } from '../escalation/operator/console-client.js';
import { attachSessionBridge, mountInterventionApi } from '../escalation/operator/intervention-api.js';
import { resolveEntryUrl } from '../discovery/entry-url.js';
import {
  createProvider,
  defaultProviderName,
  describeChainFor,
  describeProviders,
  hasLiveProviderConfigured,
} from '../discovery/llm/provider-registry.js';
import { SwitchLog } from '../discovery/llm/failover-provider.js';
import { redactDeep } from '../policy/redaction.js';
import { MemoryRunStore, type RunStore, type StoredRun } from '../store/run-store.js';
import { connectRunStore } from '../store/mongo.js';

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_ROOT = resolvePath('evidence');

/**
 * Ad-hoc runs started from the panel land here rather than beside the curated
 * evidence directories.
 *
 * `evidence/` is a reviewed artifact — a fixed set of named scenarios produced
 * by `npm run evidence`, committed, and referenced from the write-up. Someone
 * clicking Replay a dozen times while demonstrating the system should not have
 * to hand-clean the repository afterwards, and a reviewer should not have to
 * guess which of thirty directories were the curated ones. So panel runs are
 * real evidence, written in the same format by the same recorder, in a
 * directory that is gitignored.
 */
const PANEL_RUNS_SUBDIR = 'runs';

/* ----------------------------------------------------------------- runs */

type RunState = 'running' | 'done' | 'error';

/** What a successful discovery run leaves behind: a saved draft, and where it went. */
interface DiscoveredCapability {
  card: CapabilityCard;
  path: string;
  steps: number;
  modelCalls: number;
}

export interface PanelRun {
  id: string;
  /**
   * Which of the two loops this is. They share the run record, the SSE stream
   * and the evidence format on purpose: to a person watching, "a model is
   * working the goal out" and "the recording is being replayed" are the same
   * kind of event to follow, and the interesting comparison is between them.
   */
  kind: 'replay' | 'discovery';
  capability: string;
  /** Discovery only: the natural-language goal, with its {{param}} references intact. */
  goal?: string;
  tenant: string;
  /** Which operator ran it, where the product declares named identities. */
  identity?: string;
  /** A harness-armed fault this run was deliberately made to hit, if any. */
  fault?: string;
  /** True when the run came in through the chatbot rather than a form. */
  viaChat?: boolean;
  params: Record<string, string>;
  startedAt: string;
  state: RunState;
  events: RunEvent[];
  result?: ReplayResult;
  /** Discovery only: what the run produced, once it has been compiled and saved. */
  discovered?: DiscoveredCapability | null;
  /** Set only when the run threw rather than returning a result contract. */
  crash?: string;
  evidenceDir: string;
  subscribers: Set<Response>;
  /**
   * In-process watchers, as distinct from HTTP subscribers.
   *
   * The chatbot needs to know the moment a run it launched escalates, so it can
   * tell the person in the same breath rather than after the ten-minute
   * intervention timeout. It is in this process, so handing it an SSE response
   * object it would have to parse back would be absurd.
   */
  listeners: Set<(e: RunEvent) => void>;
}

const runs = new Map<string, PanelRun>();

/**
 * Durable projection of the three previously RAM-only stores.
 *
 * Module-level and mutable because `runs` above is too, and the two have to be
 * written together. Set once at boot; `MemoryRunStore` when no `MONGODB_URI` is
 * configured, so every call site below is unconditional and there is no "if we
 * have a database" branch scattered through the request handlers.
 */
let runStore: RunStore = new MemoryRunStore();

/**
 * `PanelRun` minus the parts that only mean anything inside this process, and
 * **deep-redacted**.
 *
 * The redaction is the load-bearing part. `run.result` and `run.params` are the
 * raw in-memory objects; the copies that reach `evidence/` are redacted on the
 * way out by `RunRecorder`, which is the write boundary for the filesystem. The
 * database is a *second* write boundary for the same regulated data, and it
 * needs the same treatment — without this, an account number that appears as
 * `[pii:…7735]` in the committed evidence sits in plaintext in a collection
 * that outlives the process and is far easier to query.
 */
export function storedRunOf(run: PanelRun): StoredRun {
  return redactDeep({
    id: run.id,
    kind: run.kind,
    capability: run.capability,
    ...(run.goal ? { goal: run.goal } : {}),
    tenant: run.tenant,
    ...(run.identity ? { identity: run.identity } : {}),
    ...(run.fault ? { fault: run.fault } : {}),
    ...(run.viaChat ? { viaChat: true } : {}),
    params: run.params,
    startedAt: run.startedAt,
    ...(run.state !== 'running' ? { finishedAt: new Date().toISOString() } : {}),
    state: run.state === 'error' ? 'failed' : run.state,
    evidenceDir: run.evidenceDir,
    ...(run.result ? { result: run.result } : {}),
    ...(run.crash ? { crash: run.crash } : {}),
  });
}

/**
 * Writes a run's current state.
 *
 * Fire-and-forget with the rejection swallowed, deliberately: a database that
 * has gone away must not take down a run that is otherwise working. The run's
 * real evidence is already on disk in `events.jsonl`, written synchronously —
 * this store is the index over those runs, not the record itself.
 */
function persistRun(run: PanelRun): void {
  void runStore.saveRun(storedRunOf(run)).catch((err: unknown) => {
    console.warn(`  ! could not persist run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Mirrors escalations into the store from the run's own event stream.
 *
 * Taken from the events rather than from the broker because every escalation
 * already passes through here on its way to the UI, and a second subscription
 * to the broker would be a second thing to keep in agreement with the first.
 */
function persistEscalation(run: PanelRun, e: RunEvent): void {
  const d = e.detail as Record<string, unknown>;
  const id = String(d.interventionId ?? '');
  if (!id) return;

  if (e.kind === 'escalation_raised') {
    void runStore
      .saveIntervention({
        id,
        runId: run.id,
        capability: run.capability,
        tenant: run.tenant,
        reasonClass: String(d.reasonClass ?? ''),
        reason: String(d.reason ?? ''),
        atStep: String(d.step ?? ''),
        raisedAt: e.at,
      })
      .catch(() => undefined);
  } else if (e.kind === 'escalation_resolved') {
    void runStore
      .saveIntervention({
        id,
        runId: run.id,
        capability: run.capability,
        tenant: run.tenant,
        reasonClass: String(d.reasonClass ?? ''),
        reason: String(d.reason ?? ''),
        raisedAt: String(d.raisedAt ?? e.at),
        resolvedAt: e.at,
        resolution: String(d.resolution ?? ''),
        ...(d.operator ? { operator: String(d.operator) } : {}),
        ...(d.note ? { note: String(d.note) } : {}),
        ...(d.humanActions !== undefined ? { humanActions: Number(d.humanActions) } : {}),
      })
      .catch(() => undefined);
  }
}

/** Server-sent events: one framed message per subscriber. */
function push(run: PanelRun, type: string, data: unknown): void {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of run.subscribers) {
    try {
      res.write(frame);
    } catch {
      run.subscribers.delete(res);
    }
  }
}

/** Fan an event out to both the HTTP subscribers and the in-process watchers. */
function emitStep(run: PanelRun, e: RunEvent): void {
  run.events.push(e);
  push(run, 'step', e);
  if (e.kind === 'escalation_raised' || e.kind === 'escalation_resolved') persistEscalation(run, e);
  for (const fn of run.listeners) {
    try {
      fn(e);
    } catch {
      // A watcher that throws must not take down the run it is watching.
      run.listeners.delete(fn);
    }
  }
}

/** Watch a run's events in-process. Returns an unsubscribe. */
function subscribeToRun(id: string, fn: (e: RunEvent) => void): () => void {
  const run = runs.get(id);
  if (!run) return () => undefined;
  run.listeners.add(fn);
  return () => run.listeners.delete(fn);
}

/* --------------------------------------------------------------- helpers */

/**
 * Resolves a path inside the evidence directory, refusing anything that climbs
 * out of it. The panel serves files from disk by name supplied in a URL, which
 * is exactly the shape of a traversal bug; containment is checked against the
 * resolved real path rather than by pattern-matching the input.
 */
function evidencePathOf(relative: string): string | null {
  const target = resolvePath(EVIDENCE_ROOT, normalize(relative));
  const asPosix = (p: string) => p.replace(/\\/g, '/');
  const root = asPosix(EVIDENCE_ROOT);
  const t = asPosix(target);
  if (t !== root && !t.startsWith(`${root}/`)) return null;
  return existsSync(target) ? target : null;
}

/** Status of a completed evidence directory, read back from its result.json. */
function evidenceSummary(relDir: string): Record<string, unknown> {
  const full = join(EVIDENCE_ROOT, relDir);
  const resultPath = join(full, 'result.json');
  const curated = !relDir.startsWith(`${PANEL_RUNS_SUBDIR}/`) && !relDir.startsWith(`${PANEL_RUNS_SUBDIR}\\`);
  const base: Record<string, unknown> = { dir: relDir, status: 'unknown', curated };
  if (!existsSync(resultPath)) return base;
  try {
    const r = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    return {
      dir: relDir,
      curated,
      status: r.status ?? (r.outcome as Record<string, unknown> | undefined)?.kind ?? 'unknown',
      capability: r.capability ?? r.goal ?? null,
      tenant: r.tenant ?? null,
      code: r.code ?? null,
      startedAt: r.startedAt ?? null,
      durationMs: r.durationMs ?? null,
      files: readdirSync(full),
    };
  } catch {
    return base;
  }
}

/** A repo-relative, forward-slashed path, for display. */
function relativeToCwd(path: string): string {
  return relative(process.cwd(), path).replace(/\\/g, '/');
}

/** Every evidence directory, curated ones first, each as a path relative to `evidence/`. */
function listEvidenceDirs(): string[] {
  if (!existsSync(EVIDENCE_ROOT)) return [];
  const out: string[] = [];
  const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
  for (const entry of readdirSync(EVIDENCE_ROOT)) {
    if (entry === '_scratch') continue;
    const full = join(EVIDENCE_ROOT, entry);
    if (!isDir(full)) continue;
    if (entry === PANEL_RUNS_SUBDIR) {
      for (const sub of readdirSync(full)) {
        if (isDir(join(full, sub))) out.push(`${PANEL_RUNS_SUBDIR}/${sub}`);
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}

/* ---------------------------------------------------------------- server */

export interface ControlPanel {
  url: string;
  operatorUrl: string;
  close: () => Promise<void>;
}

export interface ControlPanelOptions {
  profile?: AppProfile;
  policy?: Policy;
  store?: CapabilityStore;
  port?: number;
  /**
   * Port for the operator console this panel starts in-process.
   *
   * Explicit rather than only `OPERATOR_PORT`, because two panels pointed at
   * two products run side by side (CoreBank on 4200, MERIDIAN on 4300) and a
   * single environment variable cannot give them different consoles. Without
   * it the second panel silently lands on an OS-assigned port, and the handoff
   * URL printed at startup is not the one anybody was told to open.
   */
  operatorPort?: number;
  /** Show the browser window for runs started from the panel. */
  headful?: boolean;
}

export async function startControlPanel(opts: ControlPanelOptions = {}): Promise<ControlPanel> {
  const profile = opts.profile ?? loadAppProfile(resolvePath('config/apps/corebank-servicing.yaml'));
  const policy = opts.policy ?? Policy.fromFile(resolvePath(policyPathFor(profile, 'config/policy.json')));
  const store = opts.store ?? new CapabilityStore(resolvePath('capabilities'));
  const port = opts.port ?? Number(process.env.PANEL_PORT ?? 4200);
  const catalog = new Catalog(store, profile.product);

  // Which install a request means when it does not say. The first tenant in the
  // profile, rather than a hard-coded "base": that name belongs to one product
  // and defaulting to it against another is how a panel ends up reporting runs
  // against a tenant that does not exist.
  const defaultTenantId = profile.tenants[0]?.id ?? 'base';

  /**
   * Durable if a database is configured, in-memory if not.
   *
   * Connected before any route is mounted so no request can observe the store
   * half-initialised, and tolerant of an unreachable database: losing run
   * history is a much smaller failure than a control panel that will not boot.
   */
  runStore = (await connectRunStore()) ?? new MemoryRunStore();

  /**
   * In-process mirror of the irreversible-authorisation audit, kept so
   * `/api/v1/audit/irreversible` answers without a round trip. The store is the
   * record of truth; this is a cache of it for the current process.
   */
  const irreversibleAuthorizations: Record<string, unknown>[] = [];

  // The real broker and the real console: a run escalated from the panel is
  // handed to a person on the same live session, not a simulation of one.
  const attached: AttachedConsole = await connectToOperatorConsole(
    opts.operatorPort !== undefined ? { port: opts.operatorPort } : {},
  );

  const app = express();
  app.use(express.json());
  app.disable('x-powered-by');

  /**
   * The React front end, and the reason there is still a second one.
   *
   * `/` serves the built bundle; `/legacy` serves the original single-file
   * panel. That is not indecision — the vanilla page needs no build step, no
   * `node_modules` and no bundler, so it works when the React app cannot. A demo
   * that can be lost to a failed `vite build` is a worse demo than one with a
   * plainer fallback, and the fallback costs nothing to keep: it reads the same
   * routes as everything else.
   */
  const uiDist = join(here, 'ui-dist');
  const uiBuilt = existsSync(join(uiDist, 'index.html'));

  app.get('/legacy', (_req, res) => {
    res.type('html').send(readFileSync(join(here, 'panel.html'), 'utf8'));
  });

  if (uiBuilt) {
    app.use(express.static(uiDist, { index: false }));
  }

  app.get('/', (_req, res) => {
    if (uiBuilt) {
      res.type('html').send(readFileSync(join(uiDist, 'index.html'), 'utf8'));
      return;
    }
    // Say what to run, rather than 404ing on the front page.
    res.type('html').send(
      `<!doctype html><meta charset="utf-8"><title>Automation Control Panel</title>
       <style>body{font:15px/1.6 system-ui,sans-serif;margin:0;padding:3rem;max-width:44rem}
              code{background:#eee;padding:.15em .4em;border-radius:3px}</style>
       <h1>The React interface has not been built yet</h1>
       <p>Run <code>npm run build:ui</code> and reload this page.</p>
       <p>Everything still works meanwhile — the API is up, and the original
          single-file panel is at <a href="/legacy">/legacy</a>.</p>`,
    );
  });

  /* ------------------------------------------------------------ catalog */

  app.get('/api/catalog', (_req, res) => {
    let cards: CapabilityCard[] = [];
    let error: string | null = null;
    try {
      cards = catalog.list();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    res.json({
      capabilities: cards,
      tenants: profile.tenants.map((t) => ({
        id: t.id,
        label: t.label,
        baseUrl: t.baseUrl,
        productVersion: t.productVersion,
        /** Which env vars this install signs on with — names only, never values. */
        credentialEnv: t.credentialEnv ?? profile.auth.credentialEnv,
        extraConditions: t.extraConditions.map((c) => c.id),
      })),
      product: profile.product,
      defaultTenant: defaultTenantId,
      /**
       * What the chat pane offers before anyone types, for THIS product.
       *
       * Served rather than held in the front end because two panels share one
       * bundle: the openers are a property of the console being driven and of
       * the people who use it, not of the React app. See `chat:` in the profile.
       */
      chat: {
        ...(profile.chat.audience ? { audience: profile.chat.audience } : {}),
        suggestions: profile.chat.suggestions,
      },
      /**
       * Named operator identities this product declares. Names only — the panel
       * shows which env vars each resolves to, never a value, for the same
       * reason the profile commits names and not credentials.
       */
      identities: Object.entries(profile.identities).map(([id, env]) => ({
        id,
        credentialEnv: env,
      })),
      /** The faults the harness can produce on this product, for the dropdown. */
      faults: availableFaults(profile),
      operatorUrl: attached.console.url,
      // What discovery would use if started right now. Surfaced so the goal form
      // can say which model is about to drive the browser, and warn before a run
      // rather than after a browser launch that there is no key.
      provider: {
        name: defaultProviderName(),
        live: hasLiveProviderConfigured(),
        describe: describeProviders(),
        /** Empty unless a second key is configured, in which case: what it falls back to. */
        fallback: describeChainFor(defaultProviderName()),
      },
      error,
    });
  });

  /**
   * Is the target application actually up?
   *
   * The panel does not start it, and a run against an install that is not
   * listening fails several seconds in, inside a browser, as a navigation error.
   * Asking first turns the most likely reason a demo goes wrong into a sentence
   * on screen instead of a stack trace in a log.
   */
  app.get('/api/health', async (_req, res) => {
    const checks = await Promise.all(
      profile.tenants.map(async (t) => {
        // The product's own sign-on path, not a hard-coded "/login". Probing
        // the wrong path reports a perfectly healthy target as unreachable,
        // which is a worse failure than not checking at all: it sends someone
        // debugging the network thirty seconds before a demo.
        const probe = new URL(profile.auth.loginPath, t.baseUrl).toString();
        const up = await fetch(probe, { signal: AbortSignal.timeout(4000) })
          .then((r) => r.ok)
          .catch(() => false);
        return { id: t.id, label: t.label, baseUrl: t.baseUrl, up };
      }),
    );
    res.json({
      tenants: checks,
      allUp: checks.every((c) => c.up),
      // Whether this process could start the target itself. Telling someone to
      // run `npm run app` for a target hosted by somebody else is bad advice.
      selfHosted: profile.tenants.every((t) => new URL(t.baseUrl).hostname === 'localhost'),
      /**
       * Which run store is live. Surfaced because "memory" is a real operating
       * state with a real consequence — run history and the irreversible-auth
       * audit do not survive a restart — and that should be visible rather than
       * discovered after the restart that lost them.
       */
      runStore: runStore.backend,
    });
  });

  /** The capability set as agent function-calling definitions — `catalog tools`. */
  app.get('/api/tools', (_req, res) => {
    res.json({ tools: catalog.tools() });
  });

  /**
   * Approve a capability.
   *
   * Approval is a real gate — it is half of what permits an unattended
   * irreversible step — so it is deliberately its own action rather than a
   * checkbox on the discovery form. Compiling never approves; a person reads the
   * artifact and then says yes.
   */
  app.post('/api/capabilities/:name/approve', (req, res) => {
    const ref = String(req.params.name);
    const approve = (req.body as { approved?: boolean })?.approved ?? true;
    try {
      const capability = store.load(ref);
      capability.metadata.approval = approve ? 'approved' : 'draft';
      store.save(capability);
      res.json({ card: cardOf(capability) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Interventions currently waiting for a human.
   *
   * The panel learns about an escalation from the run's own event stream, which
   * is timelier. This is here for the case that stream cannot cover: a run
   * started before the page was opened, or a browser reloaded while a session
   * sits parked.
   */
  app.get('/api/interventions', (_req, res) => {
    res.json({
      open: attached.sink.list(),
      resolved: attached.sink.resolved().map((r) => ({ id: r.request.id, resolution: r.outcome.resolution })),
      operatorUrl: attached.console.url,
    });
  });

  /**
   * Claim, drive and hand back a parked session from the panel's own origin.
   *
   * The same broker and the same transport the standalone console on port 4100
   * uses — mounted here so the chat UI's escalation modal can take control
   * without sending the person to a second page on a second origin. A human who
   * is already watching a run stop should not have to go and find the console
   * for it; the control transfer is the moment the system is most likely to be
   * abandoned, and every extra hop is a chance to lose it.
   *
   * The list route stays the panel's own, above: it carries the console URL that
   * the status badge and the legacy page both read.
   */
  mountInterventionApi(app, attached.sink, { includeList: false });

  /**
   * The guardrails, verbatim from the same config the engine enforces. Rendering
   * policy from a second, hand-maintained copy would be worse than not showing
   * it at all — a safety page that can drift out of agreement with the safety
   * layer is an actively misleading artifact.
   */
  app.get('/api/policy', (_req, res) => {
    res.json(policy.config);
  });

  /* ------------------------------------------------------------ evidence */

  app.get('/api/evidence', (_req, res) => {
    res.json({ runs: listEvidenceDirs().map(evidenceSummary).reverse() });
  });

  /**
   * Serves a file out of the evidence tree by relative path.
   *
   * The path arrives as a query parameter rather than as route segments because
   * panel runs live one level down (`runs/<id>/…`), and a `:dir/:file` route
   * cannot express that. It is checked for containment after resolution, not
   * before — the only check that survives `..`, symlinks and encoding tricks.
   */
  app.get('/api/evidence-file', (req, res) => {
    const rel = String(req.query.path ?? '');
    const target = rel ? evidencePathOf(rel) : null;
    if (!target || !statSync(target).isFile()) {
      res.status(404).json({ error: 'no such evidence file' });
      return;
    }
    if (target.endsWith('.png')) res.type('image/png');
    else if (target.endsWith('.json')) res.type('application/json');
    else res.type('text/plain');
    res.send(readFileSync(target));
  });

  /* ---------------------------------------------------------------- runs */

  app.get('/api/runs', async (_req, res) => {
    const live = [...runs.values()]
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        capability: r.capability,
        goal: r.goal ?? null,
        tenant: r.tenant,
        identity: r.identity ?? null,
        fault: r.fault ?? null,
        viaChat: r.viaChat ?? false,
        startedAt: r.startedAt,
        state: r.state,
        status: r.result?.status ?? null,
        // The business-outcome code, so run history distinguishes "the app
        // said no" from "the app said no differently" without opening a run.
        code: r.result?.status === 'business_outcome' ? r.result.code : null,
        evidenceDir: r.evidenceDir,
        /** False for a run recovered from the store: its live stream is gone. */
        live: true,
      }))
      .reverse();

    // Runs from earlier processes, which exist only in the store. Merged rather
    // than concatenated: a run this process started is already in `live` with
    // its event buffer intact, and the stored copy of it would be a duplicate
    // row that cannot be streamed.
    const known = new Set(live.map((r) => r.id));
    let historical: typeof live = [];
    try {
      historical = (await runStore.listRuns(200))
        .filter((r) => !known.has(r.id))
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          capability: r.capability,
          goal: r.goal ?? null,
          tenant: r.tenant ?? '',
          identity: r.identity ?? null,
          fault: r.fault ?? null,
          viaChat: r.viaChat ?? false,
          startedAt: r.startedAt,
          state: r.state === 'failed' ? ('error' as RunState) : (r.state as RunState),
          status: (r.result as ReplayResult | undefined)?.status ?? null,
          code:
            (r.result as ReplayResult | undefined)?.status === 'business_outcome'
              ? (r.result as Extract<ReplayResult, { status: 'business_outcome' }>).code
              : null,
          evidenceDir: r.evidenceDir,
          live: false,
        }));
    } catch {
      // History is a convenience; the live list is the part that must render.
    }

    res.json({ runs: [...live, ...historical], backend: runStore.backend });
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'no such run' });
      return;
    }
    res.json({
      id: run.id,
      kind: run.kind,
      state: run.state,
      events: run.events,
      result: run.result ?? null,
      discovered: run.discovered ?? null,
      crash: run.crash ?? null,
      evidenceDir: run.evidenceDir,
    });
  });

  /** Live event stream for a run in progress. */
  app.get('/api/runs/:id/stream', (req: Request, res: Response) => {
    const run = runs.get(String(req.params.id));
    if (!run) {
      res.status(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Replay what already happened, so a late subscriber sees the whole run.
    for (const e of run.events) res.write(`event: step\ndata: ${JSON.stringify(e)}\n\n`);
    if (run.state !== 'running') {
      res.write(`event: done\ndata: ${JSON.stringify({ result: run.result ?? null, crash: run.crash ?? null })}\n\n`);
      res.end();
      return;
    }
    run.subscribers.add(res);
    req.on('close', () => run.subscribers.delete(res));
  });

  /**
   * Launches a replay and registers it as a watchable run.
   *
   * The single place a replay is started in this process. The panel's own form,
   * the agent-facing API and the chatbot all come through here, which is what
   * makes them the same system rather than three: identical guardrails,
   * identical evidence directory, identical result contract, and — the part
   * that matters for a demo — every run appears in the dashboard's history and
   * streams its steps live, no matter which door it came in by.
   *
   * Returns immediately with a run id. `done` resolves when the run finishes,
   * so a caller that wants the synchronous contract (the API) can await it while
   * a caller that wants to watch (the panel) can subscribe instead.
   */
  function beginReplay(args: {
    capability: Capability;
    params: Record<string, string>;
    tenantId: string;
    identity?: string;
    armed?: ArmedFault;
    faultName?: string;
    authorizeIrreversible: boolean;
    viaChat?: boolean;
  }): { id: string; evidenceDir: string; done: Promise<ReplayResult> } {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const recorder = new RunRecorder(id, 'replay', join('evidence', PANEL_RUNS_SUBDIR), {
      consoleEcho: false,
      onEvent: (e) => {
        const r = runs.get(id);
        if (r) emitStep(r, e);
      },
    });

    const run: PanelRun = {
      id,
      kind: 'replay',
      capability: `${args.capability.metadata.name}@${args.capability.metadata.version}`,
      tenant: args.tenantId,
      ...(args.identity ? { identity: args.identity } : {}),
      ...(args.faultName ? { fault: args.faultName } : {}),
      ...(args.viaChat ? { viaChat: true } : {}),
      params: args.params,
      startedAt: new Date().toISOString(),
      state: 'running',
      events: [],
      evidenceDir: recorder.dir,
      subscribers: new Set(),
      listeners: new Set(),
    };
    runs.set(id, run);
    persistRun(run);

    const done = (async (): Promise<ReplayResult> => {
      try {
        if (args.armed?.via === 'endpoint') await args.armed.arm();
        const result = await replay({
          capability: args.capability,
          params: args.params,
          tenantId: args.tenantId,
          profile,
          policy,
          recorder,
          sink: attached.sink,
          ...(args.identity ? { identity: args.identity } : {}),
          ...(args.armed?.via === 'surface' ? { fault: args.armed.fault } : {}),
          authorizeIrreversible: args.authorizeIrreversible,
          headful: Boolean(opts.headful),
        });
        recorder.finish(result, renderReplaySummary(result));
        run.result = result;
        run.state = 'done';
        persistRun(run);
        push(run, 'done', { result, crash: null });
        return result;
      } catch (err) {
        run.crash = err instanceof Error ? err.message : String(err);
        run.state = 'error';
        persistRun(run);
        push(run, 'done', { result: null, crash: run.crash });
        throw err;
      } finally {
        // Only the endpoint strategy leaves a global switch to reset; a
        // session-scoped fault dies with the browser context.
        if (args.armed?.via === 'endpoint') await args.armed.disarm();
        for (const res2 of run.subscribers) {
          try {
            res2.end();
          } catch {
            /* subscriber already gone */
          }
        }
        run.subscribers.clear();
      }
    })();

    // Nobody may be awaiting this — the panel form fires and watches the stream
    // instead — and an unhandled rejection would take the process down mid-demo.
    done.catch(() => undefined);

    return { id, evidenceDir: run.evidenceDir, done };
  }

  /**
   * Validates an invocation before anything is launched.
   *
   * Shared by the panel form and the agent-facing API so a malformed member id
   * costs milliseconds and returns a precise complaint from both, rather than a
   * browser start and a checkpoint timeout from one of them.
   */
  function prepareInvocation(input: {
    capability?: string;
    tenant?: string;
    identity?: string;
    fault?: string;
  }): { capability: Capability; tenantId: string; identity?: string; armed?: ArmedFault } {
    const tenantId = String(input.tenant ?? defaultTenantId);
    const tenant = tenantOf(profile, tenantId);
    const capability = store.load(String(input.capability ?? ''));

    // The product check belongs here, not only in `Catalog.invoke`, because the
    // API and the panel form reach `beginReplay` directly. Replaying one
    // vendor's recording against another's console is not a near miss that might
    // work — it is a locator failure several page loads in, reported for reasons
    // that have nothing to do with what the caller asked.
    const recorded = capability.metadata.app.product;
    if (recorded !== profile.product) {
      throw new Error(
        `"${capability.metadata.name}" was recorded against "${recorded}", but this panel is ` +
          `pointed at "${profile.product}". Start it with that product's profile to invoke it.`,
      );
    }

    const identity = input.identity ? String(input.identity) : undefined;
    if (identity && !profile.identities[identity]) {
      const known = Object.keys(profile.identities);
      throw new Error(
        `unknown identity "${identity}" for product "${profile.product}". ` +
          `Known identities: ${known.length ? known.join(', ') : '(none declared)'}.`,
      );
    }

    return {
      capability,
      tenantId,
      ...(identity ? { identity } : {}),
      ...(input.fault ? { armed: planFault(profile, tenant, String(input.fault)) } : {}),
    };
  }

  /**
   * Start a replay from the panel form. Fire-and-watch: the caller subscribes to
   * the event stream rather than holding a request open for a browser session.
   */
  app.post('/api/replay', (req, res) => {
    const body = req.body as {
      capability?: string;
      tenant?: string;
      identity?: string;
      params?: Record<string, string>;
      authorizeIrreversible?: boolean;
      fault?: string;
    };
    const params = body.params ?? {};

    let prepared;
    try {
      prepared = prepareInvocation(body);
      validateInputs(prepared.capability, params);
    } catch (err) {
      if (err instanceof CapabilityInputError) {
        res.status(400).json({ error: 'invalid_arguments', problems: err.problems });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const started = beginReplay({
      ...prepared,
      params,
      ...(body.fault ? { faultName: String(body.fault) } : {}),
      authorizeIrreversible: Boolean(body.authorizeIrreversible),
    });

    res.status(202).json({ runId: started.id, evidenceDir: started.evidenceDir });
  });

  /**
   * Launches a discovery run and registers it as a watchable run.
   *
   * The discovery counterpart to `beginReplay`, and factored out for the same
   * reason: there are now two callers. The panel's goal form is one; the
   * chatbot's `discover_capability` fallback — what it reaches for when no
   * recorded capability fits the request — is the other. Both must produce a run
   * that appears in history, streams its steps, and writes the same evidence, or
   * "the agent worked it out live" becomes a different kind of event from "the
   * agent replayed a recording", which is exactly the comparison worth showing.
   *
   * Returns immediately with a run id. `done` resolves to the compiled card, or
   * to null when the run did not reach the goal — because a capability is a
   * promise that a flow works, and a run that did not complete is not evidence
   * that it does.
   */
  function beginDiscovery(args: {
    goal: string;
    tenantId: string;
    params: Record<string, string>;
    entryUrl: string;
    provider: ReturnType<typeof createProvider>;
    switchLog?: SwitchLog;
    maxSteps?: number;
    name?: string;
    viaChat?: boolean;
  }): {
    id: string;
    evidenceDir: string;
    done: Promise<{ discovered: DiscoveredCapability | null; outcome: unknown; crash?: string }>;
  } {
    const tenant = tenantOf(profile, args.tenantId);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const recorder = new RunRecorder(id, 'discovery', join('evidence', PANEL_RUNS_SUBDIR), {
      consoleEcho: false,
      onEvent: (e) => {
        const r = runs.get(id);
        if (r) emitStep(r, e);
      },
    });
    // The provider was built during request validation, before this recorder
    // existed. Piping now replays anything it already buffered, so a failover
    // on the first call still lands in the run's evidence and streams to the UI.
    args.switchLog?.pipeTo((s) => recorder.event('model_provider_switched', { ...s }));

    const run: PanelRun = {
      id,
      kind: 'discovery',
      capability: `(discovering) ${args.provider.name}:${args.provider.model}`,
      goal: args.goal,
      tenant: args.tenantId,
      ...(args.viaChat ? { viaChat: true } : {}),
      params: args.params,
      startedAt: new Date().toISOString(),
      state: 'running',
      events: [],
      evidenceDir: recorder.dir,
      subscribers: new Set(),
      listeners: new Set(),
    };
    runs.set(id, run);
    persistRun(run);

    const done = (async () => {
      const { discover } = await import('../discovery/loop.js');
      const { compile } = await import('../discovery/trace-compiler.js');
      const { ControlAuthority } = await import('../escalation/control-authority.js');
      const { PlaywrightSurface } = await import('../surface/web/playwright-surface.js');

      const authority = new ControlAuthority(id);
      let surface;
      try {
        surface = await PlaywrightSurface.launch({
          policy,
          authority,
          mode: 'discovery',
          headful: Boolean(opts.headful),
          onEvent: (e) => recorder.event(`surface_${e.kind}`, e.detail),
        });

        const trace = await discover({
          goalTemplate: args.goal,
          params: args.params,
          entryUrl: args.entryUrl,
          product: profile.product,
          tenant: tenant.id,
          profile,
          tenantProfile: tenant,
          provider: args.provider,
          surface,
          authority,
          recorder,
          allowedOrigins: policy.config.origins,
          allowedActions: policy.config.actions,
          irreversibleControls: policy.irreversibleControlNames(),
          sink: attached.sink,
          ...(args.maxSteps ? { maxSteps: args.maxSteps } : {}),
        });

        const traceRef = recorder.snapshot('trace', trace);

        if (trace.outcome.kind !== 'success') {
          // No artifact. A capability is a promise that a flow works, and this
          // run is not evidence that it does.
          run.discovered = null;
          run.state = 'done';
          persistRun(run);
          recorder.finish(trace, renderDiscoverySummary(trace, null));
          push(run, 'done', { discovered: null, outcome: trace.outcome, evidenceDir: run.evidenceDir });
          return { discovered: null, outcome: trace.outcome };
        }

        const capability = compile({ trace, profile, traceRef, ...(args.name ? { name: args.name } : {}) });
        const path = store.save(capability);
        recorder.finish(trace, renderDiscoverySummary(trace, capability));

        const discovered = {
          card: cardOf(capability),
          // Relative to the repo: an absolute Windows path in a browser is noise,
          // and the point of showing it is "this is a file you can open and diff".
          path: relativeToCwd(path),
          steps: trace.steps.length,
          modelCalls: trace.usage.calls,
        };
        run.discovered = discovered;
        run.state = 'done';
        persistRun(run);
        push(run, 'done', { discovered, outcome: trace.outcome, evidenceDir: run.evidenceDir });
        return { discovered, outcome: trace.outcome };
      } catch (err) {
        run.crash = err instanceof Error ? err.message : String(err);
        run.state = 'error';
        persistRun(run);
        push(run, 'done', { discovered: null, crash: run.crash });
        return { discovered: null, outcome: { kind: 'stopped', why: run.crash }, crash: run.crash };
      } finally {
        await surface?.close().catch(() => {});
        for (const res2 of run.subscribers) {
          try {
            res2.end();
          } catch {
            /* subscriber already gone */
          }
        }
        run.subscribers.clear();
      }
    })();

    // Nobody may be awaiting this — the panel form fires and watches the stream
    // instead — and an unhandled rejection would take the process down mid-demo.
    done.catch(() => undefined);

    return { id, evidenceDir: run.evidenceDir, done };
  }

  /**
   * Validates a discovery request the way `prepareInvocation` validates a replay.
   *
   * Shared by the goal form and the chatbot's discovery fallback, so an
   * unresolved `{{reference}}` or an off-allowlist target URL costs milliseconds
   * and returns the same precise complaint from both.
   */
  function prepareDiscovery(body: {
    goal?: string;
    tenant?: string;
    params?: Record<string, string>;
    targetUrl?: string;
    provider?: string;
    model?: string;
  }): {
    goal: string;
    tenantId: string;
    params: Record<string, string>;
    entryUrl: string;
    provider: ReturnType<typeof createProvider>;
    switchLog: SwitchLog;
  } {
    const goal = String(body.goal ?? '').trim();
    const tenantId = String(body.tenant ?? defaultTenantId);
    const params = body.params ?? {};

    if (!goal) {
      throw new CapabilityInputError(['a goal is required — describe the task in plain language']);
    }

    // Every {{reference}} in the goal must have a value, or the model is handed a
    // literal "{{memberId}}" to type into a form. Caught here rather than three
    // screens into a run.
    const missing = [...goal.matchAll(/\{\{([^}]+)\}\}/g)]
      .map((m) => m[1]!.trim())
      .filter((n) => !params[n]);
    if (missing.length) {
      throw new CapabilityInputError(
        missing.map((n) => `the goal references {{${n}}} but no value was supplied for it`),
      );
    }

    const tenant = tenantOf(profile, tenantId);
    // The containment boundary, checked before a browser exists. A caller-supplied
    // target URL is structurally a request to point the automation somewhere new,
    // which is exactly what the allowlist is for.
    const entryUrl = resolveEntryUrl(policy, tenant, body.targetUrl);
    const switchLog = new SwitchLog();
    const provider = createProvider(body.provider ?? defaultProviderName(), {
      ...(body.model ? { model: body.model } : {}),
      scriptedParams: params,
      onSwitch: (s) => switchLog.record(s),
    });

    return { goal, tenantId, params, entryUrl, provider, switchLog };
  }

  /**
   * Start a discovery run: a goal in natural language, driven by a model.
   *
   * This is the same `discover()` the CLI calls, with the same policy, the same
   * surface and the same compiler — the panel supplies the goal and watches. The
   * one thing it adds is that a successful run's artifact comes straight back to
   * the browser as a card, so recording and reviewing are one motion instead of
   * a command followed by "now open this file".
   */
  app.post('/api/discover', (req, res) => {
    const body = req.body as {
      goal?: string;
      tenant?: string;
      params?: Record<string, string>;
      targetUrl?: string;
      provider?: string;
      model?: string;
      maxSteps?: number;
      name?: string;
    };

    let prepared;
    try {
      prepared = prepareDiscovery(body);
    } catch (err) {
      if (err instanceof CapabilityInputError) {
        res.status(400).json({ error: 'invalid_arguments', problems: err.problems });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const started = beginDiscovery({
      ...prepared,
      ...(body.maxSteps ? { maxSteps: Number(body.maxSteps) } : {}),
      ...(body.name ? { name: String(body.name) } : {}),
    });

    res.status(202).json({
      runId: started.id,
      evidenceDir: started.evidenceDir,
      provider: `${prepared.provider.name}:${prepared.provider.model}`,
      targetUrl: prepared.entryUrl,
    });
  });


  /* -------------------------------------------- agent-facing surfaces */

  // Both compose the same launcher the panel form uses, so a run started by an
  // agent or by the chatbot appears in this dashboard's history and streams its
  // steps live — and is subject to the identical guardrails. The wrapper adds
  // doors, not privileges.
  const apiDeps = {
    catalog,
    profile,
    defaultTenantId,
    prepareInvocation,
    beginReplay,
    operatorUrl: attached.console.url,
    onAuthorizedIrreversible: (detail: Record<string, unknown>) => {
      // Explicit authorisation of an irreversible effect is exactly the event an
      // audit wants, so it is logged where the panel can show it rather than
      // vanishing into a request handler.
      irreversibleAuthorizations.push(detail);
      // Also written durably. This is the one store where losing a row is a
      // compliance problem rather than an inconvenience: it records that a
      // human authorised something irreversible, and "the process restarted"
      // is not an acceptable answer to who approved a posted transfer.
      void runStore
        .recordAuthorization({
          capability: String(detail.capability ?? ''),
          tenant: String(detail.tenant ?? ''),
          identity: detail.identity === null || detail.identity === undefined ? null : String(detail.identity),
          at: String(detail.at ?? new Date().toISOString()),
        })
        .catch((err: unknown) => {
          console.warn(`  ! could not persist authorisation: ${err instanceof Error ? err.message : String(err)}`);
        });
      console.log(`[audit] irreversible authorised via API: ${JSON.stringify(detail)}`);
    },
  };
  mountCapabilityApi(app, apiDeps);
  mountChat(app, {
    ...apiDeps,
    createProvider: () => createProvider(defaultProviderName()),
    providerConfigured: hasLiveProviderConfigured,
    // The fallback for "no recorded capability does this". Same loop, same
    // policy, same compiler as the goal form — the chatbot supplies the goal.
    prepareDiscovery,
    beginDiscovery,
    watchRun: (runId, onEvent) => {
      const run = runs.get(runId);
      if (!run) return () => undefined;
      // Events already buffered, then live ones. A caller that subscribes a tick
      // after the run started must not miss the escalation that happened in it.
      for (const e of run.events) onEvent(e);
      return subscribeToRun(runId, onEvent);
    },
  });

  /** Every irreversible authorisation this process has seen. Read-only view. */
  app.get('/api/v1/audit/irreversible', (_req, res) => {
    res.json({ authorizations: irreversibleAuthorizations });
  });

  const server: Server = await new Promise((resolveServer, reject) => {
    const s = app.listen(port, () => resolveServer(s));
    s.on('error', reject);
  });

  // The live-session screencast, on the panel's own origin so the chat modal can
  // open it without a cross-origin WebSocket.
  const closeBridge = attachSessionBridge(server, attached.sink, '/ws/session');

  return {
    url: `http://localhost:${port}`,
    operatorUrl: attached.console.url,
    close: async () => {
      closeBridge();
      await new Promise<void>((r) => server.close(() => r()));
      await attached.close().catch(() => {});
      // Released last: writes are fire-and-forget, so closing the connection
      // before the server has stopped accepting requests would drop the tail of
      // a run that was still finishing.
      await runStore.close().catch(() => {});
    },
  };
}

