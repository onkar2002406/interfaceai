/**
 * Adds the three form fields the brief names but discovery did not record.
 *
 * ## Why these three were missing
 *
 * §2.1 spells out the shape of each flow: Funds Transfer carries a **memo**,
 * Update Member Information covers **address** alongside email and phone, and
 * Place Account Hold takes **notes** beside the reason code. All three controls
 * exist on MERIDIAN's own screens — `scripts/probe-target.ts` finds them as
 * `textbox labelled="Memo"`, `"Mailing Address"` and `"Notes"`.
 *
 * They are absent from the artifacts for an unremarkable reason: the goal each
 * discovery run was given did not mention them, so the model never typed into
 * them, so the compiler never saw a step to compile. Nothing went wrong. The
 * recorded flow is a faithful record of a narrower task than the brief asks for.
 *
 * ## Why a script rather than three YAML edits
 *
 * Same reason as `scripts/complete-posting-steps.ts`, which this is modelled on:
 * an artifact that is part-recorded and part-authored should say so, and the
 * authored half belongs somewhere reviewable and re-runnable rather than in a
 * diff that becomes invisible history the moment it is merged. Re-record any of
 * these capabilities and this script puts the fields back.
 *
 * Run it AFTER `complete-posting-steps.ts`, since that one appends the posting
 * step and this one inserts ahead of the submit control.
 *
 * ## Why the inputs are required
 *
 * A memo and a hold note are optional *on the screen*, and it is tempting to
 * declare them optional here too. The executor gives no way to make that work:
 * `optional: true` on a step skips when the **element** is absent, not when a
 * **parameter** is, and an unsupplied `{{memo}}` interpolates to the literal
 * string `{{memo}}` — templating leaves unresolved references intact on purpose,
 * so a missing argument surfaces loudly instead of silently matching the wrong
 * thing. Typing "{{memo}}" into a bank's transfer form is the worst of the
 * available outcomes.
 *
 * So the rule the repository already follows applies: if a step types it, the
 * input is required. Every input on every other artifact is `required: true`,
 * including `open_sub_account`'s conceptually-optional `nickname`. Validation
 * runs before a browser starts, so a caller who omits one gets a precise
 * complaint in milliseconds rather than a failed run.
 *
 * The honest cost is that this changes three tool signatures. All seven MERIDIAN
 * artifacts are `draft`, so nothing approved depends on the old shape — but any
 * command or chat prompt that invokes them now has to supply the new argument,
 * and README.md and DEMO-GUIDE.md are updated to match.
 *
 * Run:  npx tsx scripts/add-form-fields.ts
 * Idempotent — a capability that already declares the input is left alone.
 */

import { resolve as resolvePath } from 'node:path';
import { CapabilityStore } from '../src/capability/store.js';
import type { Capability, CapabilityInput, Step } from '../src/capability/schema.js';

interface FieldAddition {
  capability: string;
  /** The input to declare, exactly as an agent will see it in the tool schema. */
  input: CapabilityInput;
  /** Step id to insert after. The new step lands between this and the submit. */
  afterStepId: string;
  /** Accessible caption of the textbox, as `probe-target.ts` reports it. */
  label: string;
  /** Heading of the screen the field sits on, used to scope the descriptor. */
  heading: string;
  intent: string;
  /**
   * Replacement summary. The recorded summary describes the narrower flow the
   * model was asked for, and a tool description is the only thing many agents
   * read before choosing a capability.
   */
  summary: string;
}

const ADDITIONS: FieldAddition[] = [
  {
    capability: 'funds_transfer',
    input: {
      name: 'memo',
      type: 'string',
      description: 'Memo recorded against the transfer, 40 characters or fewer.',
      required: true,
      pattern: '^.{1,40}$',
      // Free text a teller types about a member's money movement. Not an
      // identifier, but not public either — it reaches the same logs.
      sensitivity: 'pii',
    },
    afterStepId: 's8',
    label: 'Memo',
    heading: 'FUNDS TRANSFER',
    intent: 'Enter {{memo}} into the Memo textbox',
    summary:
      'Moves {{amount}} from share {{fromShare}} to share {{toShare}} on member {{memberId}} ' +
      'with the memo {{memo}}, reviewing the transfer and then POSTING it. The posting step is ' +
      'irreversible and requires explicit authorisation; without it the run stops for a human ' +
      'at the confirmation screen having committed nothing.',
  },
  {
    capability: 'update_member_info',
    input: {
      name: 'address',
      type: 'string',
      description: 'Replacement mailing address for the member record.',
      required: true,
      pattern: '^.{1,120}$',
      sensitivity: 'pii',
    },
    afterStepId: 's7',
    label: 'Mailing Address',
    heading: 'UPDATE MEMBER INFORMATION',
    intent: 'Enter {{address}} into the Mailing Address textbox',
    summary:
      'Updates the e-mail, phone and mailing address on member {{memberId}} and saves the ' +
      'record. The mailing address REPLACES what is on file rather than appending to it, so a ' +
      'caller that does not have the full address should read the record first.',
  },
  {
    capability: 'place_account_hold',
    input: {
      name: 'notes',
      type: 'string',
      description: 'Free-text note explaining the hold, 120 characters or fewer.',
      required: true,
      pattern: '^.{1,120}$',
      sensitivity: 'pii',
    },
    afterStepId: 's7',
    label: 'Notes',
    heading: 'PLACE ACCOUNT HOLD',
    intent: 'Enter {{notes}} into the Notes textbox',
    summary:
      'Places a {{reason}} hold on share {{shareId}} of member {{memberId}}, annotated with ' +
      '{{notes}}, reviewing it and then APPLYING it. Restricted to supervisors — a teller ' +
      'receives SUPERVISOR_OVERRIDE_REQUIRED. The applying step is irreversible and requires ' +
      'explicit authorisation; without it the run stops for a human having applied nothing.',
  },
];

const store = new CapabilityStore(resolvePath('capabilities'));

for (const a of ADDITIONS) {
  let capability: Capability;
  try {
    capability = store.load(a.capability);
  } catch {
    console.log(`skip ${a.capability} — not recorded yet`);
    continue;
  }

  if (capability.spec.inputs.some((i) => i.name === a.input.name)) {
    console.log(`skip ${a.capability} — already declares "${a.input.name}"`);
    continue;
  }

  const steps = capability.spec.steps;
  const at = steps.findIndex((s) => s.id === a.afterStepId);
  if (at === -1) {
    console.log(`skip ${a.capability} — no step "${a.afterStepId}" to insert after`);
    continue;
  }

  // A suffixed id rather than a renumber. Step ids are referenced from
  // `outputs[].from.afterStep`, from `provenance.handCompleted`, and from every
  // recorded evidence directory; renumbering would invalidate all of them to
  // buy nothing, since the executor runs steps in array order and never sorts
  // by id.
  const id = `${a.afterStepId}a`;

  const step: Step = {
    id,
    intent: a.intent,
    action: {
      type: 'type',
      target: {
        description: `the ${a.label} textbox on the ${a.heading} screen`,
        role: 'textbox',
        nameMatch: 'normalized',
        scope: { framePath: ['main'], heading: a.heading },
        // The caption is the only durable identity these inputs have: MERIDIAN
        // renders them with no accessible name and no `label for`, so the
        // resolver recovers the caption geometrically. That is the same signal
        // the recorded steps beside this one already win on.
        anchors: [
          { relation: 'proximateLabel', text: a.label },
          { relation: 'nearHeading', text: a.heading },
        ],
        hints: { domHint: 'input', proximateLabels: [a.label] },
      },
      value: `{{${a.input.name}}}`,
    },
    guard: { risk: 'mutating' },
    conditions: [],
    optional: false,
  };

  // Inserted BEFORE the submit control rather than appended. Appending would put
  // it after Continue/Save Changes, i.e. on the next screen, where the field
  // does not exist.
  steps.splice(at + 1, 0, step);
  capability.spec.inputs.push(a.input);
  capability.metadata.summary = a.summary;

  const prior = capability.metadata.provenance.handCompleted;
  const note =
    `step ${id} (${a.label}) was authored by a person, not recorded: the discovery goal did ` +
    `not mention this field, so the model never typed into it. The control is on MERIDIAN's ` +
    `own screen. See scripts/add-form-fields.ts.`;
  capability.metadata.provenance.handCompleted = prior ? `${prior} ${note}` : note;

  const path = store.save(capability);
  console.log(`${a.capability} — inserted ${id} "${a.label}" after ${a.afterStepId}, input "${a.input.name}" -> ${path}`);
}
