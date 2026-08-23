/**
 * What the model sees, and what it is allowed to say back.
 *
 * The central constraint: **the model acts by element id, never by selector and
 * never by raw coordinate.** It is handed an inventory of what is currently
 * perceivable, each entry with a short id, and every tool takes one of those
 * ids. This is not a stylistic preference:
 *
 *   - it makes the abstraction structural rather than aspirational — there is no
 *     way for a selector to reach the artifact, because the model never had one;
 *   - it removes a whole failure class (a hallucinated coordinate clicks
 *     *something*; a hallucinated element id resolves to nothing and is caught);
 *   - it is the same contract a desktop surface would offer, so the prompt does
 *     not need rewriting when the surface changes.
 *
 * The screenshot is supplied as corroboration, not as the action space.
 */

import type { ElementNode, Observation } from '../surface/types.js';
import { isInteractive } from '../surface/web/accessibility-tree.js';
import type { ToolDefinition } from './llm/llm-provider.js';

export function systemPrompt(opts: { product: string; allowedOrigins: string[] }): string {
  return `You are operating a back-office banking application on behalf of a bank employee, in order to
work out how a task is done. What you discover will be recorded and replayed later WITHOUT you, so
prefer the plain, obvious route a trained operator would take over anything clever.

APPLICATION: ${opts.product}
PERMITTED ORIGINS: ${opts.allowedOrigins.join(', ')}

HOW YOU SEE THE SCREEN
You are given an inventory of everything currently perceivable, taken from the accessibility tree,
plus a screenshot. Each line looks like:

  [e12] textbox   name=""            labels=["Member ID"]      frame=main/contentFrame
  [e14] button    name="Search"                                frame=main/contentFrame
  [e21] cell      text="$8,412.55"   col="Current Balance"     row=["4820117735","Savings","$8,412.55"]

  - name    is the accessible name. Legacy forms often leave text inputs with NO name.
  - labels  is the caption physically beside the control. For an unnamed input this IS its identity.
  - col/row identify a table cell by its column header and the contents of its row.

HOW YOU ACT
Call exactly one tool per turn, always naming an element by the id in square brackets.
Never invent an id. Never describe a CSS selector or a screen coordinate — you cannot use them.

RULES
1. Take the direct path. Do not explore, do not open things to "check", do not go back and forth.
2. NEVER take an action that cannot be undone — submitting an application, posting a transfer,
   deleting a record, approving anything. If the task requires one, call give_up and explain.
   A human decides those. This is not negotiable and you will be blocked if you try.
3. If a screen shows an error, a "no records found" result, or a permission refusal, that is an
   ANSWER, not an obstacle. Call give_up and say what the screen said. Do not try other values.
4. If the sign-on screen appears, stop. Authentication is handled outside the flow you are recording.
5. When the goal is achieved, call finish and name the elements holding each value that was asked
   for, so they can be extracted on every future run.

Explain your reasoning in the 'why' argument of every call, in one sentence, as an instruction a
colleague could follow — it becomes the human-readable description of this step.`;
}

/**
 * Renders an observation for the model.
 *
 * Interactive controls first and in full, because those are the action space.
 * Content elements are trimmed hard: a legacy page can carry hundreds of text
 * nodes, and burying the six buttons among them measurably degrades the model's
 * choices as well as costing tokens.
 */
export function renderObservation(obs: Observation, goal: string, stepsTaken: number, maxSteps: number): string {
  const lines: string[] = [];

  lines.push(`GOAL: ${goal}`);
  lines.push(`STEP: ${stepsTaken + 1} of at most ${maxSteps}`);
  lines.push('');
  lines.push(`LOCATION: ${obs.signals.url}`);
  if (obs.signals.frameUrls.length > 1) {
    lines.push(`FRAMES:   ${obs.signals.frameUrls.filter((u) => u !== 'about:blank').join('  |  ')}`);
  }
  lines.push(`TITLE:    ${obs.signals.title}`);
  lines.push('');

  const interactive = obs.elements.filter((e) => isInteractive(e.role));
  lines.push(`CONTROLS YOU CAN ACT ON (${interactive.length}):`);
  for (const e of interactive) lines.push(`  ${describe(e)}`);
  if (interactive.length === 0) lines.push('  (none — the screen has no actionable controls)');
  lines.push('');

  const cells = obs.elements.filter((e) => e.context.columnHeader);
  if (cells.length) {
    lines.push(`TABLE CELLS (${cells.length}):`);
    for (const e of cells.slice(0, 40)) lines.push(`  ${describe(e)}`);
    lines.push('');
  }

  const headings = obs.elements.filter((e) => e.role === 'heading' && e.name);
  if (headings.length) {
    lines.push(`HEADINGS: ${headings.map((h) => `"${h.name}"`).join(', ')}`);
    lines.push('');
  }

  lines.push('PAGE TEXT:');
  lines.push(obs.signals.visibleText.slice(0, 2000));

  return lines.join('\n');
}

function describe(e: ElementNode): string {
  const bits = [`[${e.id}]`, e.role.padEnd(11)];
  bits.push(`name=${JSON.stringify(e.name)}`);
  if (e.proximateLabels.length) bits.push(`labels=${JSON.stringify(e.proximateLabels)}`);
  if (e.value) bits.push(`value=${JSON.stringify(e.value)}`);
  if (e.context.columnHeader) bits.push(`col=${JSON.stringify(e.context.columnHeader)}`);
  if (e.context.rowCells?.length) bits.push(`row=${JSON.stringify(e.context.rowCells.slice(0, 4))}`);
  if (e.states.includes('disabled')) bits.push('DISABLED');
  bits.push(`frame=${e.framePath.join('/')}`);
  return bits.join(' ');
}

/* ------------------------------------------------------------------ tools */

const why: Record<string, unknown> = {
  type: 'string',
  description: 'One sentence, phrased as an instruction a colleague could follow. Becomes this step\'s description.',
};

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'click',
    description: 'Click a control — a link, button, tab or checkbox — by its element id.',
    parameters: {
      type: 'object',
      properties: { elementId: { type: 'string', description: 'e.g. "e12"' }, why },
      required: ['elementId', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'type',
    description: 'Type text into a field, replacing anything already in it.',
    parameters: {
      type: 'object',
      properties: { elementId: { type: 'string' }, text: { type: 'string' }, why },
      required: ['elementId', 'text', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'select',
    description: 'Choose an option in a dropdown, by its visible text.',
    parameters: {
      type: 'object',
      properties: { elementId: { type: 'string' }, value: { type: 'string' }, why },
      required: ['elementId', 'value', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'press',
    description: 'Press a named key, e.g. Enter or Tab.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' }, why },
      required: ['key', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description:
      'The goal has been achieved and the current screen proves it. Name the element holding each value ' +
      'the goal asked for, so future runs can extract it without you.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What this flow accomplishes, one sentence.' },
        outputs: {
          type: 'array',
          description: 'Values the caller asked for. Empty if the goal was purely navigational.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'lowerCamelCase identifier, e.g. savingsBalance' },
              elementId: { type: 'string', description: 'the element currently displaying this value' },
              description: { type: 'string' },
            },
            required: ['name', 'elementId', 'description'],
            additionalProperties: false,
          },
        },
        why,
      },
      required: ['summary', 'outputs', 'why'],
      additionalProperties: false,
    },
  },
  {
    name: 'give_up',
    description:
      'Stop. Use this when the screen has answered the question in the negative (no such record, access ' +
      'denied, validation error), when the task needs an irreversible action, or when you are stuck.',
    parameters: {
      type: 'object',
      properties: { why: { type: 'string', description: 'What the screen said, or what is blocking you.' } },
      required: ['why'],
      additionalProperties: false,
    },
  },
];
