# Design write-up

## 1. Architecture

**Stack.** TypeScript on Node, Playwright, Zod, Vitest. Playwright because it
exposes raw CDP, which I needed for three things a higher-level API does not
give you: the accessibility tree with coordinates, screencast frames for the
human handoff, and synthetic input into a live session. Zod because the artifact
schema needs to be one source of truth for three consumers — TypeScript types,
runtime validation of hand-edited YAML, and the JSON Schema an AI agent calls the
capability with.

**Shape.** One process, synchronous execution, no queue. The brief explicitly
says building scaling infrastructure is not rewarded, and a queue here would be
plumbing around a system whose interesting parts are elsewhere. Boundaries are
enforced by module seams, not network hops. The seams are drawn where a real
deployment would cut: `Surface` (perceive/act), `EscalationSink` (where a durable
intervention queue goes), `LlmProvider`, and the capability store.

**The central seam is `Surface`.** It has four methods and mentions neither the
DOM nor HTTP:

```ts
observe(): Promise<Observation>              // role, name, value, bounds, context
act(action, token): Promise<ActResult>       // the single chokepoint
```

Everything downstream — the schema, the resolver, the executor, the classifier,
the escalation model — is written against those types. Adding a desktop surface
means writing one class, not touching any of them. That claim is documented in
detail, including what would genuinely need adjusting, in
[`src/surface/desktop/README.md`](src/surface/desktop/README.md).

**Perception is accessibility-tree-first, not DOM-first.** `Accessibility.getFullAXTree`
joined with `DOM.getBoxModel` for geometry. Three reasons, in order of weight:
it is the same abstraction Windows UIA and macOS AX expose, so the desktop story
is real rather than aspirational; it is what a human operator perceives, and a
vendor cannot change a field's visible caption without their staff noticing,
which makes it the more stable signal; and legacy apps have generated ids and no
test IDs, so the DOM offers nothing durable anyway.

**`act()` is one chokepoint, and both paths go through it.** The discovery loop
names elements by an id from the observation it was just given; the executor
names them by a persisted descriptor. Both arrive at the same function, where
allowlist, risk policy and control-token ownership are enforced together. That is
what makes the guardrails trustworthy rather than decorative: discovery and
replay cannot drift apart in what they are permitted to do, because there is only
one place that decides.

**The model's blast radius is deliberately small.** It produces a *trace*, never
an artifact. A deterministic compiler ([`src/discovery/trace-compiler.ts`](src/discovery/trace-compiler.ts))
turns the trace into the capability, and it takes only three things from the
model: the order of actions, which element each touched, and a one-sentence
`why` that becomes human-readable prose. Locators are built from what perception
recorded. Checkpoints are derived from the observed state transition. Risk classes
come from policy rules. The error taxonomy is inherited from the product profile.
A model is good at "which link finds a member" and unreliable at "what regex
asserts we arrived"; asking it only the first question is what makes the artifact
something a person can approve.

**Trade-off I'd flag.** Perceiving the full AX tree on every observation is more
expensive than a targeted selector query — a few hundred milliseconds per step
here. I think it is the right trade: it is what makes the surface portable and
what makes ambiguity detectable at all. I did have to work for it (see §3).

**Model choice is a deployment decision, not an architectural one.** The
`LlmProvider` interface asks the model exactly one question — "given what you can
see, which single tool next" — and everything else sits outside it. That turned
out to matter more than expected: the committed discovery evidence was produced
by `openai/gpt-oss-120b` on Groq, an open-weight model with **no vision at all**,
and the loop needed no changes to accommodate it. The model acts by element id
from the text inventory, so the screenshot was always corroboration rather than
the action space. Screenshots are still captured every step as run evidence; a
provider declares `supportsVision` and they are only *sent* when it can see them.
Groq, OpenAI and anything else speaking the OpenAI wire format share one
implementation and differ by a registry entry.

The pragmatic cost of a smaller model showed up elsewhere: open-weight models
occasionally answer in prose despite `tool_choice: required`, and some hosts then
reject their own response with a 400. That is intermittent rather than
systematic, so the provider nudges and retries up to three times rather than
letting one flaky turn kill a discovery run.

**Every surface is a projection of one engine.** There are now four ways to reach
the same code — the CLI, the agent-facing catalog, the web control panel
(`npm run panel`) and the operator console — and none of them is a second
implementation. The panel in particular was written under the rule that it may
compose `Catalog`, `replay()` and `RunRecorder` and reimplement none of them: a
run started from a browser takes the identical path as `npm run replay`, honours
the identical guardrails, and writes identical evidence. This is worth stating
because the tempting version of a control panel — one that reaches into the
executor to render "nicer" progress, or keeps its own copy of the policy to
display — is exactly how a UI ends up able to do something the tested path
cannot. The panel reads `config/policy.json` live rather than restating it, for
the same reason: a safety page that can drift out of agreement with the safety
layer is worse than no safety page.

---

## 2. Artifact schema

The framing that drove everything: **a capability is an API, not a macro.** A
recorded step list tells you what keys were pressed. An API tells a caller what
it needs, what it returns, and what can happen instead. Both the agent invoking
it and the human approving it need the second thing.

[`src/capability/schema.ts`](src/capability/schema.ts) is the definition;
[`capabilities/lookup_member_savings_balance@1.0.0.yaml`](capabilities/lookup_member_savings_balance@1.0.0.yaml)
is a worked example. Four decisions are load-bearing.

**Business outcomes are declared in the contract.** `spec.outcomes.business`
lists every legitimate non-success answer with its meaning. This is a *schema*
decision, not an executor one: if there is nowhere to declare "no such member",
the executor has no choice but to throw, and the caller has no choice but to
treat it as a failure. Declaring them means replay returns `business_outcome` as
a first-class result, and an agent reading the catalog sees the full answer space
before it invokes.

**Steps carry `intent` prose beside the machine-readable target.** "Click the
control matching role=button name=Search" is not reviewable at a glance;
"Submit the search and land on the member's detail screen" is. `intent` is what
a reviewer reads, what an escalation shows the operator, and what a failure
report quotes — and it is *never* consulted to make a replay decision, so prose
drift can never change behaviour.

**Values are parameter references, never captured literals.** The recorded run
typed `10001`; the artifact stores `{{memberId}}`. This is a structural
guarantee rather than a redaction pass: there is no member data in a capability
file to leak, so capabilities can live in git and be reviewed in pull requests.
A test asserts it.

**Condition detectors are inherited from an app profile, not re-authored per
capability.** Session expiry looks identical on every screen of a product. Making
each recording rediscover it gives you twenty capabilities that each handle
timeouts slightly differently.
[`config/apps/corebank-servicing.yaml`](config/apps/corebank-servicing.yaml)
declares the taxonomy once; steps may add local conditions but never restate the
global ones.

### The locator model

This is where I spent the most design effort, because it is where record-once /
replay-many actually lives or dies. Enterprise selectors are generated
(`ctl00_ContentPlaceHolder1_txtMbrId`), churn across vendor versions, and differ
per tenant configuration. XPath through a table layout is worse.

So an `ElementDescriptor` describes a control the way a human operator would,
with several independent signals:

| Signal | Survives a re-skin? | Available on desktop? |
|---|---|---|
| `role` | yes | yes |
| `name` (accessible name) | yes, unless genuinely relabelled | yes |
| `anchors` — caption beside it, row, column header, heading | yes | yes |
| `scope` — frame, container | yes | yes (window/pane) |
| `ordinal` | yes | yes |
| `hints.domHint`, `hints.boundsAtRecord` | **no** | no |

Resolution is **scored candidate matching**, not lookup
([`src/surface/element-resolver.ts`](src/surface/element-resolver.ts)). The `domHint` field is
named a hint rather than a selector on purpose: it contributes 5 points out of
~100 and can break a tie but never make a match, so a changed selector cannot
break replay and a matching one cannot rescue a mismatched name.

Two details I would defend hardest:

**Unnamed inputs.** Legacy forms put the caption in an adjacent `<td>` with no
`<label for>`, so Chromium computes an *empty* accessible name. The target app
reproduces this faithfully because it is the common case. Perception recovers
the association geometrically — text immediately left of, or directly above, the
control — and the descriptor keys on that caption. It is what the human does, and
it works on any surface that reports bounds, including a screenshot. In a
two-column table form a left-hand caption suppresses above-captions entirely,
because the thing "above" an input is the *previous row's* label; without that
rule every field looked like it might belong to the field above it, and the
resolver correctly but uselessly reported everything as ambiguous.

**Table cells are addressed by position, never by content.** A cell's descriptor
is "the Current Balance column, in the row containing Savings" — never "the cell
containing $8,412.55", which would work exactly once, and never a column index,
which breaks when a tenant reorders. The compiler enforces this: it refuses to
record a data cell's own text as its identity, and when choosing a row key it
prefers a categorical value (`Savings`) over a record identifier (`4820117735`).
This is the single reason the same artifact reads the right number on Harbor's
build, which orders the columns differently.

---

## 3. Determinism & error handling

No LLM is imported by [`src/replay/executor.ts`](src/replay/executor.ts),
transitively or otherwise.

### The result contract

```ts
type ReplayResult =
  | { status: 'success';          outputs, steps, driftSignals, evidenceDir }
  | { status: 'business_outcome'; code, message, conditionId, atStep }
  | { status: 'escalated';        interventionId, reason, resolution, atStep }
  | { status: 'failed';           error: { class, stepId, stepIntent,
                                           expected, observed, recoveriesTried } }
```

Four arms, each meaning something operationally different to the calling agent.
A business outcome is a *different arm of the union* from a failure, not a
failure with a nicer message — the distinction is impossible to fudge because
the types will not let you.

### Waiting and classifying are the same loop

The naive structure is: act, wait for the checkpoint, and if it times out, look
around for an explanation. That reports a 12-second timeout when the app answered
"No records found" instantly.

So classification runs on **every poll** of the checkpoint wait, and a condition
match short-circuits it. Searching for a nonexistent member returns
`MEMBER_NOT_FOUND` in ~2 seconds, because the condition fires long before a
deadline that was never going to be met. Classification also runs after *every*
step, not only on failure — "No records found" appears on a page that loaded
perfectly and returned HTTP 200.

### A timeout is a diagnosis of last resort

`checkpoint_failed` means "we waited, and nothing we know about explains why".
Anything the product profile can explain is reported as *that*. The e2e suite
asserts this directly: with an application error injected, the result is
`surface_error` with `observed: "Unexpected System Error"` at step `s3` — not a
timeout. A timeout that could have been diagnosed is a debugging tax paid by
whoever is on call at 2am.

### Three classes, in fixed order

| Order | Class | Response |
|---|---|---|
| 1 | **business** | stop cleanly, return the declared code, never throw |
| 2 | **recoverable** | run a handler from a **closed set**, bounded per-condition and by a global budget, then re-verify |
| 3 | **hard failure** | stop, capture screenshot + AX snapshot + event tail, report step / expected / observed |

The recovery set is closed — `dismiss_dialog`, `wait_retry`, `reauthenticate`,
`navigate_back` — and that is a deliberate refusal of the obvious alternative. An
open "run this to recover" hook would mean a reviewer approving a capability
could no longer tell what it might do, and would be the natural place for a model
to smuggle unreviewed behaviour into the deterministic path.

### Three bugs worth reporting, because they were the real work

Getting this deterministic took three fixes that were each invisible until
hunted down, and each is a general lesson rather than a local patch.

1. **Torn observations.** Perceiving the AX tree and reading page text are
   separate round trips, and a frameset navigates a frame out from under you
   constantly. Captured independently, the text came from the new screen and the
   inventory from the old one — so a checkpoint passed while the elements needed
   to satisfy it were absent. Fixed with a stability window: fingerprint every
   frame's location *and* `readyState`, capture, re-fingerprint, retry if
   anything moved.

2. **The accessibility tree lags the DOM.** This was the nasty one. Immediately
   after a navigation commits, a frame can report `readyState: "complete"` with
   fully populated `innerText` while `getFullAXTree` still returns a partial
   tree. Symptom: intermittent "declared output not found", about one run in
   three, never reproducible when you went to look. The page was fine; our
   picture of it was half-built. Fixed by checking **text coverage** — if the
   tree accounts for less than half the document's text, it is still under
   construction, so wait and ask again. A node count is not enough; the failing
   tree had a plausible handful of nodes and none of the table.

3. **A recovery is not finished when its action returns.** Dismissing a dialog
   posts a form. Re-classifying before the response landed saw the dialog still
   present, counted it as a recurrence, and burned the attempt budget on a
   recovery that was working. Fixed by waiting until the condition that triggered
   the recovery stops holding.

The same discipline now applies to output extraction and to the capability-level
success checkpoint: both poll within a deadline rather than glancing once, and
retries are logged so a genuinely wrong descriptor still surfaces as a descriptor
problem. Twelve consecutive clean runs on the tenant that used to fail one in
three.

### UI drift, secondarily

Every resolution reports its score and the strategy that won. A descriptor that
used to match on accessible name and now matches only structurally still works —
and that degradation is the earliest, cheapest signal that a tenant has moved. It
is emitted as a `drift_signal` in the run report and costs nothing, because the
resolver already computed it. Replaying against First Valley produces exactly one:
their member-id field is relabelled, resolves structurally at 0.571, and says so.

---

## 4. Heterogeneity & multi-tenant

### Surface abstraction

The seam is `Surface`, and the reason it is credible is that `ElementNode`'s
vocabulary was chosen as the *intersection* of what browser AX, Windows UIA and
macOS AX expose — not as a browser abstraction with desktop bolted on later. The
full mapping, and what would genuinely need adjusting (`urlMatches` has no
desktop analogue; `domHint` becomes meaningless, which is the test of whether it
was correctly treated as a hint), is in
[`src/surface/desktop/README.md`](src/surface/desktop/README.md).

The legacy-web case is not hypothetical here — it is the only case. The target
app is a `<frameset>` with table layouts, generated ids, no test IDs and
unlabelled inputs, and the frame-path handling, the geometric caption recovery
and the header-based table addressing all exist because that app demanded them.

One honest note on acting: the web surface clicks by coordinate, which is the
mechanism that ports. The exception is `select` on a native dropdown, which is
driven through the platform's semantic action rather than by pixels, because a
native popup lives outside the page's coordinate space. That is the same thing a
desktop surface does through UIA's `SelectionItemPattern` — "ask the platform to
perform the control's action" — so it is a port, not a DOM shortcut.

### Multi-tenant reuse

Hundreds of institutions run the same vendor product. The tempting answer —
re-record per tenant — gives you N copies that drift independently, N places to
fix a bug, and no way to see how tenant 47 differs from the reference install.

So: **one base spec plus JSON-Pointer patches per tenant**, which makes the
*difference* the reviewable unit. Adding an institution is a config entry in the
product profile, not an engineering project.

What that buys, demonstrated by the same artifact running against three installs:

- **Harbor CU** — newer build (9.0), accounts table columns reordered, mandatory
  privacy acknowledgement before member detail. **Zero overrides.** The reorder
  is absorbed because cells are addressed by column header and row; the extra
  screen is handled by a condition declared on the *tenant* in the product
  profile, which every capability for that product inherits automatically.
- **First Valley** — two controls relabelled. **Two patches**, four lines,
  legible in a diff. The third difference (their member-id field is also
  relabelled) is *not* patched: it resolves structurally and emits a drift
  signal, so the system tells you it has degraded without breaking.

That split is the honest version of the story: most tenant variation is absorbed
by the locator model, genuine relabels need a patch, and the drift signal is what
tells you which is which — without re-recording anything.

**Drift detection at scale.** You do not diff screenshots; you watch how your
locators are winning. Per-step `resolutionScore` and `strategyUsed` are recorded
on every run. A tenant whose capabilities increasingly resolve via fallback
strategies is a tenant that has upgraded, and it surfaces before anything fails.
Aggregating those signals across tenants is the piece I did not build.

---

## 5. Escalation & handoff

### Detecting stuck

Five conditions raise an intervention, and they carry *why* rather than a
generic failure:

| Trigger | Class |
|---|---|
| policy refuses an irreversible step | `policy_irreversible` |
| a condition recurs past its recovery budget | `unrecovered_condition` |
| a checkpoint fails with nothing explaining it | `checkpoint_failed` |
| two candidates match a descriptor too closely | `ambiguous_target` |
| the discovery model gives up or is blocked | `agent_stuck` |

Discovery escalates through the same broker and the same control model as replay.

### Control as a capability token, not a flag

This is the design decision I care most about here. A boolean "human is driving"
flag that the executor is trusted to check is how you get a race where automation
clicks Submit while an operator is mid-keystroke on the same page.

So control is a **token** ([`src/escalation/control-authority.ts`](src/escalation/control-authority.ts)).
`act()` demands one and compares it to the authority's current holder; the token
is *rotated* on every transition, so an executor holding a stale copy cannot act
even if it never consults the state machine. It is the same chokepoint the
allowlist uses, so one mechanism enforces both "may this actor act at all" and
"is this action permitted".

```
AUTOMATION ─request_intervention→ PENDING_HUMAN ─claim→ HUMAN
     ↑                                  │                 │
     └──────── RESUMING ←───────────────┴── abandon ──────┘ hand_back
```

### Taking control of the live session

The operator console
([`src/escalation/operator/`](src/escalation/operator/)) streams the running
page over CDP screencast and forwards the operator's mouse and keyboard back
through CDP input. It is the same browser session the executor was driving — not
a fresh one, not a replay. Viewing needs no token, deliberately: an operator
should be able to understand a stuck run before deciding to take it on. Input
requires the claimed token, and is refused without it —
[`scripts/demo-human-handoff.ts`](scripts/demo-human-handoff.ts) asserts that refusal as part
of the demonstration.

Human actions are recorded as run evidence. Typed *characters* are not: an
operator filling in a member's details would otherwise write regulated data into
the log one keystroke at a time. Named keys and clicks are.

### Handing back

`handBack` moves to `RESUMING`, **not** to `AUTOMATION`. The executor must
re-observe and evaluate the intervention's **resume contract** — normally the
step's own checkpoint — before it gets a usable token back. A human saying "done"
is a claim; the checkpoint is the fact. If the contract does not hold, the run
re-escalates with the delta rather than proceeding on trust.

### Mocked, and named as such

No operator authentication, no queue or assignment, no session recording
playback, and the broker is in-process so a pending intervention dies with the
run. Those are the parts the brief allows stubbing. The seam is `EscalationSink`;
a durable queue and an on-call rota go behind it and the executor does not change.

---

## 6. Safety

**Allowlist**, enforced in two places. `act()` checks every action, and
`page.route()` checks every navigation at the network layer — so an in-page JS
redirect or meta-refresh to somewhere off-allowlist is stopped even though no
action was taken and `act()` never saw it. Navigation is checked against its
*destination*, not the current page. `/_admin/**` is denied, so the automation
cannot reach the target app's own fault-injection hooks: the harness may arm
faults, the agent may not.

**Risk classes** — `safe`, `mutating`, `irreversible` — assigned by declarative
rules over action type, target accessible name and route
([`config/policy.json`](config/policy.json)). Irreversibility is a property of
the effect, not of the widget, so it is data rather than code.

The asymmetry between discovery and replay is the judgement call:

- **Discovery never takes an irreversible action.** Not with a confirmation, not
  at high confidence. The model is exploring, and exploring by pressing "Post
  Transfer" in a bank is not acceptable at any confidence level. It escalates.
- **Replay takes one only when two independent gates are open**: the artifact is
  `approval: approved` (a human read the step list and agreed) *and* the
  invocation passed explicit authorisation (`--authorize-irreversible`). Approval
  says "this flow is correct"; authorisation says "do it now, for real". Either
  alone is too easy to set by accident.

A denied irreversible step is **not a failure** — it escalates, because a human
can legitimately complete it. A denied *route* is a hard failure, because no human
should be able to consent us out of the containment boundary.

Policy is authoritative over the artifact's declared `guard.risk`. If a step
claims to be safe and policy classifies it irreversible, policy wins and the run
logs a `risk_declaration_mismatch` — the artifact is misleading whoever approved
it, which is worth surfacing even though the action was handled correctly.

**Redaction happens at the write boundary**, not at call sites, because relying
on each caller to remember is how leaks happen. Everything bound for disk goes
through [`src/policy/redaction.ts`](src/policy/redaction.ts). Secrets are never written
in any form; PII is written as a per-run salted hash plus a four-character suffix,
so you can tell "the same account appeared at step 3 and step 9" while debugging
without the value existing in the log. Screenshots have sensitive elements
blacked out **before capture**, so the pixels never exist as bytes. Credentials
live in environment variables the app profile *names* rather than contains.

### Limits, stated plainly

- The allowlist is a containment boundary, not a sandbox. A compromised
  dependency in this process ignores all of it.
- Risk classification is pattern-based. A button named "Continue" that posts a
  transfer would be classified `safe`. The mitigation is that irreversibility is
  also matched by route, and that a reviewer sees `guard.risk` per step in the
  artifact — but a genuinely mislabelled control is a real gap.
- Redaction patterns are configured for this product's data shapes. A new vendor
  with differently-shaped account numbers needs its patterns extended, and the
  failure mode is silent.
- PII hashes are per-run by default. Setting `REDACTION_SALT` to correlate across
  runs makes the log a stable pseudonymous index — a real trade-off, so it is off
  by default.
- The human handoff has no authentication. Anyone who can reach port 4100 can
  take control of a live banking session. That is the single largest gap between
  this and something deployable.

---

## 7. Cuts

**Deliberately not built**

- **Desktop surface.** Interface defined, mapping documented, not implemented.
  This is the biggest single cut and the most defensible: the seam is what the
  brief asked for, and a second surface would have cost the depth in the schema
  and the error taxonomy.
- **Operator authentication, queueing, assignment, session recording.** The
  handoff *mechanism* is real; the console around it is minimal.
- **A durable intervention queue.** In-process broker. A pending intervention
  dies with the run.
- **Queue/worker infrastructure.** Deliberate — the brief penalises it.
- **Bounded LLM recovery on replay failure.** Designed (it would be a fifth
  entry in the closed recovery set, policy-checked and evidence-recorded) but not
  built. I preferred to keep the deterministic path free of the model entirely
  for this submission.
- **A product-version overlay** between base spec and tenant patches. The two
  versions in play differ only in ways the locator model already absorbs;
  building the layer without a case that needed it would have been speculative.
- **Confidence scoring / approval gating on replay statistics.** `approval` is a
  field a human sets; nothing computes a reliability score for them yet.

**What I would build next, in order**

1. **Authentication on the operator console**, and an audit trail tying each
   intervention to a named, authenticated operator. It is the one gap that makes
   the current system unshippable rather than merely incomplete.
2. **Drift aggregation across tenants.** The per-run signals already exist; what
   is missing is the service that notices "eleven institutions on build 9.0
   started resolving this step structurally last Tuesday" and opens a ticket
   before anything fails.
3. **A capability test harness in CI** — replay every approved capability against
   a seeded instance on every vendor release, and gate the `approved` flag on it.
   This is what turns "record once" into something an institution can rely on.
4. **The desktop surface**, starting with a UIA sidecar, because the long tail of
   bank back-office software is not all in a browser.
5. **Bounded assisted recovery** for a single failed step, policy-checked and
   recorded as evidence — valuable, but only once the deterministic path has
   enough production mileage to know which failures are worth spending a model on.

**Known rough edges**

- Perception costs a few hundred milliseconds per observation. Fine here;
  it would want incremental AX updates rather than full snapshots at volume.
- The compiler infers input types conservatively (everything is a `string`,
  everything is `pii`) and expects a human to tighten them during review. That is
  the right default direction, but it does mean a freshly compiled artifact needs
  editing before it is pleasant to call.
- The scripted `ScriptedProvider` covers only the lookup flow. It refuses to guess on
  a screen it has not been taught, which is correct behaviour for a fixture, but
  it means `--provider scripted` is not a general offline mode.
