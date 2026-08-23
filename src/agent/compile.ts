/**
 * Trace -> Capability.
 *
 * This is where the model's influence ends, and the boundary is drawn as
 * tightly as it can be. From the trace, the compiler takes:
 *
 *   - the ORDER of actions
 *   - which element each action touched
 *   - the model's one-sentence `why`, verbatim, as human-readable `intent`
 *
 * and nothing else. Specifically, the model does NOT author:
 *
 *   - locators        — built from what perception recorded about the element
 *   - checkpoints     — derived from the observed state transition
 *   - the error taxonomy — inherited from the product profile
 *   - risk classes    — assigned by policy rules
 *   - input/output types — inferred from the values, then reviewed by a human
 *
 * That split is the whole design. A model is good at "which link do I click to
 * find a member" and unreliable at "what regex should assert we arrived". Asking
 * it only the first question, and deriving the rest mechanically, is what makes
 * the artifact something a person can approve.
 *
 * Everything compiled here starts life as `approval: draft`. A capability
 * becomes approved when a human reads the file and says so — never as a side
 * effect of a successful discovery run.
 */

import { createHash } from 'node:crypto';
import type { DiscoveryTrace, TraceStep } from './loop.js';
import type { AppProfile } from '../capability/app-profile.js';
import {
  API_VERSION,
  type BusinessOutcome,
  type Capability,
  type Checkpoint,
  type CapabilityInput,
  type CapabilityOutput,
  type Predicate,
  type Step,
  type StepAction,
} from '../capability/schema.js';
import type { ElementDescriptor } from '../surface/descriptor.js';
import type { RiskClass } from '../policy/policy.js';

export interface CompileOptions {
  trace: DiscoveryTrace;
  profile: AppProfile;
  /** Where the trace was written, so provenance can point at it. */
  traceRef: string;
  name?: string;
  version?: string;
}

export class CompileError extends Error {}

export function compile(opts: CompileOptions): Capability {
  const { trace, profile } = opts;

  if (trace.outcome.kind !== 'success') {
    throw new CompileError(
      `refusing to compile a capability from a run that did not succeed (${trace.outcome.kind}: ` +
        `${'why' in trace.outcome ? trace.outcome.why : ''}). An artifact is a promise that a flow works.`,
    );
  }

  const acting = trace.steps.filter((s) => s.ok && s.descriptor);
  if (acting.length === 0) {
    throw new CompileError('the run completed without acting on anything; there is no flow to record');
  }

  const name = opts.name ?? slug(trace.outcome.summary || trace.goalTemplate);
  const version = opts.version ?? '1.0.0';

  const inputs = inferInputs(trace);
  const steps = acting.map((s, i) => compileStep(s, i, acting, trace));
  const outputs = compileOutputs(trace);

  return {
    apiVersion: API_VERSION,
    kind: 'Capability',
    metadata: {
      id: `cap_${name}`,
      name,
      version,
      title: sentenceCase(trace.outcome.summary || trace.goalTemplate),
      summary: trace.outcome.summary,
      createdAt: new Date().toISOString(),
      app: {
        product: profile.product,
        productVersion: profile.tenants.find((t) => t.id === trace.tenant)?.productVersion ?? 'unknown',
        tenant: trace.tenant,
        entryPoint: trace.entryPoint,
      },
      // Never approved by compilation. A human reads the file and decides.
      approval: 'draft',
      provenance: {
        discoveryRunId: trace.runId,
        model: `${trace.provider}:${trace.model}`,
        surfaceKind: 'web',
        traceRef: opts.traceRef,
        traceSha256: createHash('sha256').update(JSON.stringify(trace)).digest('hex'),
      },
    },
    spec: {
      preconditions: {
        authState: 'authenticated',
        describe:
          'An operator session must already exist. Sign-on is the runtime\'s responsibility, not part of this flow.',
      },
      inputs,
      outputs,
      steps,
      successCheckpoint: successCheckpointFrom(acting[acting.length - 1]!, trace),
      // Inherited, not invented: the product profile already declares what these
      // screens can legitimately answer, and the compiler simply publishes the
      // ones a caller of THIS capability could encounter.
      outcomes: { business: businessOutcomesFrom(profile) },
      escalation: { onUnrecovered: 'escalate', onAmbiguous: 'escalate', onIrreversible: 'require_approval' },
    },
    overrides: {},
  };
}

/* ------------------------------------------------------------------ inputs */

/**
 * The values the caller supplied become the typed inputs.
 *
 * Deliberately driven by `--param`, not inferred from the model's behaviour.
 * Guessing which of the strings a model typed were "really" parameters is a
 * subtle way to produce a capability that hard-codes a member number, and there
 * is no reason to guess when the operator running discovery already knows.
 */
function inferInputs(trace: DiscoveryTrace): CapabilityInput[] {
  return Object.entries(trace.params).map(([name, value]) => ({
    name,
    type: /^[0-9]+(\.[0-9]+)?$/.test(value) ? ('string' as const) : ('string' as const),
    description: `Supplied at discovery time as "${maskExample(name, value)}".`,
    required: true,
    pattern: patternFor(value),
    // Conservative by default: anything that identifies a member or an account
    // is PII until a reviewer says otherwise. Under-classifying is the failure
    // that leaks; over-classifying just makes a log less readable.
    sensitivity: 'pii' as const,
    example: maskExample(name, value),
  }));
}

function patternFor(value: string): string {
  if (/^[0-9]+$/.test(value)) return `^[0-9]{1,${Math.max(value.length + 3, 9)}}$`;
  if (/^[0-9]+\.[0-9]{2}$/.test(value)) return '^[0-9]+(\\.[0-9]{1,2})?$';
  return `^.{1,${Math.max(value.length * 2, 40)}}$`;
}

function maskExample(_name: string, value: string): string {
  // An example is documentation, and documentation gets committed. Keep the
  // shape, drop most of the value. ASCII only — an artifact is read in diffs,
  // terminals and CI logs, and a fancy glyph will be mangled by one of them.
  if (value.length <= 4) return value;
  return `${value.slice(0, 2)}${'x'.repeat(Math.max(value.length - 4, 1))}${value.slice(-2)}`;
}

/* ------------------------------------------------------------------- steps */

function compileStep(s: TraceStep, index: number, all: TraceStep[], trace: DiscoveryTrace): Step {
  const descriptor = s.descriptor!;
  const action = compileAction(s, descriptor, trace);
  const checkpoint = checkpointFor(s, index, all);

  return {
    id: `s${index + 1}`,
    // The model's own sentence, unmodified. It is documentation, and it is
    // never consulted to make a replay decision.
    intent: s.intent,
    action,
    guard: { risk: riskFor(action) },
    ...(checkpoint ? { checkpoint } : {}),
    conditions: [],
    optional: false,
  };
}

function compileAction(s: TraceStep, target: ElementDescriptor, trace: DiscoveryTrace): StepAction {
  switch (s.toolName) {
    case 'click':
      return { type: 'click', target };
    case 'type':
      return { type: 'type', target, value: parameterise(String(s.arguments.text ?? ''), trace.params) };
    case 'select':
      return { type: 'select', target, value: parameterise(String(s.arguments.value ?? ''), trace.params) };
    case 'press':
      return { type: 'press', key: String(s.arguments.key ?? 'Enter') };
    default:
      throw new CompileError(`cannot compile tool "${s.toolName}" into a step`);
  }
}

/**
 * Replaces supplied values with `{{references}}`.
 *
 * This is the structural guarantee that captured data never reaches a committed
 * file: the artifact stores the reference, so there is nothing in it to redact.
 */
function parameterise(value: string, params: Record<string, string>): string {
  let out = value;
  // Longest first, so a short value that is a substring of a longer one doesn't
  // corrupt it.
  for (const [k, v] of Object.entries(params).sort((a, b) => b[1].length - a[1].length)) {
    if (v && out.includes(v)) out = out.split(v).join(`{{${k}}}`);
  }
  return out;
}

/** Risk is assigned by rule, never by the model and never by the trace. */
function riskFor(action: StepAction): RiskClass {
  if (action.type === 'type' || action.type === 'select') return 'mutating';
  return 'safe';
}

/* ------------------------------------------------------------- checkpoints */

/**
 * Derives a checkpoint from the state transition the action caused.
 *
 * Order of preference, strongest signal first:
 *   1. a frame's location changed  -> assert the new route (parameterised)
 *   2. a heading appeared          -> assert that heading
 *   3. the action produced no observable transition -> no checkpoint
 *
 * (3) is important and easy to get wrong: typing into a field legitimately
 * changes nothing observable, and inventing an assertion there would make replay
 * fail on a step that worked perfectly.
 */
function checkpointFor(s: TraceStep, index: number, all: TraceStep[]): Checkpoint | undefined {
  const before = index === 0 ? undefined : all[index - 1]!.after;
  const moved = !before || !sameLocations(before.frameUrls, s.after.frameUrls);

  const predicates: Predicate[] = [];

  if (moved) {
    const changed = s.after.frameUrls.filter((u) => u !== 'about:blank' && !before?.frameUrls.includes(u));
    const target = changed[changed.length - 1] ?? s.after.frameUrls[s.after.frameUrls.length - 1];
    if (target) {
      const pattern = routePattern(new URL(target).pathname);
      if (pattern) predicates.push({ kind: 'urlMatches', pattern });
    }
  }

  if (s.after.heading && (!before || before.heading !== s.after.heading)) {
    predicates.push({ kind: 'textPresent', text: s.after.heading });
  }

  if (predicates.length === 0) return undefined;

  return {
    describe: describeCheckpoint(predicates),
    all: predicates,
    any: [],
    // Generous but bounded. Enterprise apps are slow; the poll is what absorbs
    // that, and the deadline is what stops us waiting on a page that will never
    // arrive.
    timeoutMs: 12_000,
    pollMs: 250,
  };
}

/**
 * Concrete route -> parameterised pattern. `/member/10001` becomes
 * `/member/[0-9]+$`, so the checkpoint is about the *shape* of where we landed
 * rather than about the record we happened to look at during discovery.
 */
function routePattern(pathname: string): string | undefined {
  if (pathname === '/' || pathname === '') return undefined;
  const parameterised = pathname
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) ? '[0-9]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return `${parameterised}$`;
}

function describeCheckpoint(predicates: Predicate[]): string {
  const parts = predicates.map((p) => {
    if (p.kind === 'urlMatches') return `the route matches ${p.pattern}`;
    if (p.kind === 'textPresent') return `"${p.text}" is on screen`;
    return p.kind;
  });
  return parts.join(' and ');
}

function sameLocations(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function successCheckpointFrom(last: TraceStep, trace: DiscoveryTrace): Checkpoint {
  const predicates: Predicate[] = [];
  if (last.after.heading) predicates.push({ kind: 'textPresent', text: last.after.heading });

  // Assert the presence of every element an output is read from: if we cannot
  // see the values, we did not reach the goal, whatever the URL says.
  if (trace.outcome.kind === 'success') {
    for (const o of trace.outcome.outputs) {
      predicates.push({ kind: 'elementPresent', target: o.descriptor });
    }
  }
  if (predicates.length === 0) {
    const path = new URL(last.after.frameUrls[last.after.frameUrls.length - 1] ?? last.after.url).pathname;
    const pattern = routePattern(path);
    if (pattern) predicates.push({ kind: 'urlMatches', pattern });
  }

  return {
    describe: 'the flow reached the screen that answers the goal, with every declared value visible on it',
    all: predicates,
    any: [],
    timeoutMs: 10_000,
    pollMs: 250,
  };
}

/* ----------------------------------------------------------------- outputs */

function compileOutputs(trace: DiscoveryTrace): CapabilityOutput[] {
  if (trace.outcome.kind !== 'success') return [];
  const lastStepId = `s${trace.steps.filter((s) => s.ok && s.descriptor).length}`;

  return trace.outcome.outputs.map((o) => {
    const looksLikeMoney = /^[$€£]\s?-?[\d,]+\.\d{2}$/.test(o.sampleText.trim());
    return {
      name: o.name,
      type: looksLikeMoney ? ('money' as const) : ('string' as const),
      description: o.description,
      sensitivity: 'pii' as const,
      from: {
        afterStep: lastStepId,
        target: o.descriptor,
        transform: looksLikeMoney ? ('money' as const) : ('trim' as const),
      },
    };
  });
}

/* ---------------------------------------------------------------- outcomes */

/**
 * Publishes the product's declared business outcomes as this capability's
 * result contract. They are authored once per vendor product and inherited, so
 * a new capability gets a correct error taxonomy on the day it is recorded
 * rather than after it has failed in production a few times.
 */
function businessOutcomesFrom(profile: AppProfile): BusinessOutcome[] {
  return profile.conditions
    .filter((c) => c.then.kind === 'business')
    .map((c) => ({
      code: c.then.kind === 'business' ? c.then.code : '',
      meaning: (c.then.kind === 'business' ? c.then.message : undefined) ?? c.description.trim(),
      outputsAvailable: false,
    }));
}

/* ----------------------------------------------------------------- naming */

function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .split('_')
    .filter((w) => w && !['the', 'a', 'an', 'and', 'their', 'for', 'of', 'to', 'this'].includes(w))
    .slice(0, 6)
    .join('_');
  return /^[a-z]/.test(s) ? s : `capability_${s}`;
}

function sentenceCase(s: string): string {
  const t = s.trim().replace(/\.$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
