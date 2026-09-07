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
import type { AppProfile } from '../capability/application-profile.js';
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
import type { ElementDescriptor } from '../surface/element-descriptor.js';
import type { RiskClass } from '../policy/guardrails.js';

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

  // The model writes its summary about the run it just did, so it says "member
  // 10001", not "member {{memberId}}". That sentence becomes the artifact's
  // title, summary and file name, so the supplied value has to come back out of
  // it before any of that is written — see `parameterise`.
  const summary = parameterise(trace.outcome.summary || trace.goalTemplate, trace.params);
  const name = opts.name ?? slug(summary);
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
      title: sentenceCase(summary),
      summary,
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
    type: 'string' as const,
    description: describeInput(name, trace),
    required: true,
    pattern: patternFor(value),
    // Conservative by default: anything that identifies a member or an account
    // is PII until a reviewer says otherwise. Under-classifying is the failure
    // that leaks; over-classifying just makes a log less readable.
    sensitivity: 'pii' as const,
    // No `example`.
    //
    // A masked example is worse than none. "10xx01" documents the shape to a
    // human reading a diff, but this field is also projected into the JSON
    // Schema an agent is handed, where it reads as a value it may send — and an
    // agent that sends "10xx01" gets a validation refusal it cannot diagnose.
    // The `pattern` states the shape precisely and machine-checkably, which is
    // what a caller actually needs. A reviewer may add a real, non-sensitive
    // example by hand.
  }));
}

/**
 * What this parameter is for, taken from the step that uses it.
 *
 * The model already wrote a sentence explaining each step it took, and the step
 * that types `{{memberId}}` says what `memberId` means better than the compiler
 * could invent — "Enter member number {{memberId}} into the Value field to
 * search for the member". Reusing it beats the previous text, which described
 * only how the recording happened to be run and told a caller nothing about
 * what to pass.
 */
function describeInput(name: string, trace: DiscoveryTrace): string {
  const ref = `{{${name}}}`;
  const value = trace.params[name];
  // The intent is captured verbatim from the model and still holds the literal
  // value it was given, so match on that and hand back the parameterised form.
  const step = trace.steps.find(
    (s) => s.intent.includes(ref) || (value ? s.intent.includes(value) : false),
  );
  const sentence = parameterise(step?.intent ?? '', trace.params).trim();
  if (sentence) return sentence.endsWith('.') ? sentence : `${sentence}.`;
  return `Value for ${ref}, supplied by the caller at invocation time.`;
}

function patternFor(value: string): string {
  if (/^[0-9]+$/.test(value)) return `^[0-9]{1,${Math.max(value.length + 3, 9)}}$`;
  if (/^[0-9]+\.[0-9]{2}$/.test(value)) return '^[0-9]+(\\.[0-9]{1,2})?$';
  return `^.{1,${Math.max(value.length * 2, 40)}}$`;
}

/* ------------------------------------------------------------------- steps */

function compileStep(s: TraceStep, index: number, all: TraceStep[], trace: DiscoveryTrace): Step {
  const descriptor = s.descriptor!;
  const action = compileAction(s, descriptor, trace);
  const checkpoint = checkpointFor(s, index, all, trace.params);

  return {
    id: `s${index + 1}`,
    // The model's own sentence, with supplied values referenced rather than
    // quoted. It is documentation, and it is never consulted to make a replay
    // decision.
    intent: parameterise(s.intent, trace.params),
    action,
    guard: { risk: riskFor(action) },
    ...(checkpoint ? { checkpoint } : {}),
    conditions: [],
    optional: false,
  };
}

function compileAction(s: TraceStep, descriptor: ElementDescriptor, trace: DiscoveryTrace): StepAction {
  const target = documented(descriptor, trace.params);
  switch (s.toolName) {
    case 'click':
      return { type: 'click', target };
    case 'type':
      return { type: 'type', target, value: parameterise(String(s.arguments.text ?? ''), trace.params) };
    case 'select':
      return { type: 'select', target, value: compileSelectValue(String(s.arguments.value ?? ''), trace.params) };
    case 'press':
      return { type: 'press', key: String(s.arguments.key ?? 'Enter') };
    default:
      throw new CompileError(`cannot compile tool "${s.toolName}" into a step`);
  }
}

/**
 * The value to record for a `select`, which is not simply the parameterised
 * option text.
 *
 * A model picks an option by the label it can see, and on a real application
 * that label routinely carries live data: MERIDIAN's share dropdowns read
 * `103001-MMKT-5 - Money Market ($123.00)`. Parameterising that gives
 * `{{fromShare}} - Money Market ($123.00)` — which replays correctly exactly
 * once, until the balance changes, and then fails with `no-such-option` against
 * a list that visibly contains the share the caller asked for. That is the
 * "stores a value, not a reference" bug wearing a reference as a disguise:
 * the identifier is parameterised and the volatile part beside it is not.
 *
 * So when the option label *starts with* a supplied parameter value, the
 * remainder is display text and is dropped. The surface matches an option on
 * either its `value` attribute or its text, and a code-style option value is
 * what the form actually posts, so the bare reference is both stabler and
 * closer to what the application means.
 *
 * Deliberately conservative: this only fires for a parameter at the START of
 * the label, followed by a separator. A label that merely contains a value
 * somewhere (`Transfer to {{name}} today`) is left to `parameterise`, because
 * there the surrounding text may well be what distinguishes two options.
 */
function compileSelectValue(value: string, params: Record<string, string>): string {
  for (const [k, v] of Object.entries(params).sort((a, b) => b[1].length - a[1].length)) {
    if (!v) continue;
    const rest = value.slice(v.length);
    if (value.startsWith(v) && (rest === '' || /^\s*[-–—:(|]/.test(rest))) {
      return `{{${k}}}`;
    }
  }
  return parameterise(value, params);
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

/**
 * Parameterises the parts of a descriptor that identify a *record* rather than
 * a *kind of thing*.
 *
 * Two fields, and the difference between them is the whole point:
 *
 * `description` is prose for a reviewer, never consulted to resolve an element,
 * so it is rewritten freely — a substring match is fine because nothing depends
 * on it.
 *
 * `inRowWith` is different: it is the only descriptor field whose job is to say
 * *which row*, and on some applications a row is keyed by a record identifier
 * that the caller supplies. Left as a captured literal, such a descriptor works
 * exactly once — for the record it was recorded against. So when the caller's
 * argument IS the row key, it becomes a reference.
 *
 * Everything else stays literal, deliberately:
 *
 *   - `underColumn` and `nearHeading` are structural labels — a column header
 *     and a section heading are properties of the screen, not of the record.
 *   - `proximateLabel` is a field caption, likewise.
 *   - `name` is a control's accessible name; rewriting it would make a button
 *     unfindable.
 *
 * When the argument only *appears inside* the row key, the whole anchor is
 * replaced by the reference rather than rewritten in place. Searching for
 * `lastName=Hopper` lands on a row keyed "Hopper, Grace", and a substring
 * rewrite would record "{{lastName}}, Grace" — which resolves to "Johnson,
 * Grace" on the next caller's search and matches nothing. The caller's argument
 * is the part of that key that identifies the row; the remainder is the
 * particular record we happened to record against, and keeping it is precisely
 * the bug. The resolver scores a partial row-key match well below an exact one,
 * so this stays a weaker signal than an exact key — which is correct, because
 * it is weaker evidence.
 */
function documented(target: ElementDescriptor, params: Record<string, string>): ElementDescriptor {
  // Longest first: where two arguments both occur in a row key, the longer one
  // identifies it more precisely.
  const supplied = Object.entries(params)
    .filter(([, v]) => v.trim().length > 0)
    .sort((a, b) => b[1].length - a[1].length);

  const referenceFor = (text: string): string | undefined => {
    const t = text.trim();
    const hit = supplied.find(([, v]) => t === v || t.includes(v));
    return hit ? `{{${hit[0]}}}` : undefined;
  };

  return {
    ...target,
    description: parameterise(target.description, params),
    anchors: target.anchors.map((a) => {
      if (a.relation !== 'inRowWith') return a;
      const ref = referenceFor(a.text);
      return ref ? { ...a, text: ref } : a;
    }),
  };
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
function checkpointFor(
  s: TraceStep,
  index: number,
  all: TraceStep[],
  params: Record<string, string>,
): Checkpoint | undefined {
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

  // A heading that quotes a supplied value ("Member 10001 — Detail") is not an
  // assertion about the flow, it is an assertion about the record discovery
  // happened to open. Baking it in would persist the value and fail every other
  // member. Checkpoints are not interpolated at replay, so the honest move is to
  // drop the predicate rather than emit a reference nothing expands.
  const heading = s.after.heading;
  if (heading && (!before || before.heading !== heading) && parameterise(heading, params) === heading) {
    predicates.push({ kind: 'textPresent', text: heading });
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
 * `/member/[0-9]+(?:[?#]|$)`, so the checkpoint is about the *shape* of where we
 * landed rather than about the record we happened to look at during discovery.
 *
 * The trailing alternation, rather than a bare `$`, is not defensive
 * programming — it is a correctness fix. The pattern is built from a *pathname*
 * but matched against a *full URL*, so an application that answers a search with
 * `GET /members?by=number&q=101555` would fail a `/members$` checkpoint on every
 * run, and fail it as an unexplained timeout: the page is right there, correct,
 * and the assertion says nothing arrived. A query string means the path ended,
 * so the pattern has to say so.
 */
function routePattern(pathname: string): string | undefined {
  if (pathname === '/' || pathname === '') return undefined;
  const parameterised = pathname
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) ? '[0-9]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return `${parameterised}(?:[?#]|$)`;
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
      predicates.push({ kind: 'elementPresent', target: documented(o.descriptor, trace.params) });
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
      description: parameterise(o.description, trace.params),
      sensitivity: 'pii' as const,
      from: {
        afterStep: lastStepId,
        target: documented(o.descriptor, trace.params),
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
  // Deduplicated by code, first declaration winning.
  //
  // Several detectors legitimately map to one outcome — an application can
  // reject a transaction on its own error screen or inline on the form, and the
  // caller does not care which the vendor chose. But the catalog advertises this
  // list to an agent as "the answers you may get back", and the same code twice
  // makes that list look like it was generated rather than designed.
  const byCode = new Map<string, BusinessOutcome>();
  for (const c of profile.conditions) {
    if (c.then.kind !== 'business' || byCode.has(c.then.code)) continue;
    byCode.set(c.then.code, {
      code: c.then.code,
      meaning: c.then.message ?? c.description.trim(),
      outputsAvailable: false,
    });
  }
  return [...byCode.values()];
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
