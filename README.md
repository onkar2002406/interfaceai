# Computer-Use Automation System

**Giving an AI agent hands inside applications that have no API.**

---

## Table of contents

1. [The problem](#1-the-problem)
2. [The idea in one picture](#2-the-idea-in-one-picture)
3. [Quick start](#3-quick-start)
4. [Capturing a live discovery run](#4-capturing-a-live-discovery-run)
5. [Guided tour](#5-guided-tour) — every feature, with the command that shows it
6. [How it works](#6-how-it-works)
7. [Project layout](#7-project-layout)
8. [Concepts and vocabulary](#8-concepts-and-vocabulary)
9. [Testing](#9-testing)
10. [Development tools](#10-development-tools)
11. [Troubleshooting](#11-troubleshooting)
12. [Design write-up](#12-design-write-up)

---

## 1. The problem

When a system exposes an API, you integrate through the API. This project is
about everything else.

Banks and credit unions run a long tail of **legacy back-office applications
with no API at all** — core banking screens, servicing tools, admin consoles.
The only way in is to drive the user interface the way a human operator would.
These applications are typically:

- **server-rendered and old** — framesets, table layouts, generated element ids
  that change between vendor releases, and no test IDs anywhere
- **stable, but full of real runtime states** — validation errors, "record not
  found", permission denials, surprise dialogs, session timeouts, slow loads
- **deployed hundreds of times over** — the same vendor product, configured,
  branded and versioned differently for every institution

An AI agent needs to *operate* these applications. Asking a language model to
re-reason about the same screen on every single invocation is slow, expensive,
and — most importantly — not reproducible. You cannot let a model improvise
inside a banking system every time somebody looks up an account.

### The approach

Use the model **once**, to work out how the task is done. Record what it learned
as a **reusable, reviewable, typed artifact**. From then on, replay that artifact
**deterministically, with no model involved at all**.

> **The model discovers. The artifact becomes a reusable capability.
> Deterministic replay is how the AI agent invokes it in production.**

---

## 2. The idea in one picture

```
      ┌──────────────┐
      │  a goal, in  │   "look up member {{memberId}} and read
      │  plain words │    their current savings balance"
      └──────┬───────┘
             │
             ▼
   ╔═════════════════════╗
   ║   DISCOVERY         ║   An LLM drives the real UI: it looks at the
   ║   (the model runs   ║   screen, decides one action, acts, looks again.
   ║    exactly once)    ║   Produces a *trace*, not an artifact.
   ╚══════════┬══════════╝
              │
              ▼
   ╔═════════════════════╗
   ║   COMPILATION       ║   Deterministic code turns the trace into a typed
   ║   (no model)        ║   capability: locators, checkpoints, risk classes
   ╚══════════┬══════════╝   and the error taxonomy are all *derived*.
              │
              ▼
      ┌────────────────────────────────┐
      │  capabilities/*.yaml           │  A human reads it and approves it.
      │  a reviewable contract         │  It lives in git like code.
      └──────┬─────────────────────────┘
             │
             ▼
   ╔═════════════════════╗
   ║   REPLAY            ║   Same steps, every time. Returns typed outputs,
   ║   (no model, ever)  ║   or a declared business outcome, or a debuggable
   ╚══════════┬══════════╝   failure, or escalates to a human.
              │
              ▼
      ┌──────────────┐
      │  AI agent    │   Calls it by name with typed arguments, the way it
      │  in prod     │   would call any other tool.
      └──────────────┘
```

### What makes this hard, and what this system does about it

| The hard part | What this system does |
|---|---|
| Legacy apps have no stable selectors | Identifies controls the way a **human** does — by role, accessible name, and the caption physically beside them. Never by CSS selector. |
| Legacy text inputs have **no accessible name at all** | Recovers the caption geometrically from the text sitting to the left of, or above, the field. |
| A table's columns get reordered between versions | Addresses a cell by its **column header and row contents**, never by index. |
| "No such member" is not a crash | Business outcomes are **declared in the capability's contract** and returned as a distinct kind of result. |
| A checkpoint that never arrives | Runtime conditions are classified on **every poll**, so an answer beats a timeout. A timeout is a diagnosis of last resort. |
| Some actions cannot be undone | Irreversible actions are **never** taken during discovery, and need two independent approvals during replay. Otherwise the run parks and asks a human. |
| A human needs to step in | The operator takes control of the **same live browser session**, does the step by hand, and hands control back — with the executor re-verifying before it resumes. |
| The same app, 300 institutions | One base artifact plus small per-tenant patches, with a **drift signal** that tells you which tenants have moved. |

---

## 3. Quick start

**Requirements:** Node 20 or newer. Everything else installs locally.

```bash
npm install
npx playwright install chromium

cp .env.example .env          # Windows PowerShell: copy .env.example .env
```

That is enough to run **everything except live discovery**. The demo application,
deterministic replay, the error taxonomy, the safety guardrails, the human
handoff and the full test suite all work with no API key.

For live discovery you need a model that supports tool calling. **Groq has a free
tier**, so it is the default:

```
GROQ_API_KEY=gsk_...              # https://console.groq.com/keys
GROQ_MODEL=openai/gpt-oss-120b
```

OpenAI works too — set `OPENAI_API_KEY` instead. Discovery uses whichever
provider key it finds, or you can name one with `--provider groq|openai|scripted`.

> **On vision.** Discovery works from a **text inventory** of what is on screen,
> not from the picture: the model acts by element id, never by coordinate. So a
> model with no vision at all is fine, and Groq's free tier has none. Screenshots
> are still captured for every step as run evidence — they are just not sent to
> the model unless it can see them. The provider declares this, and the run
> report says which happened.

Then, in **two terminals**:

```bash
# Terminal 1 — the target application
npm run app

# Terminal 2 — replay a saved capability, deterministically
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001
```

```
SUCCESS lookup_member_savings_balance@1.0.0 [base] in 3491ms
Outputs: {
  "savingsBalance": 8412.55,
  "savingsAccountNumber": "4820117735"
}
```

No model was involved in that run.

### Running discovery without an API key

```bash
npm run discover -- --goal "look up member {{memberId}} and read their current savings balance" \
                    --param memberId=10001 --provider scripted
```

`--provider scripted` swaps the language model for a **fixture**: a small rule
set that returns the tool call a competent model would make on each screen. The
browser, the perception layer, the compiler and the evidence pipeline are all the
real ones — only the decision-maker is substituted.

It exists so the pipeline can be regression-tested deterministically and so a
reviewer without a key can run the whole end-to-end thread. It deliberately
**refuses to guess** on a screen it has not been taught, which makes it a fixture
rather than a general offline mode — and it is not a substitute for the real
thing.

---

## 4. Capturing a live discovery run

> [!IMPORTANT]
> If [`evidence/README.md`](evidence/README.md) opens with a warning banner, the
> committed discovery run was produced by the offline fixture and still needs to
> be replaced with a genuine model-driven run.

```bash
# 1. a provider key in .env — GROQ_API_KEY (free tier) or OPENAI_API_KEY
#    (with OpenAI, a valid key on an unfunded account gives 429
#     insufficient_quota — see Troubleshooting)

# 2. target application, in one terminal
npm run app

# 3. regenerate every recorded run, discovery included, in another
npm run evidence

# 4. the human-handoff run is captured separately
npm run handoff

# 5. confirm the freshly compiled artifact replays on data it never saw
npm run replay -- --capability discovered_member_savings --input memberId=10003
```

`npm run evidence` uses a live model whenever a provider key is set, and falls
back to the fixture only if the live attempt does not *succeed* — saying which,
and why, in its output and in the evidence banner. Afterwards, check that
`capabilities/discovered_member_savings@1.0.0.yaml` names a real model under
`metadata.provenance.model`, then commit the regenerated `evidence/` and
`capabilities/` directories. A single discovery run costs a few cents.

---

## 5. Guided tour

Each section below is one capability of the system and the exact command that
demonstrates it. Keep `npm run app` running throughout.

### 5.0 The target application

```bash
npm run app
```

Three instances of the **same fake vendor product**, configured as three
different institutions:

| URL | Institution | Product version | How it differs |
|---|---|---|---|
| http://localhost:4000 | CoreBank Reference Install | 8.2 | the baseline |
| http://localhost:4001 | First Valley Credit Union | 8.2 | two controls relabelled |
| http://localhost:4002 | Harbor Credit Union | 9.0 | reordered accounts table, mandatory privacy screen |

This is a deliberately hostile stand-in for a back-office banking application. It
uses a real `<frameset>`, table-based layout, `<font>` tags, ASP.NET-style
generated ids (`ctl00_ContentPlaceHolder1_txtMbrId`), no test IDs, and — the
important one — **no `<label for>` on any text input**, so those inputs have a
completely empty accessible name, exactly as they do in the real thing.

Sign on with `svc.demo` / `demo1234`. Every piece of data is invented.

<details>
<summary>Members you can look up</summary>

| Member ID | What happens |
|---|---|
| `10001` | normal record, savings + checking |
| `10002` | normal record, savings + certificate |
| `10003` | normal record, savings only |
| `10004` | normal record, low balances |
| `10007` | **restricted** — produces `PERMISSION_DENIED` |
| `99999` | does not exist — produces `MEMBER_NOT_FOUND` |

</details>

### 5.1 Discovery — a model works out the flow

```bash
npm run discover -- \
  --goal "look up member {{memberId}} and read their current savings balance" \
  --param memberId=10001
```

The `{{memberId}}` placeholder is what makes the result reusable: the model sees
the concrete value, and the compiler substitutes the reference back in, so the
saved artifact contains `{{memberId}}` and never `10001`.

Produces:
- a capability at `capabilities/<name>@1.0.0.yaml`
- the full transcript, per-step screenshots and observations under
  `evidence/discovery-<id>/`

The capability lands as **`approval: draft`**. Compilation never approves
anything — a human reads the file and decides.

### 5.2 Replay — deterministic, no model

```bash
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001
```

### 5.3 The four kinds of result

The result contract has four arms, and each means something different to whoever
called the capability.

```bash
# SUCCESS — typed outputs
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001

# BUSINESS_OUTCOME — a legitimate answer, not a crash
npm run replay -- --capability lookup_member_savings_balance --input memberId=99999
#   BUSINESS_OUTCOME MEMBER_NOT_FOUND

npm run replay -- --capability lookup_member_savings_balance --input memberId=10007
#   BUSINESS_OUTCOME PERMISSION_DENIED

# FAILED — with enough detail to debug, and correctly diagnosed
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001 --fault app_error
#   FAILED surface_error at s3 ("Submit the search and land on the member's
#   detail screen.") — observed "Unexpected System Error"
```

Note what the last one does **not** say: it does not report a checkpoint timeout.
The application error is recognised and named. A timeout that could have been
diagnosed is a debugging tax paid by whoever is on call.

Malformed arguments are rejected before a browser is even launched:

```bash
npm run replay -- --capability lookup_member_savings_balance --input memberId=abc
#   Invalid inputs for lookup_member_savings_balance:
#     - "memberId" must match /^[0-9]{1,9}$/
```

### 5.4 Recovering from runtime conditions, without a human

```bash
# a surprise "Scheduled Maintenance" overlay appears mid-flow
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001 --fault interstitial
#   recovery_attempt  dismiss_dialog -> SUCCESS

# the session silently expires halfway through
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001 --fault session
#   recovery_attempt  reauthenticate -> flow_restart -> SUCCESS

# the server stalls for six seconds
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001 --fault slow
#   absorbed by checkpoint polling -> SUCCESS
```

The session case is worth watching closely. Signing in again gets a **session**,
but not your **place in the flow** — the old session's state is gone. So replay
restarts the capability from its entry point rather than continuing from a step
that would now run against the wrong screen. And if an irreversible step has
already been committed, it refuses to restart at all and escalates instead,
because replaying a half-completed mutating flow is how you open the same account
twice.

### 5.5 One artifact, three institutions

```bash
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001 --tenant firstvalley
```
```
SUCCESS ... [firstvalley]

Drift signals (1) — this tenant may need an override:
  s2: wanted unnamed textbox, labelled "Member ID", in frame main/contentFrame
         matched "" at 0.571 via frame
```

First Valley relabelled three controls. Two are handled by **overrides** — four
lines of JSON-Pointer patch in the artifact. The third is *not* patched: it
resolves structurally and reports a **drift signal**, which is the system telling
you it has degraded without breaking.

```bash
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001 --tenant harborcu
#   SUCCESS with ZERO overrides
```

Harbor runs a newer build that reorders the accounts table **and** injects a
mandatory privacy acknowledgement before member detail. Neither needs an
override: the reorder is absorbed because cells are addressed by column header
and row, and the extra screen is handled by a condition declared once on the
tenant, which every capability inherits.

### 5.6 Safety — irreversible actions

`open_sub_account` ends by actually creating an account record. Invoked without
authorisation, replay **parks instead of committing**:

```bash
npm run replay -- --capability open_sub_account \
  --input memberId=10001 --input accountType=Savings \
  --input initialDeposit=100.00 --input "nickname=Holiday Fund"
```
```
ESCALATED (unattended) at s9 — irreversible step requires an approved artifact
and explicit invocation authorisation (IRREVERSIBLE_SUBMIT)
```

Two independent gates must both be open for it to run unattended: the artifact
must be `approval: approved` (a human read the step list and agreed) **and** the
invocation must pass explicit authorisation (this run, right now, for real):

```bash
npm run replay -- --capability open_sub_account \
  --input memberId=10001 --input accountType=Savings \
  --input initialDeposit=100.00 --input "nickname=Holiday Fund" \
  --authorize-irreversible
#   SUCCESS — outputs: { "newAccountNumber": "4820990001" }
```

### 5.7 Human-in-the-loop handoff

Start the same blocked run with an operator console attached:

```bash
npm run replay -- --capability open_sub_account \
  --input memberId=10001 --input accountType=Savings \
  --input initialDeposit=100.00 --input "nickname=Holiday Fund" --operator
```

Open **http://localhost:4100**. You will see:

1. the intervention, with which capability, which step, its plain-English intent,
   why it stopped, and **what must be true before automation may resume**
2. a **live view of the stuck session** — you can watch before deciding anything
3. **Take control** — until you press this, clicking on the screen is *refused*
4. the actual page, live. Press **Submit Application** yourself.
5. **Hand control back** — automation re-observes, verifies its resume contract,
   and finishes the run

This is the same browser session the automation was driving. Not a fresh one, not
a replay of it.

For a reproducible version of that whole exchange:

```bash
npm run handoff
```

That script stands in for the *person* only. The console, the CDP screencast, the
input path, the control-token checks and the resume verification are all real —
including an explicit assertion that input is **refused** before control is
claimed.

### 5.8 The agent-facing capability catalog

This is what an AI agent sees.

```bash
npm run catalog -- list
```
```
3 capability/capabilities available to an agent:

  lookup_member_savings_balance@1.0.0  [approved, read-only]
    Look up a member's savings balance
    in:  memberId
    out: savingsBalance, savingsAccountNumber
    or:  MEMBER_NOT_FOUND, PERMISSION_DENIED, VALIDATION_ERROR

  open_sub_account@1.0.0  [approved, HAS IRREVERSIBLE STEP]
    ...
```

```bash
npm run catalog -- tools                                  # function-calling definitions
npm run catalog -- describe lookup_member_savings_balance # full JSON Schema
npm run catalog -- invoke lookup_member_savings_balance --input memberId=10002
```
```json
{
  "status": "success",
  "capability": "lookup_member_savings_balance@1.0.0",
  "outputs": { "savingsBalance": 250, "savingsAccountNumber": "4820224419" }
}
```

The `or:` line matters. An agent that can see `MEMBER_NOT_FOUND` in the tool
description before it calls will handle a missing member; one that cannot will
retry a "failure" three times.

---

## 6. How it works

### 6.1 Perception — reading the screen like a person

The system does **not** read the DOM. It reads the **accessibility tree** — the
representation browsers and operating systems expose for screen readers — via
Chrome DevTools Protocol, joined with element geometry.

Three reasons:

1. **It ports.** Windows UI Automation and macOS AX expose the same vocabulary
   (role, name, value, states, bounds). A desktop implementation produces the
   same data structure without anything downstream changing.
2. **It is what the operator sees.** A vendor can restructure their markup freely
   between releases; they cannot change a field's visible caption without their
   own staff noticing. So it is the more stable signal.
3. **Legacy apps offer nothing else.** Generated ids, no test IDs. There is
   nothing durable in the DOM to key on.

Each perceived control becomes an `ElementNode`:

```ts
{
  role: "textbox",
  name: "",                                 // legacy inputs often have NO name
  proximateLabels: ["Member ID"],           // recovered geometrically
  bounds: { x: 258, y: 65, width: 128, ... },
  framePath: ["main", "contentFrame"],
  context: { columnHeader: "Current Balance", rowCells: ["...", "Savings", ...] }
}
```

### 6.2 Locators — how a recorded step finds its control again

CSS selectors in enterprise applications are generated, churn between versions,
and differ per tenant. So a recorded step stores an `ElementDescriptor` that
describes a control the way a person would, using several independent signals:

```yaml
description: the member identifier box on the search form
role: textbox
# no `name` — this input has no accessible name at all
anchors:
  - relation: proximateLabel     # "the box next to 'Member ID'"
    text: Member ID
scope:
  framePath: [main, contentFrame]
hints:
  domHint: input#ctl00_ContentPlaceHolder1_txtMbrId   # a HINT, never a locator
```

Resolution is **scored candidate matching**, not lookup. Every element on screen
is scored against the descriptor, and two properties matter more than raw hit
rate:

- **It refuses when unsure.** The best candidate must clear an absolute threshold
  *and* beat the runner-up by a margin, or the result is `AMBIGUOUS_TARGET`.
  A stalled run escalates to a human; a confident wrong click posts a transaction.
- **It reports how it won.** A descriptor that used to match on accessible name
  and now matches only structurally still works — and that degradation is the
  earliest available signal that a tenant has drifted, so it is surfaced as a
  **drift signal** rather than silently absorbed.

`domHint` is called a hint on purpose: it is worth 5 points out of roughly 100 and
can break a tie but never *make* a match. A changed selector cannot break replay,
and a matching one cannot rescue a mismatched name.

### 6.3 The capability artifact

A capability is **an API, not a macro**. A step list tells you what keys were
pressed; an API tells a caller what it needs, what it returns, and what can happen
instead.

```yaml
metadata:
  name: lookup_member_savings_balance      # what an agent calls it by
  version: 1.0.0
  approval: approved                       # gates unattended irreversible replay
  app: { product: corebank-servicing, productVersion: '8.2', tenant: base }
  provenance:                              # points AT the transcript, never embeds it
    model: groq:openai/gpt-oss-120b
    traceRef: evidence/discovery-.../trace.json

spec:
  inputs:
    - name: memberId
      type: string
      pattern: '^[0-9]{1,9}$'
      sensitivity: pii                     # drives redaction everywhere

  outputs:
    - name: savingsBalance
      type: money
      from:
        target:                            # by position in the table, never by value
          role: cell
          anchors:
            - { relation: underColumn, text: Current Balance }
            - { relation: inRowWith,   text: Savings }

  steps:
    - id: s2
      intent: Type the member identifier into the search field.   # for humans
      action:
        type: type
        value: '{{memberId}}'              # a REFERENCE, never a captured value
        target: <ElementDescriptor>
      guard: { risk: mutating }
      checkpoint: { describe: ..., all: [...], timeoutMs: 12000 }

  outcomes:                                # the declared result contract
    business:
      - code: MEMBER_NOT_FOUND
        meaning: No member matches the supplied identifier...

overrides:                                 # per-tenant, as JSON-Pointer patches
  firstvalley:
    patches:
      - path: /steps/0/action/target/name
        value: Find Member
        why: Their menu says "Find Member".
```

Worth reading in full:
[`capabilities/lookup_member_savings_balance@1.0.0.yaml`](capabilities/lookup_member_savings_balance@1.0.0.yaml).

### 6.4 Replay and the error taxonomy

Replay imports no language model, transitively or otherwise.

Every step runs as **resolve → act → settle**, where "settle" is a single loop
that both waits for the checkpoint and classifies what it sees:

```
loop until the checkpoint holds, or the deadline passes:
    observe the screen
    classify against the condition set:
        business outcome?  -> stop cleanly, return the declared code
        recoverable?       -> run a bounded handler, wait for its effect, retry
        known fatal?       -> stop with a specific diagnosis
    checkpoint satisfied?  -> done
```

Because classification runs on **every poll**, searching for a member that does
not exist returns `MEMBER_NOT_FOUND` in about two seconds — the condition fires
long before a twelve-second deadline that was never going to be met.

Recovery handlers are a **closed set** — `dismiss_dialog`, `wait_retry`,
`reauthenticate`, `navigate_back` — each bounded per-condition and by a global
budget. Closed on purpose: an open "run this script to recover" hook would mean a
reviewer approving a capability could no longer tell what it might do.

The condition set itself is authored **once per vendor product**, in
[`config/apps/corebank-servicing.yaml`](config/apps/corebank-servicing.yaml), and
inherited by every capability for that product. Session expiry looks the same on
every screen; making each recording rediscover it is how you end up with twenty
capabilities that each handle timeouts slightly differently.

### 6.5 Safety

- **Allowlist**, enforced in two places: at the single action chokepoint, and at
  the network layer via request interception — so an in-page redirect to
  somewhere off-allowlist is stopped even though no action was taken. The
  application's own fault-injection endpoints (`/_admin/**`) are denied, so the
  automation cannot reach its own test hooks.
- **Risk classes** — `safe`, `mutating`, `irreversible` — assigned by declarative
  rules over action type, target name and route, in
  [`config/policy.json`](config/policy.json).
- **Discovery never takes an irreversible action.** Not with a confirmation, not
  at high confidence. Exploring by pressing "Post Transfer" in a bank is not
  acceptable at any confidence level.
- **Redaction happens at the write boundary**, not at call sites. Secrets are
  never written in any form; PII is written as a per-run salted hash so events can
  be correlated while debugging without the value existing in the log; and
  screenshots have sensitive elements blacked out **before capture**, so the
  pixels never exist as bytes.

### 6.6 Control transfer

Control is a **capability token**, not a flag:

```
AUTOMATION ─request_intervention→ PENDING_HUMAN ─claim→ HUMAN
     ↑                                  │                 │
     └──────── RESUMING ←───────────────┴── abandon ──────┘ hand_back
```

Every action must present the current token, and the token is **rotated on every
transition** — so an executor holding a stale copy cannot act even if it never
consults the state machine. That closes the race where automation clicks Submit
while an operator is mid-keystroke on the same page.

Handing back moves to `RESUMING`, **not** to `AUTOMATION`. The executor must
re-observe and check the intervention's **resume contract** before it gets a
usable token back. A human saying "done" is a claim; the checkpoint is the fact.

---

## 7. Project layout

```
├── README.md                    you are here
├── REPORT.md                    design write-up: decisions, trade-offs, cuts
├── evidence/                    recorded runs — start with evidence/README.md
├── capabilities/                saved capability artifacts (reviewed, versioned)
├── config/
│   ├── policy.json              allowlist + risk classification rules
│   └── apps/
│       └── corebank-servicing.yaml    per-product error taxonomy and tenants
│
├── apps/corebank/               the legacy target application
│   ├── server.ts                routes, sessions, validation
│   ├── pages.ts                 deliberately hostile HTML
│   ├── seed-data.ts             synthetic members and accounts
│   ├── tenants.ts               three institutions, one vendor product
│   ├── fault-injection.ts       triggerable runtime conditions
│   └── start-servers.ts         boots one instance per tenant
│
├── src/
│   ├── surface/                 ── the seam: how we perceive and act ──
│   │   ├── types.ts                 Surface, ElementNode, Action, Observation
│   │   ├── element-descriptor.ts    how a recorded step names a control
│   │   ├── element-resolver.ts      scored matching; refuses when ambiguous
│   │   ├── element-values.ts        reading values off the screen, typed
│   │   ├── web/
│   │   │   ├── accessibility-tree.ts   perception via CDP AX + geometry
│   │   │   ├── browser-input.ts        clicking and typing by coordinate
│   │   │   └── playwright-surface.ts   the Surface implementation + chokepoint
│   │   └── desktop/README.md        the seam for a desktop surface (design only)
│   │
│   ├── capability/              ── the artifact ──
│   │   ├── schema.ts                Zod schema: the contract
│   │   ├── store.ts                 versioned YAML store
│   │   ├── application-profile.ts   per-product conditions, auth, tenants
│   │   ├── tenant-overrides.ts      JSON-Pointer patches per institution
│   │   └── catalog.ts               agent-facing: list / describe / invoke
│   │
│   ├── discovery/               ── the model runs here, and only here ──
│   │   ├── loop.ts                  observe → decide → act
│   │   ├── model-prompt.ts          what the model sees and may say back
│   │   ├── trace-compiler.ts        trace → capability (deterministic)
│   │   └── llm/
│   │       ├── llm-provider.ts                the provider interface
│   │       ├── provider-registry.ts           which providers exist, and picking one
│   │       ├── openai-compatible-provider.ts  Groq, OpenAI, anything OpenAI-shaped
│   │       └── scripted-provider.ts           offline fixture
│   │
│   ├── replay/                  ── the production path, no model ──
│   │   ├── executor.ts              the step loop
│   │   ├── checkpoints.ts           predicate and checkpoint evaluation
│   │   ├── replay-result.ts         the four-arm result contract + classifier
│   │   └── recovery.ts              the closed set of recovery handlers
│   │
│   ├── policy/
│   │   ├── guardrails.ts            allowlist + risk classification
│   │   └── redaction.ts             secrets and PII, at the write boundary
│   │
│   ├── escalation/
│   │   ├── control-authority.ts     the control-transfer state machine
│   │   ├── intervention-broker.ts   routing a stuck run to a human
│   │   └── operator/                the operator console (server + UI)
│   │
│   ├── observability/run-recorder.ts   structured logs, screenshots, snapshots
│   └── cli/                     command-line entry point and run reports
│
├── scripts/
│   ├── capture-evidence.ts      regenerates evidence/ reproducibly
│   ├── demo-human-handoff.ts    scripted end-to-end handoff
│   ├── inspect-screen.ts        dev tool: what does perception see?
│   └── inspect-locators.ts      dev tool: how did the resolver score?
│
└── tests/
```

**Two files repay reading first:**
[`config/apps/corebank-servicing.yaml`](config/apps/corebank-servicing.yaml) is
the error taxonomy, and
[`capabilities/lookup_member_savings_balance@1.0.0.yaml`](capabilities/lookup_member_savings_balance@1.0.0.yaml)
is what a reviewed capability looks like.

---

## 8. Concepts and vocabulary

| Term | What it means here |
|---|---|
| **Surface** | Anything that can be perceived and acted on — a browser page, and by design a desktop window. The one abstraction everything else is written against. |
| **Observation** | A single, internally consistent snapshot of a surface: every perceivable element, plus page signals and optionally a screenshot. |
| **ElementNode** | One perceivable control: role, accessible name, value, states, bounds, frame path, and surrounding context. |
| **Accessible name** | What a screen reader would announce for a control. Usually what a human would call it. Frequently **empty** on legacy text inputs. |
| **Proximate label** | The caption physically beside an unnamed control, recovered from geometry. The identity of a legacy input. |
| **ElementDescriptor** | How a recorded step describes the control it means, using several independent signals. Persisted in the artifact. |
| **Capability** | A typed, versioned, reviewable artifact describing a reusable flow — inputs, outputs, steps, checkpoints, and declared outcomes. |
| **Checkpoint** | A condition asserted to confirm you actually reached the expected state, rather than assuming a click worked. |
| **Business outcome** | A legitimate non-success answer the caller needs — "no such member", "access denied". **Not** a failure. |
| **Condition** | A rule matching a runtime state to a response: business outcome, bounded recovery, or fatal. Authored per product. |
| **Drift signal** | Emitted when a locator resolved successfully, but not by the signal it was recorded with. The earliest warning a tenant has changed. |
| **Tenant** | One customer institution. Many run the same vendor product, configured differently. |
| **Control token** | The capability that permits acting on a session. Rotated on every transfer, so a stale copy is useless. |
| **Resume contract** | What must be true before automation may take back control after a human intervention. |
| **Intervention** | A request for a human, carrying enough context to act on without reading the code. |

---

## 9. Testing

```bash
npm test              # 95 tests
npm run typecheck     # strict TypeScript, no emit
```

| Suite | What it protects |
|---|---|
| `tests/element-resolver.test.ts` | scoring order, refusal on ambiguity, unnamed-input recovery, column-reorder tolerance, and that a data cell's own value never becomes its identity |
| `tests/error-taxonomy.test.ts` | classification order (business before recoverable before fatal), and that the ordering is data rather than code |
| `tests/safety.test.ts` | redaction, allowlist containment, the discovery/replay asymmetry, and every control-transfer transition |
| `tests/capability.test.ts` | schema round-trip, override resolution and re-validation, value transforms, catalog projection |
| `tests/replay.e2e.test.ts` | a real browser through **every arm** of the result contract, all injected faults, and both other tenants |

The end-to-end suite starts the target application itself if one is not already
running, so `npm test` works from a clean checkout.

---

## 10. Development tools

```bash
# What does perception actually see on this screen?
npx tsx scripts/inspect-screen.ts http://localhost:4000/member/10001 --login
```
```
--- INTERACTIVE ---
e11   textbox    name=""    labels=["Operator ID"]  frame=main  (96,66 170x13)
--- TABLE CELLS ---
e17   cell   text="$8,412.55"  col="Current Balance"  row=["4820117735","Savings",...]
```

```bash
# Why did the resolver not find that? Shows the full candidate ranking.
npx tsx scripts/inspect-locators.ts
```
```
--- output "savingsBalance": unnamed cell, under the "Current Balance" column, in the row containing "Savings"
    1.000  cell  name="$8,412.55"   col="Current Balance"  matched=[role,anchor:underColumn,anchor:inRowWith]
    0.667  cell  name="Savings"     col="Type"             matched=[role,anchor:inRowWith]
    => RESOLVED "$8,412.55" via anchor:underColumn
```

These are the two tools to reach for when a replay reports "could not find X".

---

## 11. Troubleshooting

**`429 insufficient_quota` during discovery**
The key is valid but the account has no credit. This is a billing state, not a
rate limit, so retrying will not help — add credit, or switch to Groq's free tier
by setting `GROQ_API_KEY`. Use `--provider scripted` meanwhile.

**`429 rate_limit_exceeded` during discovery**
Genuinely a rate limit, common on free tiers. The provider already retries with
exponential backoff (1s, 2s, 4s); if it still fails, wait a minute or set a
smaller model in `GROQ_MODEL`.

**`401` / `403` during discovery**
The key itself was rejected. Check `GROQ_API_KEY` (or `OPENAI_API_KEY`) in `.env`
for a typo or a revoked key. Groq keys are managed at
<https://console.groq.com/keys>.

**`404` — "model is not available"**
The account cannot reach the configured model. Set `GROQ_MODEL` to one it can:
`curl -H "Authorization: Bearer $GROQ_API_KEY" https://api.groq.com/openai/v1/models`
lists them. It must support tool calling.

**"model answered in prose instead of calling a tool"**
Open-weight models do this occasionally despite `tool_choice: required`. The
provider nudges and retries up to three times; seeing this error means it refused
all three. Usually a larger model fixes it — `openai/gpt-oss-120b` rather than
`-20b`.

**`Executable doesn't exist at ...chrome-headless-shell`**
Playwright's browser build does not match the installed package. Run
`npx playwright install chromium`.

**`EADDRINUSE` on ports 4000–4002 or 4100**
A previous `npm run app` or operator console is still running. Stop it, or free
the ports with `npx kill-port 4000 4001 4002 4100`.

**Replay fails at the authentication precondition**
`COREBANK_OPERATOR` / `COREBANK_PASSWORD` are missing from `.env`. Copy
`.env.example` again. Capabilities deliberately contain no credentials — the
runtime supplies the identity.

**A capability reports `AMBIGUOUS_TARGET`**
Working as designed: two controls matched too closely and the system refused to
guess. Run `npx tsx scripts/inspect-locators.ts` to see the ranking, then make the
descriptor more specific — usually by adding an anchor or a `scope.container`.

**`npm run evidence` says it used the scripted fixture**
Either no provider key was visible to the process, or the live attempt did not
succeed. It prints the reason, and repeats it in the banner at the top of
`evidence/README.md`. Fix that cause and re-run — see
[section 4](#4-capturing-a-live-discovery-run).

---

## 12. Design write-up

**[REPORT.md](REPORT.md)** covers the reasoning behind all of this: the
architecture and its trade-offs, why the artifact schema is shaped the way it is,
how determinism is achieved and how runtime errors are classified, how the design
extends to legacy-desktop surfaces and to hundreds of institutions, the escalation
and control-transfer model, the guardrails and their limits, and what was
deliberately cut and what would come next.

It also documents the three bugs that took the most work to find — including one
where Chromium's accessibility tree lags the DOM after a navigation, which
produced an intermittent failure roughly one run in three and was never
reproducible on inspection.

---

## Ground rules honoured

- **No real credentials and no real PII.** The target application is local and
  its data is invented. Its demo credentials are printed on its own sign-on page.
- **No secrets in the repository.** `.env` is gitignored; the product profile
  names the environment variables holding credentials rather than the values.
- **The automation cannot reach its own test hooks.** `/_admin/**` is on the
  policy deny list, so faults can be armed by the harness and never by the agent.
