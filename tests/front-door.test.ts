/**
 * The doors onto the engine, and the properties that must hold at each of them.
 *
 * The panel, the chat endpoint and the operator transport were the untested part
 * of this system, which was uncomfortable given they are now the parts a person
 * actually touches. These are not UI tests — they are tests of the four claims
 * the front doors make about safety and honesty:
 *
 *   1. A caller-supplied target URL cannot move a run off the allowlist.
 *   2. The chat's streaming transport reports a run BEFORE it finishes, which is
 *      the whole reason it streams.
 *   3. The discovery fallback cannot become a route to an irreversible action.
 *   4. An un-claimed operator cannot drive a parked session.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { Policy } from '../src/policy/guardrails.js';
import { AppProfileSchema, tenantOf } from '../src/capability/application-profile.js';
import { resolveEntryUrl, EntryUrlError } from '../src/discovery/entry-url.js';
import { ControlAuthority } from '../src/escalation/control-authority.js';
import { InterventionBroker, newInterventionId } from '../src/escalation/intervention-broker.js';

const profile = AppProfileSchema.parse(parseYaml(readFileSync('config/apps/meridian-core.yaml', 'utf8')));
const policy = Policy.fromFile('config/policy.meridian.json');
const tenant = tenantOf(profile, 'meridian');

/** A click on whatever `targetName` names — risk comes from the context, not the node. */
const click = { type: 'click' as const, target: { kind: 'observed' as const, elementId: 'e1' } };

/* ------------------------------------------------- 1. the target URL seam */

describe('a caller-supplied target URL', () => {
  it('is accepted when it is on the allowlist', () => {
    expect(resolveEntryUrl(policy, tenant, 'https://web-sample.interface-hiring.com/members')).toBe(
      'https://web-sample.interface-hiring.com/members',
    );
  });

  it('falls back to the tenant entry point when omitted', () => {
    expect(resolveEntryUrl(policy, tenant)).toBe('https://web-sample.interface-hiring.com/');
    expect(resolveEntryUrl(policy, tenant, '   ')).toBe('https://web-sample.interface-hiring.com/');
  });

  it('refuses an origin that is not on the allowlist', () => {
    // The load-bearing one. `(goal, target_url)` is a request to point the
    // automation somewhere new, and if a flag could do that the allowlist would
    // be advisory rather than a containment boundary.
    expect(() => resolveEntryUrl(policy, tenant, 'https://evil.example.com/members')).toThrow(EntryUrlError);
    expect(() => resolveEntryUrl(policy, tenant, 'http://localhost:4200/')).toThrow(EntryUrlError);
  });

  it('refuses a denied route even on an allowed origin', () => {
    // /settings is MERIDIAN's own fault-injection console. A system that could
    // arm the errors it reports would not be evidence of anything.
    expect(() => resolveEntryUrl(policy, tenant, 'https://web-sample.interface-hiring.com/settings')).toThrow(
      /explicitly denied/,
    );
  });

  it('refuses a URL that is not absolute, rather than guessing an origin for it', () => {
    expect(() => resolveEntryUrl(policy, tenant, '/members/103001')).toThrow(/not a valid absolute URL/);
  });

  it('names the allowed origins in the refusal', () => {
    // The error is read by someone who has just been told no. It should say what
    // would have been allowed and that widening it is a policy edit.
    expect(() => resolveEntryUrl(policy, tenant, 'https://evil.example.com/')).toThrow(
      /web-sample\.interface-hiring\.com/,
    );
  });
});

/* ------------------------------- 3. the discovery fallback cannot post ---- */

describe('the chat discovery fallback', () => {
  it('cannot reach an irreversible action, however it is asked', () => {
    // `discover_capability` runs the same loop the goal form runs, under
    // `mode: 'discovery'` — where an irreversible action is refused
    // unconditionally, with no authorisation that could unlock it. This is what
    // makes a natural-language front door over a banking console defensible: the
    // fallback is not a longer route to the same button.
    // Each on its own review screen, because the rules are route-scoped as well
    // as name-scoped — "Open Share" is only the irreversible control on the
    // open-share flow, and testing it against the transfer route would assert
    // something weaker than it looks.
    const controls = [
      ['Post Transfer', '/members/103001/transfer/review'],
      ['Apply Hold', '/members/103001/hold/review'],
      ['Open Share', '/members/103001/open-share/review'],
    ] as const;

    for (const [name, route] of controls) {
      const decision = policy.check(click, {
        mode: 'discovery',
        url: `https://web-sample.interface-hiring.com${route}`,
        targetName: name,
        irreversibleAuthorized: true, // even so
      });
      expect(decision.risk).toBe('irreversible');
      expect(decision.allowed).toBe(false);
      // A human could complete it, so this escalates rather than hard-fails.
      expect(decision.escalatable).toBe(true);
    }
  });

  it('still allows the read-only actions a lookup needs', () => {
    const decision = policy.check(click, {
      mode: 'discovery',
      url: 'https://web-sample.interface-hiring.com/members',
      targetName: 'Search',
      irreversibleAuthorized: false,
    });
    expect(decision.allowed).toBe(true);
  });
});

/* ------------------------------------ 4. the operator transport's gate ---- */

describe('the intervention transport', () => {
  /** A parked run, with a surface that records what it was asked to do. */
  function parked() {
    const authority = new ControlAuthority('run-under-test');
    const broker = new InterventionBroker({ waitMs: 50 });
    const dispatched: unknown[] = [];
    const surface = {
      dispatchHumanInput: (token: unknown, event: unknown) => {
        authority.assert(token as never, 'human');
        dispatched.push(event);
      },
      startScreencast: () => Promise.resolve(() => Promise.resolve()),
    };
    const id = newInterventionId();
    return { authority, broker, surface, dispatched, id };
  }

  it('refuses input from a viewer who has not claimed the session', () => {
    const { broker, id } = parked();
    // Viewing needs no claim, so nothing here has claimed. Asking the broker for
    // an operator token is what the WS bridge does on every input event, and it
    // is what must fail.
    expect(() => broker.operatorToken(id)).toThrow();
  });

  it('invalidates the operator token once control is handed back', async () => {
    const { authority, broker, surface, id } = parked();

    const raised = broker.raise(
      {
        id,
        capability: { name: 'funds_transfer', version: '1.0.0', title: 'Post a transfer' },
        tenant: 'meridian',
        atStep: { id: 's10', intent: 'Click Post Transfer', index: 10, total: 10 },
        reasonClass: 'policy_irreversible',
        reason: 'irreversible step requires authorisation',
        params: {},
        resumeContract: { describe: 'the transfer was posted' },
      } as never,
      { authority, surface, onHumanAction: () => undefined } as never,
    );

    const { token } = broker.claim(id, 'someone');
    // Holding the token, the operator may act.
    expect(() => authority.assert(token, 'human')).not.toThrow();

    broker.handBack(id, 'done');
    await raised;

    // The same token afterwards. A console whose page is still open must not be
    // able to keep driving a session it no longer holds.
    expect(() => authority.assert(token, 'human')).toThrow();
  });
});

/* --------------------------------- 2. the chat stream reports early ------ */

describe('the chat SSE transport', () => {
  it('emits action_started with a run id before the run finishes', async () => {
    // The reason the endpoint streams at all. A capability invocation drives a
    // real browser for tens of seconds; if the run id only arrived with the
    // final answer, the client could not subscribe to the step stream and the
    // most interesting part of the system would be invisible to the person who
    // asked for it.
    const { mountChat } = await import('../src/api/chat.js');

    const frames: Array<{ type: string; data: Record<string, unknown> }> = [];
    let finishRun: (r: unknown) => void = () => undefined;
    const runFinished = new Promise((r) => {
      finishRun = r;
    });

    // A minimal Express double: capture the handler mountChat registers.
    let handler!: (req: unknown, res: unknown) => Promise<void>;
    const app = { post: (_p: string, h: typeof handler) => (handler = h) };

    const capability = { metadata: { name: 'get_balance', version: '1.0.0' }, spec: { inputs: [] } };

    mountChat(app as never, {
      catalog: { tools: () => [{ name: 'get_balance', description: 'read a balance', parameters: {} }] },
      // `description` and `chat` are what the system prompt is built from, so a
      // double that omits them is not a double of a profile — the schema
      // guarantees both on anything loaded from disk.
      profile: {
        product: 'meridian-core',
        description: 'A member-servicing console.',
        chat: { audience: 'Tellers and supervisors.', suggestions: [] },
        identities: {},
        tenants: [],
      },
      defaultTenantId: 'meridian',
      operatorUrl: 'http://localhost:4100',
      providerConfigured: () => true,
      createProvider: () => ({
        name: 'stub',
        model: 'stub',
        usage: () => ({ promptTokens: 0, completionTokens: 0, calls: 1 }),
        decide: vi
          .fn()
          .mockResolvedValueOnce({ reasoning: 'read it', toolName: 'get_balance', arguments: {} })
          .mockResolvedValue({ reasoning: '', toolName: 'reply_to_user', arguments: { message: 'done' } }),
      }),
      prepareInvocation: () => ({ capability, tenantId: 'meridian' }),
      beginReplay: () => ({ id: 'run-1', evidenceDir: 'evidence/runs/replay-run-1', done: runFinished }),
      prepareDiscovery: () => {
        throw new Error('not used');
      },
      beginDiscovery: () => {
        throw new Error('not used');
      },
      watchRun: () => () => undefined,
    } as never);

    const res = {
      writeHead: () => undefined,
      write: (chunk: string) => {
        const type = /event: (.+)/.exec(chunk)?.[1] ?? '';
        const data = /data: (.+)/.exec(chunk)?.[1] ?? '{}';
        frames.push({ type, data: JSON.parse(data) as Record<string, unknown> });
      },
      end: () => undefined,
      json: () => undefined,
      status: () => res,
    };

    const done = handler(
      {
        body: { messages: [{ role: 'user', content: 'read the balance' }] },
        get: (h: string) => (h.toLowerCase() === 'accept' ? 'text/event-stream' : ''),
      },
      res,
    );

    // Let the model turn and the launch resolve, but NOT the run itself.
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'action_started')).toBe(true));

    const started = frames.find((f) => f.type === 'action_started')!;
    expect(started.data.runId).toBe('run-1');
    expect(started.data.capability).toBe('get_balance');
    // The claim under test: this arrived while the run was still going.
    expect(frames.some((f) => f.type === 'action_result')).toBe(false);

    finishRun({ status: 'success', capability: 'get_balance', capabilityVersion: '1.0.0', tenant: 'meridian', runId: 'run-1', evidenceDir: 'e', durationMs: 1, outputs: { shareBalance: 1 } });
    await done;

    expect(frames.map((f) => f.type)).toEqual(['action_started', 'action_result', 'reply']);
  });
});
