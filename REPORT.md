# Design write-up

## 1. Architecture

### 1.1 The spine

Teach an agent a back-office flow **once** with a model; replay it **forever**
without one. Everything else follows from that sentence.

```
                    ┌──────── DISCOVERY — a model is in the loop ─────────┐
   goal + params ──▶│  observe ─▶ decide ─▶ act,  until finish / give_up  │
   + entry URL      │  produces a TRACE, never a capability               │
                    └────────────────────────┬───────────────────────────┘
                                             │
                          trace-compiler.ts  │  deterministic. The model's
                                             ▼  influence ends at this line.
                          capabilities/<name>@<semver>.yaml
                          a reviewable, versioned CONTRACT
                                             │
                       human review ────────▶│  approval: draft ─▶ approved
                                             │
                    ┌────────────────────────▼───────────────────────────┐
   typed args ─────▶│  REPLAY — no model imported, transitively or not   │
   + authorisation  │  step ─▶ resolve ─▶ policy ─▶ act ─▶ checkpoint    │
                    └────────────────────────┬───────────────────────────┘
                                             ▼
                 success │ business_outcome │ escalated │ failed
```

Four ideas carry the weight, and each is a boundary drawn where a real
deployment would cut:

- **A capability is an API, not a macro.** It declares typed inputs, typed
  outputs, and the business outcomes a caller should expect — so an agent can
  reason about it before invoking it.
- **The model produces a trace; deterministic code produces the artifact.** The
  compiler takes three things from the model and nothing else: the order of
  actions, which element each touched, and a one-sentence `why`.
- **Everything meets the world through one function.** `Surface.act()` is where
  the allowlist, the risk policy and control ownership are enforced, for both
  loops, so they cannot drift apart in what they are permitted to do.
- **A run ends in exactly four ways.** No fifth state where something ambiguous
  can hide, and `business_outcome` is structurally distinct from `failed`.

### 1.2 The agentic loop

The only place a language model touches an application is
[`src/discovery/loop.ts`](src/discovery/loop.ts). It is deliberately the cheapest
part of the system to throw away.

```
   sign on          a PRECONDITION the runtime satisfies from the environment.
      │             The model never sees a credential and never discovers
      │             the sign-on flow — which is what lets one artifact
      ▼             replay under any operator identity.
 ╔════╧═══════ up to maxSteps ════════════════════════════════════════════╗
 ║                                                                        ║
 ║  1. OBSERVE  the accessibility tree, flattened into elements each       ║
 ║              carrying a LOCAL id (e14), plus geometry and a screenshot  ║
 ║                       │                                                ║
 ║  2. RENDER   ─────────▼───────  the text the model reads:               ║
 ║              GOAL · STEP n of m · LOCATION · CONTROLS · TABLE CELLS     ║
 ║              (60) · LABELLED VALUES (40) · PAGE TEXT (2 000 chars)      ║
 ║              written verbatim to observation-NN.json — the audit        ║
 ║              record of a model input                                    ║
 ║                       │                                                ║
 ║  3. DECIDE   ─────────▼───────  ONE tool call and a reason.             ║
 ║              The tool set is BUILT FROM THE POLICY, so the model is     ║
 ║              never offered an action policy would refuse.               ║
 ║                       │                                                ║
 ║  4. ROUTE    ─────────▼───────                                          ║
 ║              finish   ─▶ every claimed output must resolve to an        ║
 ║                          element id in the CURRENT observation, or it   ║
 ║                          is dropped. Success is not the model's word.   ║
 ║              give_up  ─▶ does the product's own condition taxonomy      ║
 ║                          call this screen a business outcome?           ║
 ║                            yes ─▶ BUSINESS_OUTCOME (no human paged)     ║
 ║                            no  ─▶ escalate to a person                  ║
 ║              bad id   ─▶ reject the turn; twice running ends the run    ║
 ║                       │                                                ║
 ║  5. ACT      ─────────▼───────  surface.act(action, token)              ║
 ║              Policy is checked HERE, at the surface, not on the         ║
 ║              intent — and again at the network layer, so an in-page     ║
 ║              redirect off the allowlist is stopped even though no       ║
 ║              action was taken. An irreversible action is refused        ║
 ║              outright during discovery, at any confidence.              ║
 ║                       │                                                ║
 ║  6. RECORD   ─────────▼───────  observe again; append a trace step      ║
 ║              describing what the screen became                          ║
 ╚═══════════════════════╤════════════════════════════════════════════════╝
                         ▼
                   DiscoveryTrace ──▶ compiler ──▶ draft artifact
```

Five properties make this an engineering loop rather than a demo:

**The model never receives a selector and never emits one.** It is given element
ids local to the observation it was just shown, and any id that is not in that
observation is refused. The worst a hallucination can do is waste one turn.

**The tool set is derived from policy.** `toolsPermittedBy(policy.actions)`
builds the function definitions, so "the model tried something it should not
have" is a class of problem that cannot arise.

**Policy is enforced at the surface, not on the intent.** Checking the intent
tells you where the model *meant* to go; checking at `act()` tells you where the
browser actually went. A page that redirects on click is the difference.

**A policy refusal ends the run.** It is not an error to route around. A loop
that treats a refusal as retryable is a loop that eventually finds a way past it.

**A declared business answer is not an escalation.** A goal naming a member who
does not exist used to end as "the agent got stuck" and page a human to come and
read a screen that said, in words, RECORD NOT FOUND. It now consults the same
per-product condition taxonomy replay uses, and returns `MEMBER_NOT_FOUND`.
Escalation is reserved for a model that is genuinely stuck.

There is a second, much smaller loop in [`src/api/chat.ts`](src/api/chat.ts) that
routes a sentence to a capability. It reuses the same `LlmProvider.decide()` seam
rather than adding another, its tool set is the capability catalog plus
`reply_to_user` and `discover_capability`, and it never touches a browser itself.
Full flowcharts for both, and for escalation, are in [FLOWS.md](FLOWS.md).

### 1.3 Replay, where no model runs

```
  typed args ─▶ validate against the artifact's JSON Schema
                          │  a bad argument is rejected before a browser starts
                          ▼
                apply this tenant's overrides
                          ▼
                ensure an authenticated session
                          ▼
  ╔═══════════ for each step ═══════════════════════════════════════════╗
  ║  resolve  by role + visible name + anchors, never a CSS selector,    ║
  ║           scoring confidence and reporting drift when it falls back  ║
  ║      ▼                                                               ║
  ║  policy   ─── denied, irreversible ──▶ ESCALATE (a human may do it)  ║
  ║           ─── denied, off-allowlist ─▶ FAILED   (no one may consent) ║
  ║      ▼                                                               ║
  ║  act                                                                 ║
  ║      ▼                                                               ║
  ║  classify against product + tenant conditions, in order:             ║
  ║           business ──▶ BUSINESS_OUTCOME   (an answer, not a failure) ║
  ║           recover  ──▶ one of five handlers, bounded, then re-check  ║
  ║           fail     ──▶ FAILED, diagnosed rather than timed out       ║
  ║      ▼                                                               ║
  ║  poll the checkpoint                                                 ║
  ╚═════════════════════════╤═══════════════════════════════════════════╝
                            ▼
              success checkpoint (polled, not evaluated once)
                            ▼
                    extract declared outputs
                            ▼
                         SUCCESS
```

Two details in that diagram are the result of real bugs rather than foresight.
Classification runs on **every poll** of a checkpoint wait, which is why
`MEMBER_NOT_FOUND` returns in a few hundred milliseconds instead of after a
twelve-second deadline that was never going to be met. And the success
checkpoint is **polled**, because it fires at the least-settled instant of the
whole run — evaluating it once is how you get an engine that works four times in
five.

### 1.4 The decisions behind it

TypeScript on Node, Playwright, Zod, Vitest. Playwright for raw CDP access —
needed for the accessibility tree with coordinates, screencast frames for the
handoff, and synthetic input into a live session. Zod because the artifact schema
must be one source of truth for three consumers: TypeScript types, runtime
validation of hand-edited YAML, and the JSON Schema an agent calls it with.

One process, synchronous, no queue. Boundaries are module seams, not network
hops, drawn where a real deployment would cut: `Surface`, `EscalationSink`,
`LlmProvider`, and the capability store.

**The central seam is `Surface`.** Two methods, mentioning neither DOM nor HTTP:

```ts
observe(): Promise<Observation>          // role, name, value, bounds, context
act(action, token): Promise<ActResult>   // the single chokepoint
```

Everything downstream — schema, resolver, executor, classifier, escalation — is
written against those types. Adding a desktop surface means writing one class.
The mapping, including what would genuinely need adjusting, is in
[`src/surface/desktop/README.md`](src/surface/desktop/README.md).

**Perception is accessibility-tree-first.** `Accessibility.getFullAXTree` joined
with `DOM.getBoxModel` for geometry. Three reasons in order of weight: it is the
same abstraction Windows UIA and macOS AX expose, so the desktop story is real
rather than aspirational; it is what a human operator perceives, and a vendor
cannot change a visible caption without their staff noticing; and legacy apps
have generated ids and no test IDs, so the DOM offers nothing durable anyway.

**`act()` is one chokepoint, and both paths go through it.** Discovery names
elements by an id from the observation it was just given; the executor names them
by a persisted descriptor. Both arrive at the same function, where allowlist,
risk policy and control-token ownership are enforced together. Discovery and
replay cannot drift apart in what they may do, because one place decides.

**The model's blast radius is small.** It produces a *trace*, never an artifact.
A deterministic compiler turns the trace into the capability, taking only three
things from the model: the order of actions, which element each touched, and a
one-sentence `why` that becomes prose. Locators come from what perception
recorded, checkpoints from the observed state transition, risk classes from
policy, the error taxonomy from the product profile. A model is good at "which
link finds a member" and unreliable at "what regex asserts we arrived".

**Model choice is a deployment decision.** `LlmProvider` asks exactly one
question — given what you can see, which single tool next. The committed
discovery evidence was produced by `openai/gpt-oss-120b` on Groq, an open-weight
model with **no vision at all**, and the loop needed no changes: the model acts
by element id from a text inventory, so screenshots were always corroboration
rather than the action space. They are still captured as evidence, and only
*sent* when a provider declares `supportsVision`. Which models actually suit each
job, and what I would pick given a budget, is §9.9.

**Every surface is a projection of one engine.** Four ways reach the same code —
CLI, agent catalog, web control panel, operator console — and none is a second
implementation. The panel may compose `Catalog`, `replay()` and `RunRecorder`
and reimplement none of them, so a browser run takes the identical path as
`npm run replay`. It reads `config/policy.json` live rather than restating it: a
safety page that can drift out of agreement with the safety layer is worse than
no safety page.

**Trade-off I would flag.** Perceiving the full AX tree every observation costs a
few hundred milliseconds per step. It is what makes the surface portable and
ambiguity detectable at all, but at volume it would want incremental updates.

---

## 2. Artifact schema

**A capability is an API, not a macro.** A step list tells you what keys were
pressed. An API tells a caller what it needs, what it returns, and what can happen
instead. Both the agent invoking it and the human approving it need the second.

[`src/capability/schema.ts`](src/capability/schema.ts) is the definition;
[`capabilities/lookup_member_savings_balance@1.0.0.yaml`](capabilities/lookup_member_savings_balance@1.0.0.yaml)
is a worked example, hand-authored to prove the schema is human-writable. Four
decisions are load-bearing:

- **Business outcomes are declared in the contract.** `spec.outcomes.business`
  lists every legitimate non-success answer. This is a *schema* decision: with
  nowhere to declare "no such member", the executor must throw and the caller
  must treat it as a failure. Declaring them makes `business_outcome` a
  first-class result, and an agent sees the answer space before it invokes.
- **Steps carry `intent` prose beside the machine-readable target.** It is what a
  reviewer reads, what an escalation shows an operator, and what a failure quotes
  — and it is *never* consulted to make a decision, so prose drift cannot change
  behaviour.
- **Values are parameter references, never captured literals.** The run typed
  `10001`; the artifact stores `{{memberId}}`. A structural guarantee rather than
  a redaction pass — there is no member data in the file to leak, so capabilities
  live in git and are reviewed in pull requests. A test asserts it.
- **Condition detectors are inherited from an app profile.** Session expiry looks
  identical on every screen of a product. Re-authoring it per recording gives you
  twenty capabilities that each handle timeouts slightly differently.

### The locator model

Where record-once/replay-many lives or dies. Enterprise selectors are generated
(`ctl00_ContentPlaceHolder1_txtMbrId`), churn across versions, and differ per
tenant. So an `ElementDescriptor` describes a control the way a human would:

| Signal | Survives a re-skin? | On desktop? |
|---|---|---|
| `role` | yes | yes |
| `name` (accessible name) | unless genuinely relabelled | yes |
| `anchors` — caption beside it, row, column header | yes | yes |
| `scope` — frame, container | yes | yes (window/pane) |
| `hints.domHint`, `hints.boundsAtRecord` | **no** | no |

Resolution is **scored candidate matching**, not lookup. `domHint` is named a
hint on purpose: 5 points out of ~100, enough to break a tie and never enough to
make a match, so a changed selector cannot break replay and a matching one cannot
rescue a mismatched name.

Two details I would defend hardest:

**Unnamed inputs.** Legacy forms put the caption in an adjacent `<td>` with no
`<label for>`, so Chromium computes an *empty* accessible name. Perception
recovers the association geometrically — text immediately left of, or directly
above, the control. It is what the human does, and it works on any surface
reporting bounds, including a screenshot. In a two-column form a left-hand
caption suppresses above-captions entirely, because the thing "above" an input is
the *previous row's* label; without that rule the resolver correctly but
uselessly reported everything as ambiguous.

**Table cells are addressed by position, never content.** A cell is "the Current
Balance column, in the row containing Savings" — never "the cell containing
$8,412.55", which works exactly once, and never a column index, which breaks when
a tenant reorders. The compiler enforces this, and prefers a categorical row key
(`Savings`) over a record identifier. It is the single reason the same artifact
reads the right number on Harbor's reordered build.

---

## 3. Determinism & error handling

No LLM is imported by [`src/replay/executor.ts`](src/replay/executor.ts),
transitively or otherwise.

```ts
type ReplayResult =
  | { status: 'success';          outputs, steps, driftSignals, evidenceDir }
  | { status: 'business_outcome'; code, message, conditionId, atStep }
  | { status: 'escalated';        interventionId, reason, resolution, atStep }
  | { status: 'failed';           error: { class, stepId, stepIntent,
                                           expected, observed, recoveriesTried } }
```

A business outcome is a *different arm of the union* from a failure, not a
failure with a nicer message. The types will not let you fudge it.

**Waiting and classifying are the same loop.** The naive structure — act, wait
for the checkpoint, and if it times out look for an explanation — reports a
12-second timeout when the app answered "No records found" instantly. So
classification runs on **every poll**, and a match short-circuits it.
`MEMBER_NOT_FOUND` returns in ~2 seconds. Classification also runs after every
*successful* step, because "No records found" appears on a page that loaded
perfectly and returned HTTP 200.

**A timeout is a diagnosis of last resort.** `checkpoint_failed` means "we waited
and nothing we know about explains why". With an application error injected the
result is `surface_error` with `observed: "Unexpected System Error"` at `s3` —
not a timeout. A timeout that could have been diagnosed is a tax paid by whoever
is on call at 2am.

| Order | Class | Response |
|---|---|---|
| 1 | **business** | stop cleanly, return the declared code, never throw |
| 2 | **recoverable** | run a handler from a **closed set**, bounded per-condition and globally, then re-verify |
| 3 | **hard failure** | stop; capture screenshot, AX snapshot and event tail; report step / expected / observed |

The recovery set is closed — `dismiss_dialog`, `wait_retry`, `reauthenticate`,
`navigate_back`. An open "run this to recover" hook would mean a reviewer
approving a capability could no longer tell what it might do, and would be the
natural place for a model to smuggle unreviewed behaviour into the deterministic
path.

### Three bugs worth reporting, because they were the real work

1. **Torn observations.** Perceiving the AX tree and reading page text are
   separate round trips, and a frameset navigates out from under you. Captured
   independently, the text came from the new screen and the inventory from the
   old — so a checkpoint passed while the elements satisfying it were absent.
   Fixed with a stability window: fingerprint every frame's location *and*
   `readyState`, capture, re-fingerprint, retry if anything moved.

2. **The accessibility tree lags the DOM.** The nasty one. Immediately after a
   navigation commits, a frame reports `readyState: "complete"` with fully
   populated `innerText` while `getFullAXTree` still returns a partial tree.
   Symptom: intermittent "declared output not found", about one run in three,
   never reproducible on inspection. Fixed by checking **text coverage** — if the
   tree accounts for less than half the document's text it is still under
   construction. A node count is not enough; the failing tree had a plausible
   handful of nodes and none of the table.

3. **A recovery is not finished when its action returns.** Dismissing a dialog
   posts a form. Re-classifying before the response landed saw the dialog still
   present, counted a recurrence, and burned the budget on a recovery that was
   working. Fixed by waiting until the triggering condition stops holding.

Twelve consecutive clean runs on the tenant that used to fail one in three.

**Drift, secondarily.** Every resolution reports its score and winning strategy.
A descriptor that used to match on accessible name and now matches only
structurally still works — and that degradation is the earliest, cheapest signal
that a tenant has moved. It costs nothing, because the resolver already computed
it. First Valley produces exactly one: their member-id field is relabelled,
resolves structurally at 0.571, and says so.

---

## 4. Heterogeneity & multi-tenant

### Surface abstraction

`ElementNode`'s vocabulary was chosen as the *intersection* of what browser AX,
Windows UIA and macOS AX expose — not as a browser abstraction with desktop
bolted on later. What would genuinely need adjusting: `urlMatches` has no desktop
analogue, and `domHint` becomes meaningless, which is the test of whether it was
correctly treated as a hint.

The legacy-web case is not hypothetical here — it is the only case. Frame-path
handling, geometric caption recovery and header-based table addressing all exist
because the target app demanded them.

One honest note on acting: the web surface clicks by coordinate, which is the
mechanism that ports. The exception is `select` on a native dropdown, driven
through the platform's semantic action because a native popup lives outside the
page's coordinate space. That is what UIA's `SelectionItemPattern` does — ask the
platform to perform the control's action — so it is a port, not a DOM shortcut.

### Multi-tenant reuse

Re-recording per tenant gives you N copies that drift independently, N places to
fix a bug, and no way to see how tenant 47 differs from the reference install.
So: **one base spec plus JSON-Pointer patches per tenant**, which makes the
*difference* the reviewable unit. Adding an institution is a config entry.

Demonstrated by one artifact against three installs:

- **Harbor CU** — newer build (9.0), accounts columns reordered, mandatory
  privacy acknowledgement. **Zero overrides.** The reorder is absorbed because
  cells are addressed by header and row; the extra screen is a condition declared
  on the *tenant*, which every capability for that product inherits.
- **First Valley** — two controls relabelled. **Two patches**, four lines, legible
  in a diff. A third difference is deliberately *not* patched: it resolves
  structurally and emits a drift signal, so the system reports its own degradation
  without breaking.

That split is the honest version: most variation is absorbed by the locator
model, genuine relabels need a patch, and the drift signal tells you which is
which — without re-recording.

**Drift detection at scale.** You do not diff screenshots; you watch how your
locators are winning. A tenant whose capabilities increasingly resolve via
fallback strategies has upgraded, and it surfaces before anything fails.
Aggregating those signals across tenants is the piece I did not build.

---

## 5. Escalation & handoff

Five conditions raise an intervention, each carrying *why* rather than a generic
failure: policy refuses an irreversible step (`policy_irreversible`); a condition
recurs past its budget (`unrecovered_condition`); a checkpoint fails with nothing
explaining it (`checkpoint_failed`); two candidates match too closely
(`ambiguous_target`); the discovery model gives up (`agent_stuck`). Discovery
escalates through the same broker and control model as replay.

**Control is a capability token, not a flag.** A boolean "human is driving" that
the executor is trusted to check is how you get a race where automation clicks
Submit while an operator is mid-keystroke. So `act()` demands a token and compares
it to the authority's current holder, and the token is *rotated* on every
transition — an executor holding a stale copy cannot act even if it never
consults the state machine. Same chokepoint as the allowlist, so one mechanism
enforces both "may this actor act" and "is this action permitted".

```
AUTOMATION ─request_intervention→ PENDING_HUMAN ─claim→ HUMAN
     ↑                                  │                 │
     └──────── RESUMING ←───────────────┴── abandon ──────┘ hand_back
```

**Taking the live session.** The operator console streams the running page over
CDP screencast and forwards mouse and keyboard back through CDP input. Same
browser session the executor was driving — not a fresh one, not a replay. Viewing
needs no token, deliberately: an operator should understand a stuck run before
deciding to take it on. Input requires the claimed token and is refused without
it; [`scripts/demo-human-handoff.ts`](scripts/demo-human-handoff.ts) asserts that
refusal as part of the demonstration.

Human actions are recorded as evidence. Typed *characters* are not — an operator
filling in member details would otherwise write regulated data into the log one
keystroke at a time. Named keys and clicks are.

**Handing back goes to `RESUMING`, not `AUTOMATION`.** The executor must
re-observe and evaluate the intervention's **resume contract** — normally the
step's own checkpoint — before it gets a usable token back. A human saying "done"
is a claim; the checkpoint is the fact. If it does not hold, the run re-escalates
with the delta rather than proceeding on trust.

**Mocked, and named as such.** No operator authentication, no queue or
assignment, no session-recording playback, and the broker is in-process so a
pending intervention dies with the run. The seam is `EscalationSink`; a durable
queue and an on-call rota go behind it without the executor changing.

---

## 6. Safety

**Allowlist, enforced in two places.** `act()` checks every action, and
`page.route()` checks every navigation at the network layer — so an in-page JS
redirect to somewhere off-allowlist is stopped even though no action was taken
and `act()` never saw it. Navigation is checked against its *destination*.
`/_admin/**` is denied, so the automation cannot reach the target app's own fault
hooks: the harness may arm faults, the agent may not.

**Risk classes** — `safe`, `mutating`, `irreversible` — assigned by declarative
rules over action type, accessible name and route. Irreversibility is a property
of the effect, not the widget, so it is data rather than code.

The asymmetry between discovery and replay is the judgement call:

- **Discovery never takes an irreversible action.** Not with a confirmation, not
  at high confidence. Exploring by pressing "Post Transfer" in a bank is not
  acceptable at any confidence level. It escalates.
- **Replay takes one only when two independent gates are open**: the artifact is
  `approval: approved` (a human read the steps and agreed) *and* the invocation
  passed explicit authorisation. Approval says "this flow is correct";
  authorisation says "do it now, for real". Either alone is too easy to set by
  accident.

A denied irreversible step **escalates** — a human can legitimately complete it.
A denied *route* is a hard failure, because no human should be able to consent us
out of the containment boundary.

Policy is authoritative over the artifact's declared `guard.risk`. If a step
claims to be safe and policy says irreversible, policy wins and the run logs a
`risk_declaration_mismatch` — the artifact is misleading whoever approved it,
which is worth surfacing even though the action was handled correctly.

**Redaction happens at the write boundary**, not at call sites, because relying
on each caller to remember is how leaks happen. Secrets are never written in any
form; PII is written as a per-run salted hash plus a four-character suffix, so
you can tell "the same account appeared at step 3 and step 9" while debugging
without the value existing in the log. Screenshots have sensitive elements
blacked out **before capture**, so the pixels never exist as bytes. Credentials
live in environment variables the profile *names* rather than contains.

### 6.1 The guardrails, named

Six mechanisms, each doing one job. They are separate on purpose: a single
"is this allowed" function that mixed containment with risk with authorisation
would be impossible to reason about and impossible to test.

| # | Guardrail | Where | What it stops |
|---|---|---|---|
| 1 | **Origin allowlist** | [`guardrails.ts:161`](src/policy/guardrails.ts) — exact string match on `URL.origin` | the automation acting anywhere but the configured installs. A hallucinated URL, a phishing redirect, a link to an internal admin host |
| 2 | **Route allow/deny list** | [`guardrails.ts:164`](src/policy/guardrails.ts) — glob match, **deny wins over allow** | reaching pages the flow has no business on. `/_admin/**` (CoreBank) and `/settings/**` (MERIDIAN) are denied, which is how the automation is kept out of its own fault-injection hooks |
| 3 | **Action-type allowlist** | [`guardrails.ts:198`](src/policy/guardrails.ts) | any verb not in `policy.actions`. The discovery model is never even *offered* a tool outside this set — the tool definitions are built from it |
| 4 | **Risk classification** | [`guardrails.ts:173`](src/policy/guardrails.ts) — declarative rules over action type, accessible name and route | nothing by itself; it is what feeds 5. Irreversibility is a property of the *effect*, so it is data rather than code |
| 5 | **The two-gate authorisation rule** | [`guardrails.ts:222`](src/policy/guardrails.ts), enforced at [`executor.ts:236`](src/replay/executor.ts) | an irreversible action running unattended. See below |
| 6 | **Budgets** | `limits` in the policy file | a runaway loop: `maxSteps` 40, `maxRuntimeMs` 300000, `maxRecoveries` 4 |

Enforced in **two independent places**, which matters more than it sounds:
`Surface.act()` checks every action, and Playwright's `page.route()` checks every
network request. An in-page JavaScript redirect to somewhere off the allowlist is
therefore stopped even though no action was taken and `act()` never saw it.

**The two-gate rule for irreversible actions.** An irreversible step runs
unattended only when *both* of these are true:

1. the artifact carries `approval: approved` — a human read the step list and agreed, and
2. this specific invocation passed `x-authorize-irreversible` — a human said "do it now, for real".

Neither alone is sufficient. An approved capability invoked casually still stops;
an authorised invocation of an unreviewed draft still stops. During **discovery**
the gate does not exist at all: an irreversible action is refused
unconditionally, at any confidence, because exploring by pressing "Post Transfer"
in a bank is not acceptable even once.

**A denied irreversible step escalates; a denied route fails.** That asymmetry is
deliberate. A human can legitimately complete a transfer. No human should be able
to consent the automation out of its containment boundary, so origin and route
refusals are marked `escalatable: false` and end the run.

**Policy outranks the artifact.** If a step declares `guard.risk: safe` and policy
classifies it irreversible, policy wins and the run logs a
`risk_declaration_mismatch`. The artifact is misleading whoever approved it,
which is worth surfacing even though the action itself was handled correctly.

**Two closed sets, because "bounded" is the whole point.** Replay may recover
from a fault using exactly five handlers — re-authenticate, dismiss a dialog,
retry the request, wait, re-resolve — and nothing else, ever
([`recovery.ts`](src/replay/recovery.ts)). And a run can end in exactly four ways
(success, business outcome, escalated, failed), so there is no fifth state where
something ambiguous can hide.

### 6.2 Sensitive data: what never enters, and what is scrubbed on the way out

Two different problems, solved two different ways.

**Structural: there is nothing to leak in the first place.**

- **Capability artifacts contain parameter *references*, never captured values.**
  A recorded step says `value: '{{memberId}}'`. The member number that was on
  screen when the flow was recorded is not in the file, so the artifact can be
  committed to git, reviewed in a pull request and shared between institutions
  with no redaction pass at all. This is the strongest protection in the system
  and it costs nothing at runtime.
- **Credentials are named, never stored.** A product profile declares
  `credentialEnv: { user: COREBANK_OPERATOR, password: COREBANK_PASSWORD }` —
  variable *names*. The values are read from the environment at the moment they
  are needed. No capability records a sign-on flow, because signing on is a
  *precondition* the runtime satisfies, which is also what lets one artifact
  replay under any operator identity.
- **The chat front door composes bodies, never headers.** It cannot authorise an
  irreversible action, and it cannot arm a fault, because neither is expressible
  as a tool argument.

**Behavioural: everything on its way out is scrubbed at the write boundary.**

The rule in [`redaction.ts`](src/policy/redaction.ts) is that redaction happens
at the **write boundary**, not at the call sites — relying on each caller to
remember is how leaks happen. There are two boundaries and both honour it:

| Boundary | Enforced by |
|---|---|
| the filesystem (`evidence/**`) | every write routes through `RunRecorder` |
| the database (three collections) | `storedRunOf()` deep-redacts before `saveRun` |

Two tiers, because they need different treatment:

- **`secret`** — passwords, tokens, API keys. Never written in any form, not even
  hashed. There is no debugging use for a password.
- **`pii`** — SSNs, card numbers, account numbers, e-mail addresses. Written as a
  per-run salted SHA-256 prefix plus the last four characters:
  `[pii:6d8a823c…7735]`. You can still tell that the same account appeared at step
  3 and step 9 while debugging, without the value existing in the log.

The salt is regenerated per run unless `REDACTION_SALT` is pinned, so a leaked
log from one run cannot be used to confirm a value in another.

Detection is both **declared and inferred**, and declared wins. A capability
input marked `sensitivity: pii` is masked whatever it looks like; an *undeclared*
parameter is treated as PII by default. On top of that, pattern matching catches
values that arrive from the screen rather than from the caller: SSN, card number
(Luhn-validated, so it does not fire on any long digit string), e-mail (the TLD
must be alphabetic, or `capability_name@1.0.0` reads as an address and every log
line naming a version gets redacted into uselessness), bearer tokens, provider
API-key shapes, and this product's ten-digit account numbers.

**Screenshots are masked before capture, not after.** Elements whose text
contains PII are blacked out in the page, *then* the screenshot is taken, so the
sensitive pixels never exist as bytes on disk.

#### What this means for the chat front door specifically

The chat pane is the one place a person types free text, so it is worth being
precise about what happens to it:

- **The transcript is client-side state; the server is stateless about it.** No
  chat log is written to disk or to the database. The durable record of a
  chat-driven run is its *evidence directory* — the steps that ran — not a
  transcript of what was said. "Clear conversation" is therefore honest.
- **What the model receives is the sentence the person typed plus the structured
  results of the calls it made.** Those results are the same narrowed contract an
  API caller gets: status, outcome code, declared outputs. Not the page text, not
  the accessibility tree, not a screenshot.
- **Arguments the model emits are validated against the artifact's JSON Schema
  before a browser starts** ([`chat.ts:531`](src/api/chat.ts)). A malformed member
  number is a typed rejection handed back to the model to fix, not a browser
  navigation.
- **What lands in the run record is redacted.** `params` in the `runs` collection
  reads `{"memberId": "[pii:6d8a823c…3001]"}`, not the number.

The honest limits, stated rather than buried:

- **A person can still type a real SSN into the chat box**, and it will reach the
  model host in the prompt for that turn. It is redacted before it reaches disk or
  the database, but it is not redacted before it reaches the provider. Redacting
  inbound user text is a real gap and the right fix is to run `redactText()` over
  the message on the way *in* as well as on the way out — cheap, and not done.
- **Redaction patterns are configured for these two products' data shapes.** A new
  vendor with a differently shaped account number needs the list extended, and the
  failure mode is silent.
- **Risk classification is pattern-based.** A commit button labelled "Continue"
  would classify as `safe`. Mitigated by also matching on route and by
  `guard.risk` being visible per step in a reviewed diff, but a deliberately
  mislabelled control is a real gap.
- **Route-scoped risk rules do not fire on a `<frameset>` product, and the
  failure is silent.** `PolicyContext.url` comes from `surface.location()`, which
  is the top-level page URL. On CoreBank that is the frameset shell (`/`) while
  the real screen lives in an inner frame, so a rule keyed on `routePattern`
  never matches there — it looks correct in the policy file and does nothing.
  CoreBank's rules are therefore keyed on the control's **accessible name**,
  which is reliable on both products. Found while adding the member-details
  screen, and worth recording rather than quietly fixing, because the class of
  bug is "a guardrail that is present and inert". The proper fix is for
  `location()` to report the frame the action is targeting, which is a change to
  the surface contract rather than to the policy.
- **The loop budgets are not a safety mechanism.** `maxSteps`, `maxRuntimeMs`,
  `maxRecoveries` and the chat turn limit stop a runaway loop; they stop nothing
  harmful. Policy does that, on every single action, regardless of how many steps
  remain. Each number is justified against a measured quantity in
  [FLOWS.md §8](FLOWS.md#8-why-the-loop-limits-are-what-they-are).
- **The allowlist is a containment boundary, not a sandbox.** A compromised
  dependency inside this process ignores all of it.
- **Neither the operator console nor the control panel has authentication.**
  Anyone who reaches port 4100 can take control of a live banking session; anyone
  who reaches 4200 can approve a capability and authorise an irreversible replay
  — the two gates the entire safety story rests on. This is the single largest gap
  between this and something deployable.

---

## 7. Cuts, and what comes next

**Deliberately not built.** The desktop surface (interface defined, mapping
documented, not implemented — the biggest cut and the most defensible, since a
second surface would have cost depth in the schema and error taxonomy); operator
authentication, queueing and assignment; a durable intervention queue;
queue/worker infrastructure, which the brief penalises; bounded LLM recovery on
replay failure (designed as a fifth entry in the closed recovery set, but I
preferred the deterministic path stay free of the model); a product-version
overlay between base spec and tenant patches, which nothing in play needed.

**What I would build next, in order:**

1. **Authentication on the operator console**, with an audit trail tying each
   intervention to a named operator. The one gap that makes this unshippable
   rather than merely incomplete.
2. **Drift aggregation across tenants.** The per-run signals exist; what is
   missing is the service that notices "eleven institutions on build 9.0 started
   resolving this step structurally last Tuesday" and opens a ticket.
3. **A capability test harness in CI** — replay every approved capability against
   a seeded instance on each vendor release, and gate the `approved` flag on it.
   This is what turns "record once" into something an institution can rely on.
4. **The desktop surface**, starting with a UIA sidecar.
5. **Bounded assisted recovery** for a single failed step — valuable, but only
   once the deterministic path has enough mileage to know which failures are
   worth spending a model on.

**Known rough edges.** The compiler infers input types conservatively (everything
a `string`, everything `pii`) and expects a human to tighten them during review —
the right default, but a fresh artifact needs editing before it is pleasant to
call. The scripted provider covers only the lookup flow.

---

## 8. Stretch goals: what is built, and what was declined

Three of the optional extensions are implemented and demonstrable. They are
described here in the detail a reviewer needs to check the claim, because each
one is load-bearing for a different part of the argument.

### 8.0 Where each one is, in code and on screen

The six optional extensions from the brief, with an honest verdict on each and
the two things a reviewer actually needs: which file to open, and which click
shows it working. The panels are CoreBank on `http://localhost:4200` and
MERIDIAN on `http://localhost:4300`.

| Stretch goal | Status | Code | Where to see it in the UI |
|---|---|---|---|
| **Agent-facing capability interface** | **Built** | [`src/api/server.ts`](src/api/server.ts), [`src/api/contract.ts`](src/api/contract.ts), [`src/capability/catalog.ts`](src/capability/catalog.ts) | **Agent view** tab — the real function-calling definitions from `GET /api/v1/tools`, and a copyable `curl` for `POST /api/v1/invoke`. Then **Chat** or **Replay** to see one invoked |
| **Canonicalization / cross-tenant reuse** | **Built** | [`src/capability/tenant-overrides.ts`](src/capability/tenant-overrides.ts), `overrides:` in [`capabilities/lookup_member_savings_balance@1.0.0.yaml`](capabilities/lookup_member_savings_balance@1.0.0.yaml), tenants in [`config/apps/corebank-servicing.yaml`](config/apps/corebank-servicing.yaml) | **Run as → Tenant** in the left rail on 4200. Run `lookup_member_savings_balance` against *base*, then *First Valley* (two relabelled controls, patched) and *Harbor* (different product version, reordered columns, extra interstitial — **no** patches). Same artifact, three institutions |
| **Confidence & approval** | **Built** (approval), **not built** (score) | [`schema.ts`](src/capability/schema.ts) `metadata.approval`, gate at [`executor.ts:236`](src/replay/executor.ts), audit in [`src/store/mongo.ts`](src/store/mongo.ts) | The **draft / approved** badge on every card in the left rail, with an **Approve** button on drafts. Then **Replay** → tick *Authorize irreversible* and watch a draft still stop. The reliability *score* is designed and not implemented — see 8.3 |
| **Assisted LLM fallback** | **Declined, on purpose** | — | — (see 8.4: it would put a model back in the replay hot path, which is the property the design exists to remove) |
| **Code generation** | **Not built** | — | — |
| **Multi-run stability** | **Not built** | the per-run inputs exist: `ReplayResult.steps[].resolution.score` and `driftSignals[]` | visible per run in **Run history** and in `result.json`; nothing aggregates them across runs |

Two things adjacent to the list that were built and are worth the same treatment,
because they are what a reviewer usually asks about next:

| Also built | Code | Where to see it |
|---|---|---|
| **Human-in-the-loop handoff on a live session** | [`control-authority.ts`](src/escalation/control-authority.ts), [`intervention-broker.ts`](src/escalation/intervention-broker.ts), [`operator/`](src/escalation/operator/) | Ask **Chat** for a transfer. The run drives to the commit control, parks, and the escalation modal opens *while the browser is still live*. **Operator console ↗** in the header takes over the real session |
| **Guardrails, read from the file being enforced** | [`guardrails.ts`](src/policy/guardrails.ts), `config/policy*.json` | **Guardrails** tab — origins, routes, action types, both risk-rule sets and the budgets, served verbatim from `GET /api/policy`. Not a second hand-written copy that can drift |

### 8.1 Agent-facing capability interface

An AI agent invokes a capability **by name with typed arguments** and gets a
structured result, knowing nothing about the underlying UI. Four routes, mounted
on the panel's port rather than a server of their own
([`src/api/server.ts`](src/api/server.ts)):

| Route | Returns |
|---|---|
| `GET /api/v1/capabilities` | the catalog, plus the product's tenants and named identities |
| `GET /api/v1/capabilities/:name` | one capability's inputs, outputs and declared business outcomes |
| `GET /api/v1/tools` | the same set as **function-calling definitions** — what you hand a model |
| `POST /api/v1/invoke` | runs it, synchronously, and returns the four-arm contract |

Four decisions worth defending:

**The catalog is a projection, not a second source of truth.** Every route reads
from `Catalog`, which reads the same YAML a human reviewed and approved. The JSON
Schema an agent sees, the business outcomes it is told about, and the
irreversibility flag are all *derived* from the artifact. There is no
hand-maintained API schema that can drift out of agreement with what actually
replays — the usual way an agent-facing surface starts lying.

**A business outcome is HTTP 200.** `MEMBER_NOT_FOUND` is an answer: the
application was asked and it responded. Returning 4xx would re-introduce, at the
transport layer, exactly the conflation the result contract exists to prevent,
and every HTTP client in the world would then treat a legitimate answer as an
error. 400 is reserved for a request that was malformed before a browser started;
500 for the automation itself breaking, reported as `engine_error` rather than
dressed up as one of the four arms.

**Tool descriptions name the declared outcomes.** A tool description is the only
thing many agents read before choosing, so "returns MEMBER_NOT_FOUND if no such
member exists" prevents a whole class of pointless retry loop where an agent
treats a definitive answer as a transient failure.

**Drafts are listed and flagged, never hidden.** Hiding them would make the
catalog lie about what exists. A draft is still invocable — it simply escalates
instead of taking an irreversible step unattended.

```bash
curl localhost:4200/api/v1/tools
curl -X POST localhost:4200/api/v1/invoke -H 'content-type: application/json' \
  -d '{"capability":"get_balance","arguments":{"memberId":"103001","shareId":"103001-MMKT-4"}}'
```

### 8.2 Cross-tenant reuse

Three instances of the same vendor product run as three institutions on ports
4000-4002. One artifact replays against all of them.

The interesting case is `harborcu`, which is a **different product version** with
a reordered accounts table and a mandatory privacy interstitial — and needs
**zero overrides**. The reordering is absorbed because locators address a row by
its key rather than its position, and the extra screen by a step marked
`optional: true`, which is expected absence rather than a recoverable fault.

Where a tenant genuinely differs, `overrides:` carries JSON-Pointer patches with
a `why` on each one:

```yaml
overrides:
  firstvalley:
    note: Two controls relabelled in this institution's build.
    patches:
      - path: /steps/2/action/target/name/value
        value: Find Member
        why: This install labels the search button "Find Member".
```

The alternative — a copy of the capability per tenant — means a bug fix has to be
applied N times and drift is invisible. A patch list makes the **difference** the
reviewable unit: you can read exactly how First Valley deviates, and nothing else
is duplicated. Committed evidence for both tenants is in
[`evidence/replay-tenant-firstvalley/`](evidence/replay-tenant-firstvalley/) and
[`evidence/replay-tenant-harborcu/`](evidence/replay-tenant-harborcu/).

```bash
npm run replay -- -c lookup_member_savings_balance -i memberId=10001 --tenant harborcu
```

### 8.3 Confidence and approval

`metadata.approval` is `draft` or `approved`, and an irreversible step runs
unattended only when **two independent gates** both open
([`src/replay/executor.ts:236`](src/replay/executor.ts)):

1. the artifact is `approval: approved` — a human has read the step list, and
2. the specific invocation authorises it — the `x-authorize-irreversible` header.

Neither alone is sufficient, which is the point. An approved capability invoked
casually still stops; an authorised invocation of an unreviewed draft still stops.

Approval is an act performed **on a file a human can read**, which is the whole
argument for keeping artifacts as YAML in git rather than rows in a database: a
capability lands as a pull request, a reviewer reads the step intents and the
declared outcomes in the diff, and approving it is a commit. The panel's approve
button writes the same field to the same file, so the two doors agree.

What is *not* built here is the **reliability score** — replaying a capability N
times and recording a stability signal alongside the approval. The design has the
hook for it (`ReplayResult.steps[].resolution.score` and `driftSignals[]` already
exist per run, and a step whose locator resolves at 0.95 every time is stable
where one oscillating 0.95/0.55 is about to break), but measuring it is future
work, listed in §9.

### 8.4 Declined: assisted LLM fallback

A bounded, policy-checked model call to recover a single failed replay step was
considered and **deliberately not built**. It puts a model back into the replay
hot path, which is the exact property the whole design exists to remove: the
value proposition is that replay is deterministic, auditable and free, and a
model that wakes up on failure means every run's behaviour is once again
contingent on what a model decides that day.

It is worth doing eventually — as a fifth entry in the *closed* recovery set,
never as open-ended reasoning — but only once the deterministic path has enough
mileage to say which failures are actually worth spending a model on. Building it
now would be optimising a path we cannot yet characterise.

---

## 9. Next steps: running this somewhere real

Everything below is analysis, not implementation. It is here because "what would
it take to deploy this" is a fair question to ask of a prototype, and the honest
answer is specific rather than a gesture at Kubernetes.

### 9.1 Hosting

**Serverless cannot run this**, and it is worth being precise about why, because
Amplify/Vercel/Lambda is the reflexive answer:

1. Playwright launches a real Chromium — roughly 1–1.5 GB resident and a writable
   filesystem. 512 MB free tiers OOM before the first navigation.
2. Runs are long. `maxRuntimeMs` is 300000 in
   [`config/policy.json`](config/policy.json); serverless request timeouts are
   10–30 seconds.
3. The transports are SSE (`/api/runs/:id/stream`) and WebSocket (`/ws/session`)
   over in-process state. Scale-to-zero drops both; multi-instance autoscaling
   routes the second request to a process that has never heard of the run.
4. Evidence is written to local disk. Without a volume it evaporates.

**Docker is packaging, not a host.** It is the right way to get all five services
onto one box reproducibly, and it does not answer *where*.

That packaging exists: [`Dockerfile`](Dockerfile), [`docker/start.sh`](docker/start.sh)
and [`docker-compose.yml`](docker-compose.yml) bring up MongoDB, the three
CoreBank instances, both control panels and both operator consoles with
`docker compose up --build` — described in [DOCKER.md](DOCKER.md). Two details
carry the argument above. The image is built on the official Playwright image, so
Chromium is version-locked to the `playwright` in `package.json` rather than
being whatever `playwright install` fetched on the day; and the build runs
`npm run typecheck && npm test` before it produces anything, so a red tree cannot
become a deployable artifact. What it still does not do is answer the four
objections listed above — none of which Docker is the fix for.

| Option | Cost | Verdict |
|---|---|---|
| Local + Cloudflare Tunnel | $0 | Best for a demo — nothing to host, share a URL for the session |
| Hetzner CX22 (2 vCPU / 4 GB) | ~€3.79/mo | Cheapest reliable always-on |
| Oracle Cloud Always Free (ARM) | $0 | Halved to 2 OCPU / 12 GB on 2026-06-15; capacity often unavailable |
| Fly.io shared-cpu-1x, 1 GB | ~$2–4/mo | Works; configure the volume or evidence vanishes |
| AWS Lightsail 2 GB | $12/mo | Fine, not cheap |
| Amplify / Vercel / Lambda | — | **Cannot run this** — see above |

AWS's free tier changed on 2025-07-15: new accounts get $100 (plus $100
earnable) valid for six months, after which the account closes. The 12-month
t2.micro is gone for new signups, so AWS is a trial here rather than a free host.

Two things that are easy to miss. Hosting means adding the new origin to
`origins` in the policy file — pointing the automation somewhere new is a policy
change by design, not a flag. And **neither 4100 nor 4200 has any
authentication**: anyone who reaches 4100 can take control of a live banking
session. Public hosting needs auth in front of both, or a private tunnel.

### 9.2 Productionalizing

**What already generalizes and should not be rebuilt:** artifacts in git with
human approval as the gate; per-tenant JSON-Pointer overrides so a fix applies
once; `credentialEnv` *names* in profiles, never values; the `Surface` port for a
second surface kind; the `LlmProvider` seam; the four-arm result contract; and
redaction-by-construction — every evidence write routes through `RunRecorder`, so
no call site can leak by forgetting to redact.

**What has to change:**

| Gap | Fix |
|---|---|
| **No authentication on 4100 or 4200** | The largest gap. OIDC/SSO plus RBAC: who may claim an intervention, who may approve a capability, who may send `x-authorize-irreversible` |
| Evidence on local disk | S3 behind the same `RunRecorder`; keep the synchronous local append as the crash-safe buffer |
| SSE/WS fan-out is in-process | Redis pub/sub, or sticky routing |
| One Chromium launched inline per run | Pooled browser workers, per-run contexts, hard memory caps, eviction |
| Secrets in `.env` | Vault or Secrets Manager, resolved through the `credentialEnv` indirection that already exists |
| `REDACTION_SALT` random per run | Correct for isolation, wrong when you need cross-run correlation. Managed and rotated |

The run registry, escalation queue and irreversible-authorisation audit **have
been addressed** — see §9.5.

#### The order I would actually do it in

Not a list of everything that could be improved — a sequence, where each step is
the thing that makes the next one safe to attempt.

**1. Authentication and authorisation on both consoles.** Nothing else matters
until this exists. Today anyone who reaches 4100 takes control of a live banking
session, and anyone who reaches 4200 can approve a capability and authorise an
irreversible replay. OIDC in front of both, then four distinct permissions —
*view*, *invoke*, *approve an artifact*, *authorise an irreversible invocation* —
because they are genuinely different acts and an institution will want them held
by different people. The audit trail already records what was authorised; it
needs to record **who**, and `identity` is the field waiting for it.

**2. Secrets out of `.env` and into a manager.** The indirection is already
built: profiles name environment variables rather than holding values, so the
change is where `credentialEnvFor()` resolves from, not a redesign. Vault or
Secrets Manager, with per-tenant scoping so a compromised worker cannot read
another institution's operator password.

**3. Evidence to object storage.** ~20 KB per run on local disk fills a small
volume in weeks and vanishes with the instance. S3 behind the same
`RunRecorder`, keeping the synchronous local append as the crash-safe buffer, so
a run that dies mid-flight still leaves everything up to the crash. Lifecycle
rules matter here as much as durability: screenshots of member records should
expire on a schedule the compliance team sets, not accumulate forever.

**4. A browser pool with hard limits.** One Chromium launched inline per run is
correct for a prototype and wrong at any volume. Pooled workers, a fresh context
per run (never a shared one — cookie bleed between tenants would be a
catastrophe), a hard memory cap, and eviction on idle.

**5. A queue between the API and the workers.** This is what turns "the panel is
busy" into "the work is accepted". It is also the prerequisite for horizontal
scale, because the API becomes stateless once it is not holding a browser.

**6. Redis pub/sub for the event streams.** SSE and WebSocket fan-out is
in-process today, so a second instance behind a load balancer routes the second
request to a process that has never heard of the run. Sticky routing is the
cheap version; pub/sub is the correct one.

**7. Capability CI.** Replay every approved capability against a seeded instance
on every vendor release, and gate the `approved` flag on the result. This is what
turns "record once" into something an institution can actually rely on, and it is
the single highest-value item on this list after authentication.

**8. Then, and only then, the reliability score and drift aggregation.** They
need a corpus of runs to be meaningful, and steps 1–7 are what produce one.

What *should not* be rebuilt, because it already generalises: artifacts in git
with human approval as the gate; per-tenant JSON-Pointer overrides; `credentialEnv`
names rather than values; the `Surface` port; the `LlmProvider` seam; the
four-arm result contract; and redaction-by-construction at every write boundary.

### 9.3 Scaling across tenants

The data model is already right: one profile per *product*, N tenants inside it,
per-tenant `overrides:` as the reviewable diff. Going from three to hundreds is
mostly operational:

- Move the `tenants:` list out of YAML into a table. Keep `overrides:` in the
  artifact — it is the thing a human reviews, and it belongs in the diff.
- A per-tenant health probe. The panel's `/api/health` is the seed: it already
  probes each tenant's own `loginPath` rather than a hard-coded `/login`.
- A canary replay per tenant on each vendor release, keyed off the existing
  `productVersion` field. That field exists precisely so drift is *detectable*
  rather than discovered in production, and this is what uses it.
- Drift aggregation across tenants, as in §7 — the per-run signals exist; the
  service that notices "eleven institutions on build 9.0 started resolving this
  step structurally last Tuesday" does not.

#### What "multi-tenant" actually means here, and the three things that make it work

The word is doing two jobs in this system and they should not be confused. A
**product** is a vendor build — CoreBank, MERIDIAN. A **tenant** is one
institution's install of it. A capability belongs to a product; it *runs against*
a tenant. That distinction is the whole design.

**1. One artifact, N installs, because locators describe what a human sees.** A
step says "the link labelled Member Search in the navigation frame", not
`#ctl00_lnkSearch`. So the same recorded flow survives a tenant that reordered
its accounts table (Harbor moved the columns; outputs are addressed by row and
column *header*, so nothing broke) and a tenant on a different product version
entirely. Harbor runs build 9.0 against artifacts recorded on 8.2 and needs **no
overrides at all**.

**2. Where a tenant genuinely differs, the difference is the reviewable unit.**
First Valley relabelled two controls. That is two JSON-Pointer patches with a
`why` on each, nested in the artifact under `overrides: firstvalley:`. The
alternative — a copy of the capability per institution — means a bug fix is
applied N times and drift is invisible. A patch list makes deviation something
you can *read*.

**3. Everything true about the product is authored once and inherited.** Session
expiry looks identical on every CoreBank screen. So does the error page and the
maintenance overlay. Those live in the product profile and every capability for
that product gets them for free, so fixing how a timeout is handled fixes it
everywhere. A tenant may *add* conditions — Harbor's compliance team put a
privacy acknowledgement in front of member detail, and that is four lines on the
tenant entry which every capability then absorbs without being re-recorded.

**The specialisation order is the same everywhere**, most specific first:

```
  step-local  ─▶  tenant  ─▶  product          (conditions)
  identity    ─▶  tenant  ─▶  product default  (credentials)
  tenant patch ─▶ base artifact                (locators)
```

**What adding the 300th institution costs.** An entry in `tenants:` — id, label,
base URL, product version, and the names of two environment variables holding its
operator credentials. Not a re-recording, not a fork, not an engineering project.
What it does *not* scale past today is the health probe, which checks every
tenant serially on a 4-second timeout; at 300 institutions that is a 20-minute
sweep, and it is the first thing that breaks at fleet scale.

**What is missing for real fleet operation**, in order: the tenant list in a
table rather than YAML (keep `overrides:` in the artifact — it is what a human
reviews); per-tenant credential scoping in a secrets manager; a canary replay per
tenant on each vendor release, keyed off the `productVersion` field that exists
precisely so drift is detectable; and drift aggregation across the fleet.

### 9.4 Scaling to many users

Users are not the unit of scale; **runs** are, and a run is 2–30 seconds of a
real browser. The shape is: API → durable queue → worker pool with pooled
browsers → results to object storage and a database.

Throughput is bounded by browser-seconds, so the levers are:

1. **Capability coverage.** A recorded capability replays with no model in the
   loop — no thinking time, no token cost, no variance. Every flow moved from
   discovery to replay is a permanent throughput win.
2. **Caching read-only results** with a short TTL. A balance lookup repeated
   three times in a minute does not need three browsers.
3. **Keeping model calls off the hot path.** The chat front door is the only
   place a model runs per-request, and it is capped at six turns.

The real bottleneck is not compute — it is **escalations**. A parked session
holds a browser process and a member's record open for as long as it waits, so at
scale the intervention queue needs routing, priority and an SLA, or a handful of
un-actioned handoffs will consume the worker pool.

#### What load actually does to this design

The full accounting, with measured sizes, is
[CODEBASE.md §11](CODEBASE.md#11-load-what-grows-with-what). The short version,
because "how does it scale" deserves a specific answer rather than a gesture:

| More… | Effect | Where it bites first |
|---|---|---|
| **Users** | almost none | one SSE connection and a 5s poll each |
| **Concurrent runs** | **linear in RAM, and it is the hard wall** | Chromium at 1–1.5 GB resident — about two concurrent runs per 4 GB box |
| **Capabilities** | none at runtime | `catalog.list()` re-reads and re-parses every YAML per request. Fine at 10, wasteful at 10,000; the fix is an mtime-keyed cache |
| **Tenants** | none per run | `/api/health` probes **every** tenant serially on a 4s timeout — 300 tenants is a 20-minute health check. First thing to break at fleet scale |
| **Steps per capability** | linear run time; **quadratic** discovery cost | history is re-sent in full every turn, so the last call of a 12-step run carries eleven prior turns |
| **Runs over time** | ~5 KB/run in Mongo, ~20 KB/run on disk | disk, not the database: a million runs is 5 GB of documents and 20 GB of evidence |
| **Escalations** | **the real bottleneck** | a parked run holds a live browser *and* a member's record open until a human acts |

Three properties are worth stating because they are the ones the design bought:

**Replay cost is flat in load.** No model, no tokens, no rate limit, no variance.
The thousandth replay of a capability costs exactly what the first did. This is
the whole economic argument for record-once/replay-many, and it is why moving a
flow from discovery to replay is a permanent throughput win rather than a
one-off saving.

**Adding tenants is a config entry, not a rebuild.** One profile per *product*, N
tenants inside it, per-tenant `overrides:` as the reviewable diff. Three
institutions to three hundred adds rows, not code, and does not multiply the
artifacts.

**Model rate limits bind on discovery only.** Groq's free tier is 8,000 tokens
per minute and 200,000 per day on the default model — roughly eleven discovery
runs a day. That is a real constraint on *learning* new flows and none at all on
*running* known ones.

And two that it did not:

**Un-actioned escalations exhaust the pool before anything else does.** A parked
session is not a queued job — it is a live browser with a member's record on
screen, held for as long as it waits. Ten of them on a 4 GB box is the whole box.
It needs routing, priority, an SLA, and a timeout that abandons the run and
releases the browser. None of that exists.

**Nothing here is horizontally scalable yet.** SSE and WebSocket fan-out is
in-process, so a second panel instance behind a load balancer routes the second
request to a process that has never heard of the run. Redis pub/sub or sticky
routing is the prerequisite for instance number two.

### 9.5 Durable state (implemented)

Three stores previously lived in module-level `Map`s and vanished on restart: the
run registry, the escalation queue, and the audit trail of explicit irreversible
authorisations. The last of those is the one that mattered — a regulator-facing
record that disappears when a process recycles is not a record.

They are now written through a `RunStore` interface
([`src/store/run-store.ts`](src/store/run-store.ts)), with a MongoDB
implementation ([`src/store/mongo.ts`](src/store/mongo.ts)) selected by setting
`MONGODB_URI`. The three collections, their document shapes, their indexes and
their measured sizes are written out in
[CODEBASE.md §10.1](CODEBASE.md#101-the-mongodb-schema). With no URI configured the in-memory store is used and behaviour
is exactly as before, so the repo still runs with nothing installed.
`GET /api/health` reports which backend is live.

**What this does and does not buy, stated plainly.** It persists the durable
*projection* of each store, not the live objects. A panel run holds open SSE
response handles; a parked intervention holds the promise resolver a blocked
replay is waiting on. Neither is serialisable, and neither would mean anything in
another process — the browser session a parked run is holding died with the
process that launched it. So a restart recovers **history and audit**, and does
not resume a parked session. Claiming otherwise would be the kind of durability
that reads well in a design document and fails in production.

Two things deliberately did **not** move to Mongo. Capability artifacts stay in
git, because human approval is the gate and their home is where code review
happens. Evidence stays on the filesystem: it is append-only and includes
screenshots, `events.jsonl` is written with `appendFileSync` so a crashed run
still leaves everything up to the crash, and routing that through a network round
trip per event would trade that guarantee away for nothing.

So the database holds the run record — including its **outputs** and per-step
reports — plus escalations and the authorisation audit, and a *pointer* to the
evidence rather than the evidence itself. It answers "what did this capability
return last Tuesday"; for the screenshot it tells you which directory to open.

#### Why a document store is the right shape for this data

Not "because MongoDB is convenient". Four properties of *this* data pick it:

**The main record has no fixed shape, and that is by design.** A run's `result`
is a discriminated union of four arms. A success carries `outputs`; a business
outcome carries `code` and `message`; an escalation carries `interventionId`,
`resolution` and `atStep`; a failure carries a structured `error`. In a relational
schema that is either four tables with a join, or one wide table that is mostly
nulls and lies about which columns can co-exist. As a document it is stored as
what it is — and the union is enforced where it belongs, in the TypeScript type
and the Zod schema, not in DDL.

**Per-step reports are naturally nested and never queried independently.** A run
has 3–9 steps, each with a resolution score, the strategy that resolved it, drift
signals and timings. Nobody ever asks "give me all steps across all runs where
the score was under 0.6" without also wanting the run they belong to. Embedding
them is the correct normalisation, not a shortcut: the document *is* the
aggregate.

**Every read is "the most recent N", and every write is an upsert by a known
id.** Three indexes serve the entire application — `{id: 1}` unique, and a
descending timestamp on each collection. There are no joins anywhere in the
codebase and no query a document store handles badly.

**The schema evolves with the artifact schema.** A new field on `ReplayResult` —
a reliability score, a per-step token count — appears in new documents and old
ones simply do not have it. There is no migration, because there is no
declaration to migrate. Given that the artifact format is the thing most likely
to change, a store that treats an added optional field as a non-event is worth a
lot.

The honest counter-argument: if the primary question were analytical — *"p95
duration by capability by tenant by week"* — a columnar store would beat this
comfortably. That question is real and I would answer it by streaming these
documents into a warehouse, not by reshaping the operational store around it.

#### Running it in production

| Concern | What to do |
|---|---|
| **Deployment** | A managed replica set (Atlas, or a self-hosted 3-node set). Never a standalone: `saveRun` is a fire-and-forget upsert, so a primary that disappears silently loses run history rather than erroring loudly. |
| **Connection string** | Injected from the secrets manager, never in `.env` on a shared host. `redactUri()` already guarantees the password never reaches a log line intact — that behaviour is pinned by a test. |
| **Write concern** | Default (`w: majority`) for `irreversible_authorizations` — it is the regulator-facing record and losing one is not acceptable. `w: 1` is defensible for `runs`, which is an index over evidence that is already durable on disk. |
| **Indexes** | The three that exist are sufficient. Add a **TTL index** on `runs.startedAt` matched to the institution's retention policy; a run document holds redacted PII and should not live forever by default. |
| **Retention** | The audit collection is append-only and should be retained for as long as the institution retains transaction records — years. Run history is operational and can expire in months. These are different lifetimes and should not share a policy. |
| **Multi-tenant isolation** | Today every tenant's runs share three collections and are distinguished by a `tenant` field. That is fine while one operator sees every institution. The moment institutions log in themselves it is not: it needs either a database per tenant or enforced field-level filtering at the data-access layer, and the latter is one forgotten `where` clause away from a breach. |
| **Encryption** | At rest by default. PII in these documents is already hashed at the write boundary, so the database holds `[pii:6d8a823c…7735]` rather than an account number — encryption is defence in depth here, not the primary control. |
| **Backup** | Point-in-time restore. Note the asymmetry worth planning for: a restored database plus an intact evidence bucket reconstructs everything; a restored database alone gives you the index and no screenshots. |
| **Monitoring** | Two alerts earn their place: connection failures (the store degrades to memory and keeps serving, which is the right behaviour and completely silent), and a growth-rate alarm on `runs`, since ~5 KB per run is the cheapest early warning that something is retrying in a loop. |

The degradation path is deliberate and worth restating: with no `MONGODB_URI` the
system uses an in-memory store and works. If the URI is set but unreachable, it
warns and continues in memory. **Losing run history is a much smaller failure
than a control panel that will not boot** — but it is a real one, so
`GET /api/health` reports which backend is live rather than leaving you to find
out after the restart that lost them.

One thing this exposed, worth recording because it is the failure mode the design
is built to prevent. Adding a database adds a **second write boundary** for the
same regulated data, and the first version of it wrote `run.result` straight
through — so an account number that reads `[pii:…7735]` in the committed evidence
sat in plaintext in a collection that outlives the process and is far easier to
query. `redaction.ts` says the rule plainly ("redaction happens at the write
boundary, not at the call sites"), and the new boundary simply did not honour it.
Both boundaries now produce the identical hash, and `tests/run-store.test.ts`
pins it. Any third sink — an S3 archive, a log shipper — needs the same treatment
and should grow a case in that file.

### 9.6 Model cost and rate limits

Discovery is a **one-time cost per capability**; replay is free forever. The
recurring model cost is the chat front door and re-discovery when a screen
changes, so the first lever is always coverage.

Measured from committed evidence: 1.7k–3.1k prompt tokens per call, 4–10 calls
per discovery run, so 7k–31k prompt tokens per run. Groq's free tier allows 8,000
tokens **per minute** on the models that support tool calling, which a single run
exceeds around its third call. Nothing on that tier fixes it — the 20b models and
`qwen3.x-27b` are also 8K TPM, and `llama-3.3-70b-versatile` is 12K.

The **daily** ceiling is the one that binds in practice: 200,000 tokens per day on
`openai/gpt-oss-120b`, which at a mean of ~17k per run is about **eleven discovery
runs a day**. `evidence/runs/discovery-6a95be4c/` is a committed run that died on
exactly that limit.

Priced out, the whole argument fits in a sentence: the seven model-discovered
capabilities in this repository cost **134,691 prompt and 7,645 completion tokens
in total — about $0.025** on the default model, and every replay since has cost
nothing. [CODEBASE.md §7](CODEBASE.md) has the per-capability breakdown, the
per-provider comparison including Gemini, and what $10 buys on each.

The implemented answer is **failover** (§9.7). The remaining levers, in order of
size:

1. **Interactive controls are the only uncapped section of the prompt**
   ([`src/discovery/model-prompt.ts:108`](src/discovery/model-prompt.ts)). Table
   cells cap at 60, labelled values at 40, page text at 2000 — controls at
   nothing. A dense legacy screen sends hundreds of lines.
2. **History is re-sent in full every turn.** The last call of a 20-step run
   carries 19 prior turns. Windowing to the last six plus a summary would cut the
   tail of every long run.
3. **No prompt caching.** The system prompt plus tool schemas is roughly 1,550
   tokens, byte-identical on every call, already at the front of the message
   array — a perfect cacheable prefix that nothing currently claims.
4. **The OpenAI SDK's own `maxRetries: 2`** compounds with the provider's
   four-attempt backoff, so one logical call can bill as several.
5. **Screenshots at `detail: 'high'`** cost 1–2k tokens per call for
   corroboration the model does not act on — it acts by element id.
6. **`usage()` undercounts**, because nudge retries and rejected prose responses
   consume quota without being counted. Worth fixing before optimising against
   the number it reports.

### 9.7 Provider failover (implemented)

Groq stays primary; a configured OpenAI key becomes an automatic fallback
([`src/discovery/llm/failover-provider.ts`](src/discovery/llm/failover-provider.ts)).
A run that takes a 429 partway through now finishes instead of dying while
holding a browser open. Three rules make it safe to leave on by default:

- **It does not fail over on `bad_arguments`.** That failure means the model
  returned JSON we could not parse against our own tool schema — our bug, not the
  host's. The next provider fails identically, so falling through would spend a
  second quota to reach the same error.
- **It is sticky.** Once a run moves to the fallback it stays there. A rate limit
  that just tripped has not cleared by the next turn, so retrying the primary
  every step would spend a doomed request before each real one.
- **The switch is evidence, not a silent kindness.** It prints to the console and
  writes a `model_provider_switched` event into the run's `events.jsonl`, and
  `provenance.model` in any compiled artifact names the provider that actually
  drove the run. Quietly moving from a free key onto a paid one is exactly the
  thing that should be visible before it is visible on an invoice.

The same work fixed a real failure: an open-weight model answering in prose
instead of calling a tool, which some hosts reject with a 400 on their own
response. Alongside failover, the final retry now names **one specific function**
instead of `tool_choice: "required"` — the chatbot forces `reply_to_user`, whose
worst case is the model talking to the person. Discovery deliberately forces
nothing, because there is no safe tool to force there: forcing `finish` would
fabricate an outcome the run never reached.

### 9.8 Evaluating and observing the model (not built)

**Nothing in this system evaluates the model's output today**, and that is the
most defensible-sounding gap that is actually a real one. What exists is
*evidence* — every model input is written to `observation-NN.json`, every
decision and its stated reason to `events.jsonl`, token counts to the run
summary — so the raw material for evaluation is all on disk. What is missing is
anything that reads it and forms a judgement.

Two things partially cover for that and should not be mistaken for evaluation:

- **The compiler is the real quality gate.** A model that reaches `finish` must
  name an element id for every output it claims, and ids that do not resolve in
  the current observation are dropped. A run that proves nothing compiles
  nothing. That is a correctness gate, not a quality measurement.
- **Replay is deterministic**, so the model's variance is confined to the moment
  of discovery. A bad artifact fails visibly the first time it is replayed rather
  than degrading silently in production. That is a containment property, not a
  detection one.

Here is what I would build, in the order the payoff justifies.

**1. A regression suite of frozen observations.** The single highest-value item,
and the cheapest. There are 343 committed `observation-NN.json` files, each
paired with the decision the model actually made and whether that decision
turned out to lead anywhere. That is a labelled dataset sitting in the
repository. Freeze a few dozen as fixtures, replay them through
`LlmProvider.decide()`, and assert on the tool name and the element id. It runs
offline, costs one cheap call per case, and answers the question that actually
comes up: *"we want to switch to a different model — is it better or worse on our
screens?"* Right now that question can only be answered by running live
discoveries against a bank and looking at them.

**2. Per-decision quality signals, recorded per run.** Four numbers that the loop
already has in hand and throws away:

| Signal | What it catches |
|---|---|
| **bad-element-id rate** | the model naming ids it was not shown — the clearest "it is not reading the inventory" signal, and already counted for the two-strikes rule but never persisted |
| **steps-to-goal vs. the compiled artifact's step count** | a model that reached the goal in 9 steps for a flow that compiles to 4 wandered, even though the run says success |
| **repeated-screen rate** | acting twice on the same screen state without progress — a loop the step budget will eventually stop, expensively |
| **reason/action agreement** | the stated `why` and the tool actually called disagreeing. Needs a judge, so it is the most expensive of the four and the one I would do last |

The first three are free — they are counted from the trace with no model involved.

**3. Outcome tracking over time, per product and per model.** Discovery success
rate, mean model calls per successful run, mean tokens, and the rate at which
compiled drafts are approved by a human without edits. That last one is the
honest end-to-end measure of model quality in this system: a draft a reviewer has
to fix before approving is a draft the model got *nearly* right, and nothing
currently records the difference between "approved" and "approved after edits".

**4. Model-input observability, not just model-output.** The prompt already has
hard caps on every section except one — interactive controls — and that section
is uncapped. Recording per-call prompt composition (how many tokens went to
controls vs. table cells vs. page text) would show which screens are expensive
*before* the bill does, and would turn "cap the controls section" from a guess
into a measurement.

**5. A judge, last and narrowly scoped.** Not for grading prose — for one
question at compile time: *does this compiled artifact's step list match the goal
it claims to satisfy?* A capability whose title says "read a balance" and whose
steps include a form submission is worth flagging to a reviewer. That is a
bounded, checkable question with a cheap failure mode (a false flag costs a human
thirty seconds), which is the only shape of LLM-as-judge I would trust in a
system like this.

**What I would not do.** Score every replay with a model. Replay has no model in
it, that is the entire value proposition, and adding one to *evaluate* it would
reintroduce cost and variance to the deterministic path through the back door.
The place to evaluate is at discovery and at compile time, where a model is
already present and the output is reviewed by a human anyway.

### 9.9 Which models actually suit this, and what I would choose

The system asks a model exactly one question, over and over: *given this screen
and this goal, which single tool next?* That is a narrow job, and it makes the
usual model-selection instincts wrong in two specific ways.

**Reasoning depth is not the bottleneck; instruction-following is.** Every
observed failure was a *format* failure, not a *thinking* failure — a model
answering in prose instead of calling a tool, or naming an element id it had not
been shown. Nothing in these flows requires multi-step planning: the next action
on a member search screen is not a hard inference. Paying for a frontier
reasoning model here buys almost nothing.

**Vision is close to irrelevant, which surprised me.** The committed discovery
evidence was produced by an open-weight model with **no vision at all**, and the
loop needed no changes. The model acts by element id from a text inventory of the
accessibility tree; a screenshot is corroboration it cannot act on. Screenshots
are still captured every step as evidence for humans, and only *sent* when a
provider declares `supportsVision`. On a screen-scraped or Citrix-style surface
with no accessibility tree at all, that calculus inverts completely — and that is
the one case where a vision model becomes the requirement rather than a luxury.

So the selection criteria, in order of weight: **reliable tool calling**, then
**low latency** (each call sits between two browser actions with a person
watching), then **cost per run**, then **a long enough context** for a dense
legacy screen, and only then reasoning quality.

| Job | What it needs | Sensible choice |
|---|---|---|
| **Discovery — the loop itself** | dependable tool calling, ~8k context, fast | An open-weight tool-calling model on a fast host. `openai/gpt-oss-120b` on Groq is what the committed evidence uses: 4–12 calls per run, ~$0.025 for all seven discovered capabilities. A hosted mid-tier model (Haiku-class, or GPT-4o-mini-class) is the paid equivalent and more reliable at emitting well-formed tool calls. |
| **Discovery on a genuinely hard screen** | the same, plus better recovery from ambiguity | A frontier mid-tier model (Sonnet-class). Worth switching to *per run*, not globally — the `LlmProvider` seam and the failover chain already make that a config change. |
| **The chat front door** | fast, cheap, good at picking one of ~10 tools and asking for a missing argument | The smallest reliable tool-calling model available. This runs per message with a person waiting, so latency dominates; a Haiku-class model is the right shape. |
| **Compile-time artifact review (§9.8)** | careful reading of a step list against a stated goal, once per artifact | A frontier model. It runs once per capability, ever, so cost is irrelevant and judgement is everything. This is the one place I would pay for the best available. |
| **A screenshot-only surface (not built)** | vision, and specifically reliable *grounding* — coordinates, not descriptions | A vision model with grounding ability. This is a different problem from the one this system solves and would deserve its own evaluation. |
| **Never** | — | A model in the replay path. Replay is deterministic, free and auditable; that is the product. |

**What the architecture buys here.** `LlmProvider` is one interface with one
method, the provider registry is a config table rather than a class per vendor,
and the failover chain is already sticky and evidence-emitting. Changing model is
an environment variable; changing *vendor* is an entry in the registry. The point
of that seam is precisely that model choice should be a deployment decision made
with current prices in front of you, not an architectural commitment made once.

**And the cheapest lever is not a model at all.** Discovery is a one-time cost per
capability; replay is free forever. Every flow moved from "worked out live" to
"recorded and approved" removes a model from that path permanently. Coverage
beats model selection, every time.
