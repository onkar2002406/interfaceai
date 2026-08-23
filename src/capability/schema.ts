/**
 * The capability artifact — the thing the model produces and the production
 * path consumes.
 *
 * The framing that drove this schema: **a capability is an API, not a macro.**
 * A recorded step list is a macro — it tells you what keys were pressed. An API
 * tells a caller what it needs, what it returns, and what can happen instead.
 * The AI agent invoking this in production needs the second thing, and so does
 * the human reviewing whether it is safe to let run unattended.
 *
 * Four decisions here are load-bearing and I'd defend each:
 *
 * 1. **Business outcomes are declared in the contract** (`spec.outcomes`).
 *    The brief calls conflating "no such member" with a crash the most common
 *    design mistake, and it is a mistake you make in the *schema*, not in the
 *    executor: if there is nowhere to declare the outcome, the executor has no
 *    choice but to throw. Declaring them means replay can return
 *    `business_outcome` as a first-class result and a calling agent can see the
 *    full set of possible answers before it ever invokes.
 *
 * 2. **Steps carry `intent` prose beside the machine-readable target.**
 *    Reviewability is an explicit requirement, and "click the control matching
 *    role=button name=Search" is not reviewable at a glance. `intent` is what a
 *    human reads, what an escalation request shows the operator, and what a
 *    failure report quotes. It is never consulted to make a replay decision —
 *    that separation is deliberate, so prose drift can never change behaviour.
 *
 * 3. **Values are parameter *references*, never captured literals.**
 *    A recorded run typed "10001" into a field; the artifact stores
 *    `{{memberId}}`. This is a structural guarantee rather than a redaction
 *    pass: there is no member data in a capability file to leak, so a capability
 *    can be committed to git and reviewed in a pull request.
 *
 * 4. **Condition detectors are inherited from an app profile, not re-authored
 *    per capability.** Session expiry looks the same on every screen of a
 *    product. Making each recording rediscover that is how you get twenty
 *    capabilities that each handle timeouts slightly differently. Steps may add
 *    *local* conditions; the global ones come from the product profile.
 */

import { z } from 'zod';
import { ElementDescriptorSchema } from '../surface/descriptor.js';
import { RiskClassSchema } from '../policy/policy.js';
import { SensitivitySchema } from '../policy/redact.js';

export const API_VERSION = 'capability.interface.ai/v1';

/* ------------------------------------------------------------- predicates */

/**
 * Deliberately a flat union rather than a recursive expression tree.
 * A conjunction (or disjunction) of leaf checks covers every checkpoint this
 * system has needed, and a flat union stays readable in a YAML diff — which
 * matters more here than expressive power, because a human approves these.
 */
export const PredicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('textPresent'), text: z.string() }),
  z.object({ kind: z.literal('textAbsent'), text: z.string() }),
  z.object({ kind: z.literal('elementPresent'), target: ElementDescriptorSchema }),
  z.object({ kind: z.literal('elementAbsent'), target: ElementDescriptorSchema }),
  z.object({ kind: z.literal('urlMatches'), pattern: z.string() }),
  z.object({ kind: z.literal('titleMatches'), pattern: z.string() }),
]);
export type Predicate = z.infer<typeof PredicateSchema>;

/**
 * A checkpoint is the assertion that we actually arrived where the click was
 * supposed to take us. Without one, replay is a sequence of hopeful clicks.
 *
 * `timeoutMs` + `pollMs` rather than a fixed sleep: the poll is what absorbs
 * legitimate transient slowness, and the deadline is what stops us waiting
 * forever on a page that will never arrive.
 */
export const CheckpointSchema = z.object({
  describe: z.string(),
  all: z.array(PredicateSchema).default([]),
  any: z.array(PredicateSchema).default([]),
  timeoutMs: z.number().int().positive().default(10000),
  pollMs: z.number().int().positive().default(250),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

/* -------------------------------------------------------------- outcomes */

export const ErrorClassSchema = z.enum([
  'target_not_found',
  'ambiguous_target',
  'checkpoint_failed',
  'policy_violation',
  'unrecovered_condition',
  'surface_error',
  'timeout',
]);
export type ErrorClass = z.infer<typeof ErrorClassSchema>;

/**
 * The closed set of recovery handlers.
 *
 * Closed on purpose. An open-ended "run this script to recover" field would let
 * a recording embed arbitrary behaviour that no reviewer can reason about, and
 * would be the obvious place for an LLM to smuggle an unreviewed action into
 * the deterministic path. Every handler here is inspectable, bounded, and does
 * one obvious thing.
 */
export const RecoveryActionSchema = z.discriminatedUnion('handler', [
  z.object({
    handler: z.literal('dismiss_dialog'),
    dismissTarget: ElementDescriptorSchema,
    maxAttempts: z.number().int().positive().default(2),
  }),
  z.object({
    handler: z.literal('wait_retry'),
    waitMs: z.number().int().positive().default(2000),
    maxAttempts: z.number().int().positive().default(3),
  }),
  z.object({
    handler: z.literal('reauthenticate'),
    maxAttempts: z.number().int().positive().default(1),
  }),
  z.object({
    handler: z.literal('navigate_back'),
    maxAttempts: z.number().int().positive().default(1),
  }),
]);
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

export const ConditionOutcomeSchema = z.discriminatedUnion('kind', [
  /** A legitimate answer the caller needs. Stops the run cleanly, never throws. */
  z.object({ kind: z.literal('business'), code: z.string(), message: z.string().optional() }),
  /** Something we know how to fix. Bounded, then re-verified. */
  z.object({ kind: z.literal('recover'), action: RecoveryActionSchema }),
  /** Something we know is fatal. Stops with a specific diagnosis, not a timeout. */
  z.object({ kind: z.literal('fail'), errorClass: ErrorClassSchema, message: z.string() }),
]);
export type ConditionOutcome = z.infer<typeof ConditionOutcomeSchema>;

export const ConditionSchema = z.object({
  id: z.string(),
  description: z.string(),
  when: PredicateSchema,
  then: ConditionOutcomeSchema,
});
export type Condition = z.infer<typeof ConditionSchema>;

export const BusinessOutcomeSchema = z.object({
  code: z.string(),
  meaning: z.string(),
  /** Whether declared outputs are still available when this outcome occurs. */
  outputsAvailable: z.boolean().default(false),
});
export type BusinessOutcome = z.infer<typeof BusinessOutcomeSchema>;

/* --------------------------------------------------------- inputs/outputs */

export const ParamTypeSchema = z.enum(['string', 'number', 'boolean', 'money']);

export const InputSchema = z.object({
  name: z.string(),
  type: ParamTypeSchema,
  description: z.string(),
  required: z.boolean().default(true),
  /** Validated before the browser is even launched — fail fast, cheaply. */
  pattern: z.string().optional(),
  sensitivity: SensitivitySchema.default('pii'),
  example: z.string().optional(),
});
export type CapabilityInput = z.infer<typeof InputSchema>;

export const OutputSchema = z.object({
  name: z.string(),
  type: ParamTypeSchema,
  description: z.string(),
  sensitivity: SensitivitySchema.default('pii'),
  /**
   * Where the value comes from. Extraction is declared centrally rather than
   * scattered through the steps so the whole return contract can be reviewed
   * (and JSON-Schema'd for the calling agent) in one place.
   */
  from: z.object({
    afterStep: z.string(),
    target: ElementDescriptorSchema,
    transform: z.enum(['text', 'trim', 'money', 'number']).default('trim'),
  }),
});
export type CapabilityOutput = z.infer<typeof OutputSchema>;

/* ------------------------------------------------------------------ steps */

export const StepActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string() }),
  z.object({ type: z.literal('click'), target: ElementDescriptorSchema }),
  z.object({ type: z.literal('type'), target: ElementDescriptorSchema, value: z.string() }),
  z.object({ type: z.literal('select'), target: ElementDescriptorSchema, value: z.string() }),
  z.object({ type: z.literal('press'), key: z.string() }),
]);
export type StepAction = z.infer<typeof StepActionSchema>;

export const StepSchema = z.object({
  id: z.string(),
  /** Prose for humans. Never used to make a replay decision. */
  intent: z.string(),
  action: StepActionSchema,
  guard: z.object({
    risk: RiskClassSchema.default('safe'),
    note: z.string().optional(),
  }),
  checkpoint: CheckpointSchema.optional(),
  /** Conditions specific to this step, evaluated before the product-wide ones. */
  conditions: z.array(ConditionSchema).default([]),
  /**
   * Skip silently if the target isn't there. For genuinely optional screens —
   * a compliance interstitial one tenant added, a "you have 1 new message"
   * splash. Distinct from a recoverable condition: this is expected absence,
   * not a fault.
   */
  optional: z.boolean().default(false),
});
export type Step = z.infer<typeof StepSchema>;

/* --------------------------------------------------------------- metadata */

export const ApprovalSchema = z.enum(['draft', 'approved']);

export const MetadataSchema = z.object({
  id: z.string(),
  /** Stable slug — this is the name an agent calls it by. */
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be a lower_snake_case identifier'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be semver'),
  title: z.string(),
  summary: z.string(),
  createdAt: z.string(),

  app: z.object({
    /** The vendor product, shared across tenants. */
    product: z.string(),
    productVersion: z.string(),
    /** The tenant this was RECORDED against. Replay may target another. */
    tenant: z.string(),
    /** Entry point, relative to the tenant's base URL. */
    entryPoint: z.string(),
  }),

  /**
   * Gates unattended replay of irreversible steps. A capability is a draft
   * until a human has read the step list; approval is an act performed on this
   * file, which is why the file has to be readable.
   */
  approval: ApprovalSchema.default('draft'),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),

  /**
   * Points AT the discovery transcript rather than embedding it. The artifact is
   * the reviewed contract; the transcript is evidence. Keeping them separate is
   * what stops model chatter — and whatever PII it saw — leaking into the file
   * that gets committed and replayed.
   */
  provenance: z.object({
    discoveryRunId: z.string(),
    model: z.string(),
    surfaceKind: z.enum(['web', 'desktop']),
    traceRef: z.string(),
    traceSha256: z.string(),
  }),
});
export type CapabilityMetadata = z.infer<typeof MetadataSchema>;

/* -------------------------------------------------------------- overrides */

/**
 * Per-tenant specialisation, as JSON-Pointer patches over the base spec.
 *
 * The alternative — copying the capability per tenant — means a bug fix has to
 * be applied N times and drift is invisible. A patch list makes the *difference*
 * the reviewable unit: you can read exactly how First Valley deviates from the
 * reference install, and nothing else is duplicated.
 */
export const OverrideSchema = z.object({
  note: z.string(),
  productVersion: z.string().optional(),
  patches: z.array(
    z.object({
      path: z.string().describe('JSON Pointer into `spec`, e.g. /steps/2/target/name'),
      value: z.unknown(),
      why: z.string(),
    }),
  ),
});
export type Override = z.infer<typeof OverrideSchema>;

/* ------------------------------------------------------------- capability */

export const SpecSchema = z.object({
  inputs: z.array(InputSchema).default([]),
  outputs: z.array(OutputSchema).default([]),

  preconditions: z.object({
    /** Whether the flow assumes an authenticated session. */
    authState: z.enum(['authenticated', 'anonymous']).default('authenticated'),
    describe: z.string().optional(),
  }),

  steps: z.array(StepSchema).min(1),

  /** The assertion that the whole capability actually achieved its goal. */
  successCheckpoint: CheckpointSchema,

  /** The declared set of legitimate non-success answers. Part of the API. */
  outcomes: z.object({
    business: z.array(BusinessOutcomeSchema).default([]),
  }),

  escalation: z
    .object({
      onUnrecovered: z.enum(['escalate', 'fail']).default('escalate'),
      onAmbiguous: z.enum(['escalate', 'fail']).default('escalate'),
      onIrreversible: z.enum(['require_approval', 'escalate']).default('require_approval'),
    })
    .default({}),
});
export type CapabilitySpec = z.infer<typeof SpecSchema>;

export const CapabilitySchema = z.object({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('Capability'),
  metadata: MetadataSchema,
  spec: SpecSchema,
  overrides: z.record(z.string(), OverrideSchema).default({}),
});
export type Capability = z.infer<typeof CapabilitySchema>;

/* ---------------------------------------------------------------- helpers */

export function parseCapability(raw: unknown): Capability {
  return CapabilitySchema.parse(raw);
}

/** `{{memberId}}` -> the supplied value. The only templating the schema allows. */
export function interpolate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (whole, key: string) => {
    const v = params[key];
    if (v === undefined || v === null) return whole;
    return String(v);
  });
}

/** Names of parameters a template string references. Used to validate inputs. */
export function templateRefs(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map((m) => m[1]!);
}

export function capabilityRef(c: Capability): string {
  return `${c.metadata.name}@${c.metadata.version}`;
}
