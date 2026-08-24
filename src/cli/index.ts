#!/usr/bin/env node
/**
 * Command-line entry point.
 *
 *   npm run app                       start the target application (all tenants)
 *   npm run discover -- --goal "..."  LLM-driven discovery -> capability artifact
 *   npm run replay   -- --capability  deterministic replay (no model involved)
 *   npm run catalog  -- list          the agent-facing capability catalog
 *   npm run operator                  human-in-the-loop operator console
 */

import 'dotenv/config';
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { startCoreBank } from '../../apps/corebank/start-servers.js';
import { TENANTS } from '../../apps/corebank/tenants.js';
import { loadAppProfile, tenantOf } from '../capability/application-profile.js';
import { CapabilityStore } from '../capability/store.js';
import { Policy } from '../policy/guardrails.js';
import { RunRecorder } from '../observability/run-recorder.js';
import { replay, CapabilityInputError } from '../replay/executor.js';
import type { ReplayResult } from '../replay/replay-result.js';
import { createProvider, defaultProviderName, describeProviders } from '../discovery/llm/provider-registry.js';
import { summarize } from '../replay/replay-result.js';
import { renderDiscoverySummary, renderReplaySummary } from './run-reports.js';

const DEFAULT_PROFILE = 'config/apps/corebank-servicing.yaml';
const DEFAULT_POLICY = 'config/policy.json';
const DEFAULT_CAPABILITIES = 'capabilities';

const program = new Command();
program
  .name('cua')
  .description('Computer-use automation: discover once with a model, replay deterministically forever.')
  .version('1.0.0');

/* -------------------------------------------------------------------- app */

program
  .command('app')
  .description('Start the CoreBank target application (one instance per tenant)')
  .argument('[tenant]', 'start only this tenant (base | firstvalley | harborcu)')
  .action(async (tenant?: string) => {
    const instances = await startCoreBank(tenant ? [tenant] : undefined);
    console.log('CoreBank Servicing Console — same vendor product, three institutions:\n');
    for (const i of instances) {
      const t = TENANTS[i.tenantId]!;
      console.log(`  ${i.baseUrl.padEnd(24)} ${t.institutionName} (CoreBank v${t.productVersion})`);
    }
    console.log('\nSign on with svc.demo / demo1234. Ctrl+C to stop.');
  });

/* --------------------------------------------------------------- discover */

program
  .command('discover')
  .description('Drive the target application with an LLM to work out how a goal is achieved, then compile the successful run into a capability artifact.')
  .requiredOption('-g, --goal <text>', 'goal in natural language; may use {{param}} references')
  .option('-p, --param <key=value...>', 'value to supply for a {{param}} (repeatable)', collectInputs, {})
  .option('-t, --tenant <id>', 'tenant to record against', 'base')
  .option('--provider <name>', `groq | openai | scripted — ${describeProviders()}`, process.env.LLM_PROVIDER)
  .option('--model <name>', 'override the provider default model')
  .option('--max-steps <n>', 'stop after this many model turns', '20')
  .option('--name <slug>', 'override the compiled capability name')
  .option('--headful', 'show the browser window', false)
  .option('--operator', 'attach an operator console so a stuck discovery run can escalate', false)
  .option('--profile <path>', 'app profile', DEFAULT_PROFILE)
  .option('--policy <path>', 'policy config', DEFAULT_POLICY)
  .option('--capabilities <dir>', 'capability store directory', DEFAULT_CAPABILITIES)
  .action(async (opts) => {
    const profile = loadAppProfile(resolvePath(opts.profile));
    const policy = Policy.fromFile(resolvePath(opts.policy));
    const store = new CapabilityStore(resolvePath(opts.capabilities));
    const tenant = tenantOf(profile, opts.tenant);

    const { discover } = await import('../discovery/loop.js');
    const { compile } = await import('../discovery/trace-compiler.js');
    const { ControlAuthority } = await import('../escalation/control-authority.js');
    const { PlaywrightSurface } = await import('../surface/web/playwright-surface.js');

    // No provider named: use whichever key is actually configured. Defaulting to
    // a provider whose key is missing fails three seconds into a browser launch,
    // which is a needlessly confusing way to say "set your key".
    const providerName = opts.provider ?? defaultProviderName();
    const provider = createProvider(providerName, {
      ...(opts.model ? { model: opts.model } : {}),
      scriptedParams: opts.param,
    });

    const runId = randomUUID().slice(0, 8);
    const recorder = new RunRecorder(runId, 'discovery');

    let attached;
    if (opts.operator) {
      const { connectToOperatorConsole } = await import('../escalation/operator/console-client.js');
      attached = await connectToOperatorConsole();
      console.log(`Operator console: ${attached.console.url}\n`);
    }

    console.log(
      `Discovering against ${tenant.label} using ${provider.name}:${provider.model}` +
        `${provider.supportsVision ? ' (screenshots sent to the model)' : ' (text inventory only)'}`,
    );
    console.log(`Goal: ${opts.goal}\n`);

    const authority = new ControlAuthority(runId);
    const surface = await PlaywrightSurface.launch({
      policy,
      authority,
      mode: 'discovery',
      headful: Boolean(opts.headful),
      onEvent: (e) => recorder.event(`surface_${e.kind}`, e.detail),
    });

    try {
      const trace = await discover({
        goalTemplate: opts.goal,
        params: opts.param,
        entryUrl: new URL('/', tenant.baseUrl).toString(),
        product: profile.product,
        tenant: tenant.id,
        profile,
        tenantProfile: tenant,
        provider,
        surface,
        authority,
        recorder,
        allowedOrigins: policy.config.origins,
        maxSteps: Number(opts.maxSteps),
        ...(attached ? { sink: attached.sink } : {}),
      });

      const traceRef = recorder.snapshot('trace', trace);

      if (trace.outcome.kind !== 'success') {
        console.log(`\nDiscovery did not complete the goal: ${trace.outcome.kind} — ${trace.outcome.why}`);
        console.log('No capability was compiled. An artifact is a promise that a flow works.');
        recorder.finish(trace, renderDiscoverySummary(trace, null));
        console.log(`\nEvidence: ${recorder.dir}`);
        process.exitCode = 1;
        return;
      }

      const capability = compile({ trace, profile, traceRef, ...(opts.name ? { name: opts.name } : {}) });
      const path = store.save(capability);

      recorder.finish(trace, renderDiscoverySummary(trace, capability));

      console.log(`\nDiscovered in ${trace.steps.length} steps (${trace.usage.calls} model calls).`);
      console.log(`Capability written to ${path}`);
      console.log(`\n  name     ${capability.metadata.name}@${capability.metadata.version}`);
      console.log(`  inputs   ${capability.spec.inputs.map((i) => i.name).join(', ') || '(none)'}`);
      console.log(`  outputs  ${capability.spec.outputs.map((o) => `${o.name}: ${o.type}`).join(', ') || '(none)'}`);
      console.log(`  approval ${capability.metadata.approval}  <- review the file, then set to "approved"`);
      console.log(`\nEvidence: ${recorder.dir}`);
    } finally {
      await surface.close();
      if (attached) await attached.close().catch(() => {});
    }
  });

/* ----------------------------------------------------------------- replay */

program
  .command('replay')
  .description('Replay a saved capability deterministically. No LLM is involved.')
  .requiredOption('-c, --capability <ref>', 'capability name, name@version, or path to a .yaml')
  .option('-i, --input <key=value...>', 'input parameter (repeatable)', collectInputs, {})
  .option('-t, --tenant <id>', 'tenant to replay against', 'base')
  .option('--fault <mode>', 'arm a runtime fault first: slow | interstitial | session | app_error')
  .option('--authorize-irreversible', 'explicitly authorise irreversible steps for this invocation', false)
  .option('--headful', 'show the browser window', false)
  .option('--operator', 'attach to a running operator console for escalations', false)
  .option('--profile <path>', 'app profile', DEFAULT_PROFILE)
  .option('--policy <path>', 'policy config', DEFAULT_POLICY)
  .option('--capabilities <dir>', 'capability store directory', DEFAULT_CAPABILITIES)
  .action(async (opts) => {
    const profile = loadAppProfile(resolvePath(opts.profile));
    const policy = Policy.fromFile(resolvePath(opts.policy));
    const store = new CapabilityStore(resolvePath(opts.capabilities));
    const capability = store.load(opts.capability);
    const tenant = tenantOf(profile, opts.tenant);

    if (opts.fault) {
      await armFault(tenant.baseUrl, opts.fault);
      console.log(`Armed fault "${opts.fault}" on ${tenant.label} (${tenant.baseUrl})\n`);
    }

    const runId = randomUUID().slice(0, 8);
    const recorder = new RunRecorder(runId, 'replay');

    console.log(
      `Replaying ${capability.metadata.name}@${capability.metadata.version} against ${tenant.label} ` +
        `(CoreBank v${tenant.productVersion})\n`,
    );

    let attached: Awaited<ReturnType<typeof import('../escalation/operator/console-client.js').connectToOperatorConsole>> | undefined;
    if (opts.operator) {
      const { connectToOperatorConsole } = await import('../escalation/operator/console-client.js');
      attached = await connectToOperatorConsole();
      console.log(`Operator console: ${attached.console.url}`);
      console.log('If this run needs a human, open that URL to take control of the live session.\n');
    }

    try {
      const result = await replay({
        capability,
        params: opts.input,
        tenantId: opts.tenant,
        profile,
        policy,
        recorder,
        headful: Boolean(opts.headful),
        authorizeIrreversible: Boolean(opts.authorizeIrreversible),
        ...(attached ? { sink: attached.sink } : {}),
      });

      const summary = renderReplaySummary(result);
      recorder.finish(result, summary);

      console.log(`\n${summarize(result)}`);
      if (result.status === 'success') {
        console.log(`Outputs: ${JSON.stringify(result.outputs, null, 2)}`);
      }
      if (result.driftSignals.length) {
        console.log(`\nDrift signals (${result.driftSignals.length}) — this tenant may need an override:`);
        for (const d of result.driftSignals) {
          console.log(`  ${d.stepId}: wanted ${d.expected}`);
          console.log(`         matched "${d.matched}" at ${d.score} via ${d.strategy}`);
        }
      }
      console.log(`\nEvidence: ${recorder.dir}`);
      process.exitCode = result.status === 'failed' ? 1 : 0;
    } catch (err) {
      if (err instanceof CapabilityInputError) {
        console.error(`\nInvalid inputs for ${capability.metadata.name}:`);
        for (const p of err.problems) console.error(`  - ${p}`);
        console.error('\nRun `npm run catalog -- describe <name>` to see the input contract.');
        process.exitCode = 2;
        return;
      }
      throw err;
    } finally {
      if (opts.fault) await armFault(tenant.baseUrl, 'none').catch(() => {});
      if (attached) await attached.close().catch(() => {});
    }
  });

/* ---------------------------------------------------------------- catalog */

program
  .command('catalog')
  .description('The agent-facing capability catalog: what an AI agent can discover and call.')
  .argument('<action>', 'list | describe | tools | invoke')
  .argument('[name]', 'capability name (for describe / invoke)')
  .option('-i, --input <key=value...>', 'argument for invoke (repeatable)', collectInputs, {})
  .option('-t, --tenant <id>', 'tenant', 'base')
  .option('--authorize-irreversible', 'authorise irreversible steps for this invocation', false)
  .option('--profile <path>', 'app profile', DEFAULT_PROFILE)
  .option('--policy <path>', 'policy config', DEFAULT_POLICY)
  .option('--capabilities <dir>', 'capability store directory', DEFAULT_CAPABILITIES)
  .action(async (action: string, name: string | undefined, opts) => {
    const { Catalog } = await import('../capability/catalog.js');
    const store = new CapabilityStore(resolvePath(opts.capabilities));
    const catalog = new Catalog(store);

    if (action === 'list') {
      const cards = catalog.list();
      if (!cards.length) {
        console.log('No capabilities saved yet. Run `npm run discover` first.');
        return;
      }
      console.log(`${cards.length} capability/capabilities available to an agent:\n`);
      for (const c of cards) {
        const flags = [
          c.approval,
          c.hasIrreversibleStep ? 'HAS IRREVERSIBLE STEP' : 'read-only',
        ].join(', ');
        console.log(`  ${c.name}@${c.version}  [${flags}]`);
        console.log(`    ${c.title}`);
        console.log(`    in:  ${Object.keys(c.inputSchema.properties).join(', ') || '(none)'}`);
        console.log(`    out: ${Object.keys(c.outputSchema.properties).join(', ') || '(none)'}`);
        console.log(`    or:  ${c.businessOutcomes.map((b) => b.code).join(', ') || '(no declared business outcomes)'}\n`);
      }
      return;
    }

    if (action === 'tools') {
      console.log(JSON.stringify(catalog.tools(), null, 2));
      return;
    }

    if (!name) throw new Error(`\`catalog ${action}\` needs a capability name`);

    if (action === 'describe') {
      console.log(JSON.stringify(catalog.describe(name), null, 2));
      return;
    }

    if (action === 'invoke') {
      const profile = loadAppProfile(resolvePath(opts.profile));
      const policy = Policy.fromFile(resolvePath(opts.policy));
      console.log(`Agent invokes: ${name}(${JSON.stringify(opts.input)})\n`);
      try {
        const result = await catalog.invoke(name, opts.input, {
          tenantId: opts.tenant,
          profile,
          policy,
          authorizeIrreversible: Boolean(opts.authorizeIrreversible),
        });
        console.log(JSON.stringify(sliceForAgent(result), null, 2));
        process.exitCode = result.status === 'failed' ? 1 : 0;
      } catch (err) {
        if (err instanceof CapabilityInputError) {
          console.log(JSON.stringify({ status: 'invalid_arguments', problems: err.problems }, null, 2));
          process.exitCode = 2;
          return;
        }
        throw err;
      }
      return;
    }

    throw new Error(`unknown catalog action "${action}". Use list | describe | tools | invoke.`);
  });

/* -------------------------------------------------------------- utilities */

/** What the calling agent actually receives — not the whole run envelope. */
function sliceForAgent(r: ReplayResult): Record<string, unknown> {
  const base = { status: r.status, capability: `${r.capability}@${r.capabilityVersion}`, tenant: r.tenant };
  switch (r.status) {
    case 'success':
      return { ...base, outputs: r.outputs };
    case 'business_outcome':
      return { ...base, code: r.code, message: r.message };
    case 'escalated':
      return { ...base, resolution: r.resolution, reason: r.reason, interventionId: r.interventionId };
    case 'failed':
      return { ...base, error: r.error, evidence: r.evidenceDir };
  }
}

function collectInputs(value: string, previous: Record<string, string>): Record<string, string> {
  const eq = value.indexOf('=');
  if (eq === -1) throw new Error(`--input expects key=value, got "${value}"`);
  return { ...previous, [value.slice(0, eq)]: value.slice(eq + 1) };
}

/**
 * Which request each fault should fire on.
 *
 * Targeting the route is what makes each scenario say what it means. Left
 * untargeted, a session fault fires on whichever request arrives first — in
 * practice the sign-on bounce — which tests "sign-on is broken", not "the
 * session expired halfway through the flow".
 */
const FAULT_ROUTES: Record<string, string> = {
  slow: '/member/*',
  app_error: '/member/*',
  session: '/member/*',
  interstitial: '/search',
};

/**
 * Arms a fault on the target app.
 *
 * Note this goes over plain HTTP from the CLI, not through the browser surface:
 * `/_admin/**` is on the policy DENY list precisely so the automation cannot
 * reach its own test hooks. The harness may arm faults; the agent may not.
 */
async function armFault(baseUrl: string, mode: string): Promise<void> {
  const res = await fetch(`${baseUrl}/_admin/fault`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, times: 1, route: FAULT_ROUTES[mode] }),
  });
  if (!res.ok) throw new Error(`Could not arm fault "${mode}": ${res.status} ${await res.text()}`);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
