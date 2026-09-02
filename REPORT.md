# Design write-up

## 1. Architecture

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
*sent* when a provider declares `supportsVision`.

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

### Limits, stated plainly

- The allowlist is a containment boundary, not a sandbox. A compromised
  dependency in this process ignores all of it.
- Risk classification is pattern-based. A button named "Continue" that posts a
  transfer would be classified `safe`. Mitigated by also matching on route and by
  `guard.risk` being visible per step — but a mislabelled control is a real gap.
- Redaction patterns are configured for this product's data shapes. A new vendor
  needs them extended, and the failure mode is silent.
- **The handoff has no authentication.** Anyone who can reach port 4100 can take
  control of a live banking session. This is the single largest gap between this
  and something deployable.

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
