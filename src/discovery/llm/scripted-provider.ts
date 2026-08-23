/**
 * Scripted provider.
 *
 * Not a fake model — a *fixture*. It resolves each turn by matching the current
 * screen against a small rule set and returning the tool call a competent model
 * would make there. It never guesses: if no rule matches the screen it raises,
 * which is what you want from a fixture (a silent wrong answer would make the
 * offline demo lie about whether the pipeline works).
 *
 * It exists for three reasons:
 *
 *   1. The discovery pipeline — trace capture, artifact compilation, evidence —
 *      can be developed and regression-tested deterministically, without paying
 *      for tokens or depending on a model behaving identically twice.
 *   2. Reviewers without an API key can still run the full end-to-end thread.
 *   3. It isolates blame. When a live discovery run fails, running the same goal
 *      against this provider says immediately whether the loop broke or the
 *      model did.
 *
 * It is NOT a substitute for the real thing, and the README says so: the
 * committed discovery evidence comes from a live model run.
 */

import type { DecideRequest, LlmProvider, ModelTurn } from './llm-provider.js';

type FindElement = (...needles: string[]) => string | undefined;

interface Rule {
  name: string;
  when: (screen: string) => boolean;
  then: (screen: string, find: FindElement) => ModelTurn | undefined;
}

export class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-fixture';
  private calls = 0;

  constructor(private readonly goalValues: Record<string, string> = {}) {}

  /**
   * The rendered inventory lines look like:
   *   [e12] textbox  name="" labels=["Member ID"] frame=main/contentFrame
   *   [e21] cell     text="$8,412.55" col="Current Balance" row=["4820117735","Savings",…]
   *
   * so the fixture locates an element the same way a person reading the screen
   * would — by what it is called and what is around it. All needles must appear
   * on the same line, which is what lets "the balance cell in the Savings row"
   * be expressed precisely rather than by position.
   */
  private static find(userText: string, needles: string[]): string | undefined {
    const wanted = needles.map((n) => n.toLowerCase());
    for (const line of userText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('[e')) continue;
      const lower = trimmed.toLowerCase();
      if (!wanted.every((n) => lower.includes(n))) continue;
      const m = /^\[(e\d+)\]/.exec(trimmed);
      if (m) return m[1];
    }
    return undefined;
  }

  private rules(): Rule[] {
    const memberId = this.goalValues.memberId ?? '10001';
    return [
      {
        name: 'sign-on screen',
        when: (s) => s.includes('Staff Sign On'),
        then: () => ({
          reasoning:
            "The session is not authenticated. Signing on is the runtime's responsibility, not part of the " +
            'capability, so I should stop rather than record credentials into a flow.',
          toolName: 'give_up',
          arguments: { why: 'the surface is showing the sign-on screen; no authenticated session was established' },
        }),
      },
      {
        name: 'landing page',
        when: (s) => s.includes('Welcome to the Servicing Console'),
        then: (_s, find) => {
          const e = find('link', 'member search') ?? find('link', 'find member');
          if (!e) return undefined;
          return {
            reasoning: 'The left-hand menu offers member search, which is where a lookup flow has to start.',
            toolName: 'click',
            arguments: { elementId: e, why: 'Open the member search screen from the left-hand menu.' },
          };
        },
      },
      {
        name: 'search form, identifier not yet entered',
        when: (s) => s.includes('numeric member identifier') && !s.includes(`value="${memberId}"`),
        then: (_s, find) => {
          const e = find('textbox', '"member id"') ?? find('textbox', '"member number"') ?? find('textbox');
          if (!e) return undefined;
          return {
            reasoning:
              'The search form has one identifier field. It has no accessible name; the caption beside it reads ' +
              '"Member ID", which is how a human would identify it.',
            toolName: 'type',
            arguments: { elementId: e, text: memberId, why: 'Type the member identifier into the search field.' },
          };
        },
      },
      {
        name: 'search form, ready to submit',
        when: (s) => s.includes('numeric member identifier'),
        then: (_s, find) => {
          const e = find('button');
          if (!e) return undefined;
          return {
            reasoning: 'The identifier is entered; submitting the form should take us to the member record.',
            toolName: 'click',
            arguments: { elementId: e, why: "Submit the search and land on the member's detail screen." },
          };
        },
      },
      {
        name: 'member detail',
        when: (s) => s.includes('Member Detail'),
        then: (_s, find) => {
          const balance = find('cell', 'col="current balance"', 'savings');
          if (!balance) return undefined;
          return {
            reasoning:
              'The member detail screen is showing the accounts table. The savings balance is the cell in the ' +
              '"Current Balance" column of the row whose account type is Savings.',
            toolName: 'finish',
            arguments: {
              why: 'Reached the member detail screen and located the savings balance.',
              summary: "look up a member and read their savings share account balance",
              outputs: [
                {
                  name: 'savingsBalance',
                  elementId: balance,
                  description: "Current balance of the member's savings share account, in USD.",
                },
              ],
            },
          };
        },
      },
    ];
  }

  async decide(req: DecideRequest): Promise<ModelTurn> {
    this.calls += 1;
    const screen = req.userText;
    for (const rule of this.rules()) {
      if (!rule.when(screen)) continue;
      const turn = rule.then(screen, (...needles) => ScriptedProvider.find(screen, needles));
      if (turn) return turn;
      throw new Error(
        `the scripted provider matched its "${rule.name}" rule but could not find the element it expected ` +
          `on screen. This is a fixture problem, not a model problem.`,
      );
    }
    throw new Error(
      'the scripted provider has no rule for this screen. It deliberately refuses to guess — ' +
        'run with --provider openai for a screen it has not been taught.',
    );
  }

  usage(): { promptTokens: number; completionTokens: number; calls: number } {
    return { promptTokens: 0, completionTokens: 0, calls: this.calls };
  }
}
