/**
 * The agent-facing capability API.
 *
 * A programmatic surface where an AI agent invokes a capability **by name with
 * typed arguments** and gets a structured result back, without knowing anything
 * about the underlying UI. Under the hood each invocation is the same
 * deterministic replay the CLI runs — no model in the decision loop.
 *
 * Three decisions worth defending:
 *
 * **1. The catalog is a projection, not a second source of truth.** Every route
 * here reads from `Catalog`, which reads the same YAML a human reviewed and
 * approved. There is no hand-maintained API schema to drift out of agreement
 * with what actually replays. A capability's JSON Schema, its declared business
 * outcomes and its irreversibility flag are all *derived* from the artifact.
 *
 * **2. `invoke` is synchronous, and the panel's own `/api/replay` is not.**
 * They are different contracts for different callers rather than duplication: an
 * agent wants one call that returns the answer, and a human watching a demo
 * wants to see the steps arrive. Both go through the identical run launcher, so
 * a run started by an agent still appears in the dashboard's history and still
 * streams its steps live.
 *
 * **3. Irreversible authorisation is a header, not a body field.** This is the
 * load-bearing safety decision in the whole wrapper. `authorizeIrreversible`
 * inside the JSON body would sit in the same object as the capability arguments
 * — which is exactly the object a language model fills in. Putting it in the
 * transport envelope means the chatbot, which composes bodies and not headers,
 * structurally cannot set it. See `chat.ts`.
 *
 * Note what is deliberately NOT here: no endpoint to arm a fault globally, no
 * endpoint to approve a capability without reading it, and no way to reach a
 * route the policy allowlist refuses. The wrapper must not become a way around
 * the guardrails.
 */

import type { Express, Request, Response } from 'express';
import { CapabilityInputError, validateInputs } from '../replay/executor.js';
import type { Catalog } from '../capability/catalog.js';
import type { AppProfile } from '../capability/application-profile.js';
import type { Capability } from '../capability/schema.js';
import type { ArmedFault } from '../target/faults.js';
import type { ReplayResult } from '../replay/replay-result.js';
import { sliceForAgent } from './contract.js';

/** Header a caller must send to permit irreversible effects. Never a body field. */
export const AUTHORIZE_IRREVERSIBLE_HEADER = 'x-authorize-irreversible';

export interface CapabilityApiDeps {
  catalog: Catalog;
  profile: AppProfile;
  defaultTenantId: string;
  /** Validates and resolves an invocation, throwing with a precise complaint. */
  prepareInvocation: (input: {
    capability?: string;
    tenant?: string;
    identity?: string;
    fault?: string;
  }) => { capability: Capability; tenantId: string; identity?: string; armed?: ArmedFault };
  /** The one place a replay is started, shared with the panel and the chatbot. */
  beginReplay: (args: {
    capability: Capability;
    params: Record<string, string>;
    tenantId: string;
    identity?: string;
    armed?: ArmedFault;
    faultName?: string;
    authorizeIrreversible: boolean;
    viaChat?: boolean;
  }) => { id: string; evidenceDir: string; done: Promise<ReplayResult> };
  /** Where a human goes when a run stops for one. */
  operatorUrl: string;
  onAuthorizedIrreversible?: (detail: Record<string, unknown>) => void;
}

export function mountCapabilityApi(app: Express, deps: CapabilityApiDeps): void {
  const { catalog, profile, defaultTenantId } = deps;

  /**
   * The catalog an agent browses before it calls anything.
   *
   * Drafts are listed and flagged rather than hidden. Hiding them would make the
   * catalog lie about what exists, and a draft is still invocable — it simply
   * refuses to take an irreversible step unattended.
   */
  app.get('/api/v1/capabilities', (_req: Request, res: Response) => {
    res.json({
      product: profile.product,
      tenants: profile.tenants.map((t) => ({ id: t.id, label: t.label, productVersion: t.productVersion })),
      identities: Object.keys(profile.identities),
      capabilities: catalog.list(),
    });
  });

  app.get('/api/v1/capabilities/:name', (req: Request, res: Response) => {
    try {
      res.json(catalog.describe(String(req.params.name)));
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * The same set as function-calling tool definitions — what you hand a model.
   *
   * The descriptions spell out the declared business outcomes, because a tool
   * description is the only thing many agents read before choosing, and
   * "returns MEMBER_NOT_FOUND if no such member exists" prevents a whole class
   * of pointless retry loops.
   */
  app.get('/api/v1/tools', (_req: Request, res: Response) => {
    res.json({ tools: catalog.tools() });
  });

  /**
   * Invoke a capability by name. The call an AI agent makes in production.
   *
   * Returns the four-arm contract, and the status code follows it: a business
   * outcome is 200, because the application answered. Returning 4xx for
   * "no such member" would re-introduce, at the transport layer, exactly the
   * conflation the result contract exists to prevent — and every HTTP client in
   * the world would then treat a legitimate answer as an error.
   */
  app.post('/api/v1/invoke', async (req: Request, res: Response) => {
    const body = req.body as {
      capability?: string;
      arguments?: Record<string, string>;
      tenant?: string;
      identity?: string;
      fault?: string;
    };
    const args = body.arguments ?? {};

    let prepared;
    try {
      prepared = deps.prepareInvocation({
        capability: body.capability,
        tenant: body.tenant ?? defaultTenantId,
        ...(body.identity ? { identity: body.identity } : {}),
        ...(body.fault ? { fault: body.fault } : {}),
      });
      // Before a browser starts. A bad member id should cost milliseconds.
      validateInputs(prepared.capability, args);
    } catch (err) {
      if (err instanceof CapabilityInputError) {
        res.status(400).json({ status: 'invalid_arguments', problems: err.problems });
        return;
      }
      res.status(400).json({ status: 'invalid_request', error: err instanceof Error ? err.message : String(err) });
      return;
    }

    // The transport envelope, never the body. See the note at the top of this file.
    const authorizeIrreversible = String(req.get(AUTHORIZE_IRREVERSIBLE_HEADER) ?? '').toLowerCase() === 'true';
    if (authorizeIrreversible) {
      deps.onAuthorizedIrreversible?.({
        capability: prepared.capability.metadata.name,
        tenant: prepared.tenantId,
        identity: prepared.identity ?? null,
        at: new Date().toISOString(),
      });
    }

    try {
      const started = deps.beginReplay({
        ...prepared,
        params: args,
        ...(body.fault ? { faultName: String(body.fault) } : {}),
        authorizeIrreversible,
      });
      const result = await started.done;
      const payload = sliceForAgent(result);
      res.status(200).json({
        ...payload,
        // So an agent (or a person reading curl output) can go and watch the run
        // that produced this, and reach a human if it parked for one.
        watch: `/api/runs/${started.id}`,
        ...(result.status === 'escalated' ? { operatorUrl: deps.operatorUrl } : {}),
      });
    } catch (err) {
      // The run threw rather than returning a contract — the automation itself
      // is broken, which is a different thing from the flow failing, and it is
      // reported as such rather than dressed up as one of the four arms.
      res.status(500).json({
        status: 'engine_error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
