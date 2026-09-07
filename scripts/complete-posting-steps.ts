/**
 * Hand-completes the three MERIDIAN posting capabilities.
 *
 * ## Why this script exists rather than three hand edits
 *
 * Discovery cannot record a posting step, and that is deliberate rather than a
 * limitation to work around. `Policy.check()` refuses every irreversible action
 * while `mode === 'discovery'`, unconditionally and at any confidence — because
 * exploring a banking console by pressing "Post Transfer" to see what happens is
 * not acceptable even once. So the agent records the flow up to the review
 * screen, which is exactly as far as it should get, and the final step is added
 * afterwards by a person who knows what it does.
 *
 * That makes these artifacts *part-recorded, part-authored*, and their
 * provenance says so. Putting the authored half in a committed script rather
 * than in three YAML diffs means the seam is visible, reviewable and re-runnable
 * after any re-recording, instead of being invisible history.
 *
 * ## What it adds
 *
 * One step per capability: click the posting control, `guard.risk: irreversible`,
 * with a checkpoint asserting the flow actually reached the posted state. The
 * control names are the ones on MERIDIAN's own review screens, and they are the
 * same strings `config/policy.meridian.json` classifies as irreversible — which
 * is what makes the guard declaration and the policy agree by construction
 * rather than by coincidence.
 *
 * The step *before* each of these already asserts the review screen's contents
 * (the compiler wrote that checkpoint from the recorded trace), so the values
 * about to be committed are verified before the commit, not after it.
 *
 * Run:  npx tsx scripts/complete-posting-steps.ts
 * Idempotent — a capability that already has its posting step is left alone.
 */

import { resolve as resolvePath } from 'node:path';
import { CapabilityStore } from '../src/capability/store.js';
import type { Capability, Step, Checkpoint } from '../src/capability/schema.js';

interface Completion {
  capability: string;
  /**
   * What the finished capability does, in the words an agent reads before it
   * chooses one.
   *
   * The recorded half's title comes from the model's own `finish` summary, and
   * for these three it says some version of "…and stopped at the confirmation
   * screen" — which was true of the trace and is false of the artifact. Left
   * alone, the catalog would advertise a funds transfer as a flow that stops
   * short of transferring funds. A tool description is the only thing many
   * agents read, so this is not cosmetic.
   */
  title: string;
  summary: string;
  /** Accessible name of the posting control on the review screen. */
  control: string;
  /** The heading the review screen shows, used to scope the control. */
  reviewHeading: string;
  intent: string;
  /** Why a human must authorise this, in the words a reviewer needs. */
  note: string;
  /** What must be true once the post has gone through. */
  posted: Checkpoint;
  /** Route the posted screen lands on, for the artifact's success checkpoint. */
  postedRoute: string;
}

const COMPLETIONS: Completion[] = [
  {
    capability: 'funds_transfer',
    title: 'Post a funds transfer between two shares on a member record',
    summary:
      'Moves {{amount}} from share {{fromShare}} to share {{toShare}} on member {{memberId}}, ' +
      'reviewing the transfer and then POSTING it. The posting step is irreversible and ' +
      'requires explicit authorisation; without it the run stops for a human at the ' +
      'confirmation screen having committed nothing.',
    control: 'Post Transfer',
    reviewHeading: 'CONFIRM FUNDS TRANSFER',
    intent: 'Click Post Transfer to commit the transfer shown on the confirmation screen',
    note:
      'Moves money between two shares. MERIDIAN states on the review screen that this posts ' +
      'immediately and cannot be reversed from that screen. Requires explicit authorisation, ' +
      'or the run stops for a human here.',
    postedRoute: '/members/[^/]+/transfer/post',
    posted: {
      describe: 'the transfer was posted and the application confirmed it',
      all: [{ kind: 'urlMatches', pattern: '/members/[^/]+/transfer/post' }],
      any: [
        { kind: 'textPresent', text: 'TRANSFER POSTED' },
        { kind: 'textPresent', text: 'Confirmation' },
      ],
      timeoutMs: 15000,
      pollMs: 250,
    },
  },
  {
    capability: 'open_new_share',
    title: 'Open a new share on a member record',
    summary:
      'Opens a {{shareType}} share on member {{memberId}} with an initial deposit of {{deposit}}, ' +
      'reviewing it and then CREATING it. The creating step is irreversible and requires ' +
      'explicit authorisation; without it the run stops for a human at the confirmation ' +
      'screen having created nothing.',
    control: 'Open Share',
    reviewHeading: 'CONFIRM NEW SHARE',
    intent: 'Click Open Share to create the share shown on the confirmation screen',
    note:
      'Creates a new share on the member record and posts the initial deposit. Not undoable from ' +
      'the servicing console. Requires explicit authorisation, or the run stops for a human here.',
    postedRoute: '/members/[^/]+/open-share/post',
    posted: {
      describe: 'the share was opened and the application confirmed it',
      all: [{ kind: 'urlMatches', pattern: '/members/[^/]+/open-share/post' }],
      any: [
        { kind: 'textPresent', text: 'SHARE OPENED' },
        { kind: 'textPresent', text: 'Confirmation' },
      ],
      timeoutMs: 15000,
      pollMs: 250,
    },
  },
  {
    capability: 'place_account_hold',
    title: 'Place a hold on a member share',
    summary:
      'Places a {{reason}} hold on share {{shareId}} of member {{memberId}}, reviewing it and ' +
      'then APPLYING it. Restricted to supervisors — a teller receives ' +
      'SUPERVISOR_OVERRIDE_REQUIRED. The applying step is irreversible and requires explicit ' +
      'authorisation; without it the run stops for a human having applied nothing.',
    control: 'Apply Hold',
    reviewHeading: 'CONFIRM ACCOUNT HOLD',
    intent: 'Click Apply Hold to place the hold shown on the confirmation screen',
    note:
      'Restricts the member from using the share. MERIDIAN labels the review screen IRREVERSIBLE ' +
      'ACTION. A teller is refused this outright (SUPERVISOR_OVERRIDE_REQUIRED); a supervisor ' +
      'still needs explicit authorisation, or the run stops for a human here.',
    postedRoute: '/members/[^/]+/hold/post',
    posted: {
      describe: 'the hold was applied and the application confirmed it',
      all: [{ kind: 'urlMatches', pattern: '/members/[^/]+/hold/post' }],
      any: [
        { kind: 'textPresent', text: 'HOLD APPLIED' },
        { kind: 'textPresent', text: 'Confirmation' },
      ],
      timeoutMs: 15000,
      pollMs: 250,
    },
  },
];

const store = new CapabilityStore(resolvePath('capabilities'));

for (const c of COMPLETIONS) {
  let capability: Capability;
  try {
    capability = store.load(c.capability);
  } catch {
    console.log(`skip ${c.capability} — not recorded yet`);
    continue;
  }

  const steps = capability.spec.steps;
  const last = steps[steps.length - 1];
  if (!last) {
    console.log(`skip ${c.capability} — no steps`);
    continue;
  }

  // Applied on every run, including to an already-completed artifact: a
  // re-recording brings the model's own "…and stopped at the confirmation
  // screen" summary back with it, and that description is what an agent reads
  // before deciding whether this capability is safe to call.
  const titleWasStale = capability.metadata.title !== c.title;
  capability.metadata.title = c.title;
  capability.metadata.summary = c.summary;

  if (steps.some((s) => s.guard.risk === 'irreversible')) {
    if (titleWasStale) {
      store.save(capability);
      console.log(`${c.capability} — posting step already present; corrected the description`);
    } else {
      console.log(`skip ${c.capability} — already complete`);
    }
    continue;
  }

  const id = `s${steps.length + 1}`;
  const step: Step = {
    id,
    intent: c.intent,
    action: {
      type: 'click',
      target: {
        description: `the ${c.control} control on the ${c.reviewHeading} screen`,
        role: 'button',
        name: c.control,
        nameMatch: 'normalized',
        scope: { framePath: ['main'], heading: c.reviewHeading },
        anchors: [{ relation: 'nearHeading', text: c.reviewHeading }],
        hints: { proximateLabels: [] },
      },
    },
    guard: { risk: 'irreversible', note: c.note },
    checkpoint: c.posted,
    conditions: [],
    optional: false,
  };

  steps.push(step);

  // The run's own success condition moves to the posted state. Leaving it on the
  // review screen would mean a run that stopped for a human — correctly — could
  // still report `success`, which is the one thing the result contract must
  // never do.
  capability.spec.successCheckpoint = {
    describe: `the ${c.capability.replace(/_/g, ' ')} was posted and the application confirmed it`,
    all: c.posted.all,
    any: c.posted.any,
    timeoutMs: 15000,
    pollMs: 250,
  };

  // Say plainly that this artifact was not produced by one clean discovery run.
  // A provenance block that claimed otherwise would be the most quietly
  // misleading thing in the repository.
  capability.metadata.provenance.handCompleted =
    `step ${id} (${c.control}) was authored by a person, not recorded: policy refuses ` +
    `irreversible actions during discovery, so the agent recorded up to the review screen ` +
    `and stopped. See scripts/complete-posting-steps.ts.`;

  const path = store.save(capability);
  console.log(`completed ${c.capability} — added ${id} "${c.control}" (irreversible) -> ${path}`);
}
