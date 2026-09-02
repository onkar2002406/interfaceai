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
import { dirname, join, resolve as resolvePath, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { Catalog, CapabilityInputError, type CapabilityCard } from '../capability/catalog.js';
import { CapabilityStore } from '../capability/store.js';
import { loadAppProfile, tenantOf, type AppProfile } from '../capability/application-profile.js';
import { Policy } from '../policy/guardrails.js';
import { RunRecorder, type RunEvent } from '../observability/run-recorder.js';
import { replay, validateInputs } from '../replay/executor.js';
import type { ReplayResult } from '../replay/replay-result.js';
import { renderReplaySummary } from '../cli/run-reports.js';
import { connectToOperatorConsole, type AttachedConsole } from '../escalation/operator/console-client.js';

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

interface PanelRun {
  id: string;
  capability: string;
  tenant: string;
  params: Record<string, string>;
  startedAt: string;
  state: RunState;
  events: RunEvent[];
  result?: ReplayResult;
  /** Set only when the run threw rather than returning a result contract. */
  crash?: string;
  evidenceDir: string;
  subscribers: Set<Response>;
}

const runs = new Map<string, PanelRun>();

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
  /** Show the browser window for runs started from the panel. */
  headful?: boolean;
}

export async function startControlPanel(opts: ControlPanelOptions = {}): Promise<ControlPanel> {
  const profile = opts.profile ?? loadAppProfile(resolvePath('config/apps/corebank-servicing.yaml'));
  const policy = opts.policy ?? Policy.fromFile(resolvePath('config/policy.json'));
  const store = opts.store ?? new CapabilityStore(resolvePath('capabilities'));
  const port = opts.port ?? Number(process.env.PANEL_PORT ?? 4200);
  const catalog = new Catalog(store);

  // The real broker and the real console: a run escalated from the panel is
  // handed to a person on the same live session, not a simulation of one.
  const attached: AttachedConsole = await connectToOperatorConsole();

  const app = express();
  app.use(express.json());
  app.disable('x-powered-by');

  app.get('/', (_req, res) => {
    res.type('html').send(readFileSync(join(here, 'panel.html'), 'utf8'));
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
      operatorUrl: attached.console.url,
      error,
    });
  });

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

  app.get('/api/runs', (_req, res) => {
    res.json({
      runs: [...runs.values()]
        .map((r) => ({
          id: r.id,
          capability: r.capability,
          tenant: r.tenant,
          startedAt: r.startedAt,
          state: r.state,
          status: r.result?.status ?? null,
          evidenceDir: r.evidenceDir,
        }))
        .reverse(),
    });
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'no such run' });
      return;
    }
    res.json({
      id: run.id,
      state: run.state,
      events: run.events,
      result: run.result ?? null,
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
   * Start a replay.
   *
   * Arguments are validated before anything is launched, so a malformed member
   * id comes back as a 400 with a precise complaint rather than a browser start
   * and a checkpoint timeout — the same fail-fast the catalog gives an agent.
   */
  app.post('/api/replay', (req, res) => {
    const body = req.body as {
      capability?: string;
      tenant?: string;
      params?: Record<string, string>;
      authorizeIrreversible?: boolean;
      fault?: string;
    };
    const name = String(body.capability ?? '');
    const tenantId = String(body.tenant ?? 'base');
    const params = body.params ?? {};

    let capability;
    try {
      capability = store.load(name);
      tenantOf(profile, tenantId);
      validateInputs(capability, params);
    } catch (err) {
      if (err instanceof CapabilityInputError) {
        res.status(400).json({ error: 'invalid_arguments', problems: err.problems });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const recorder = new RunRecorder(id, 'replay', join('evidence', PANEL_RUNS_SUBDIR), {
      consoleEcho: false,
      onEvent: (e) => {
        const run = runs.get(id);
        if (!run) return;
        run.events.push(e);
        push(run, 'step', e);
      },
    });

    const run: PanelRun = {
      id,
      capability: `${capability.metadata.name}@${capability.metadata.version}`,
      tenant: tenantId,
      params,
      startedAt: new Date().toISOString(),
      state: 'running',
      events: [],
      evidenceDir: recorder.dir,
      subscribers: new Set(),
    };
    runs.set(id, run);

    void (async () => {
      try {
        if (body.fault) await armFault(tenantOf(profile, tenantId).baseUrl, body.fault);
        const result = await replay({
          capability,
          params,
          tenantId,
          profile,
          policy,
          recorder,
          sink: attached.sink,
          authorizeIrreversible: Boolean(body.authorizeIrreversible),
          headful: Boolean(opts.headful),
        });
        recorder.finish(result, renderReplaySummary(result));
        run.result = result;
        run.state = 'done';
        push(run, 'done', { result, crash: null });
      } catch (err) {
        run.crash = err instanceof Error ? err.message : String(err);
        run.state = 'error';
        push(run, 'done', { result: null, crash: run.crash });
      } finally {
        if (body.fault) await armFault(tenantOf(profile, tenantId).baseUrl, 'none').catch(() => {});
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

    res.status(202).json({ runId: id, evidenceDir: run.evidenceDir });
  });

  const server: Server = await new Promise((resolveServer, reject) => {
    const s = app.listen(port, () => resolveServer(s));
    s.on('error', reject);
  });

  return {
    url: `http://localhost:${port}`,
    operatorUrl: attached.console.url,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await attached.close().catch(() => {});
    },
  };
}

/**
 * Arms a runtime fault on the target app, for demonstrating the error paths.
 *
 * Deliberately over plain HTTP from the panel process, never through the browser
 * surface: `/_admin/**` is on the policy DENY list precisely so the automation
 * cannot reach its own test hooks. The harness may arm faults; the agent may not.
 */
const FAULT_ROUTES: Record<string, string> = {
  slow: '/member/*',
  app_error: '/member/*',
  session: '/member/*',
  interstitial: '/search',
};

async function armFault(baseUrl: string, mode: string): Promise<void> {
  const res = await fetch(`${baseUrl}/_admin/fault`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, times: 1, route: FAULT_ROUTES[mode] }),
  });
  if (!res.ok) throw new Error(`could not arm fault "${mode}": ${res.status}`);
}
