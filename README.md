# Computer-Use Automation System

Give an AI agent hands inside a legacy application that has no API.

An LLM works out how to accomplish a goal by driving a real UI. The successful
run is compiled into a **typed, versioned capability artifact**. That artifact
then **replays deterministically with no model in the loop** — which is how a
production agent invokes it, cheaply and repeatably.

> The model discovers. The artifact becomes a reusable capability. Deterministic
> replay is how the AI agent invokes it in production.

Design rationale, trade-offs and cut lines are in **[REPORT.md](REPORT.md)**.
Recorded runs are in **[evidence/](evidence/)**.

---

## Setup

Requires Node 20+.

```bash
npm install
npx playwright install chromium

cp .env.example .env      # Windows: copy .env.example .env
```

`.env` needs nothing to run everything except live discovery. To run discovery
against a real model, add:

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
```

**Running without a live model.** Pass `--provider mock` to `discover` and the
whole discovery pipeline runs offline against a scripted fixture — real browser,
real perception, real compilation, no API key and no tokens. It exists so the
pipeline is testable deterministically and so a reviewer without a key can still
run the complete end-to-end thread. It is not a substitute for the real thing:
the committed discovery evidence comes from a live model run.

---

## Demo path

Four terminals-worth of commands; the app needs to stay running.

### 0. Start the target application

```bash
npm run app
```

Three instances of the same fake vendor product, configured as three different
institutions:

| URL | Institution | Version | Difference |
|---|---|---|---|
| http://localhost:4000 | CoreBank Reference Install | 8.2 | the baseline |
| http://localhost:4001 | First Valley Credit Union | 8.2 | relabelled controls |
| http://localhost:4002 | Harbor Credit Union | 9.0 | reordered table, mandatory privacy screen |

It is a deliberately hostile stand-in for a back-office banking app: a real
`<frameset>`, table layouts, `<font>` tags, ASP.NET-style generated ids, no test
IDs, and **no `<label for>`** — so text inputs have an empty accessible name,
exactly as they do in the real thing. Sign on is `svc.demo` / `demo1234`. All
data is synthetic.

### 1. Discovery — an LLM works out the flow

```bash
npm run discover -- \
  --goal "look up member {{memberId}} and read their current savings balance" \
  --param memberId=10001
```

Add `--provider mock` to run it without an API key.

Produces a capability at `capabilities/<name>@1.0.0.yaml` and a full transcript,
screenshots and observations under `evidence/discovery-<id>/`. The capability
lands as `approval: draft` — compilation never approves anything; a human reads
the file and decides.

### 2. Replay — deterministic, no model involved

```bash
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001
```

```
SUCCESS lookup_member_savings_balance@1.0.0 [base] in 3491ms
Outputs: { "savingsBalance": 8412.55, "savingsAccountNumber": "4820117735" }
```

### 3. Replay hitting each arm of the result contract

```bash
# a legitimate answer, not a crash
npm run replay -- --capability lookup_member_savings_balance --input memberId=99999
#   BUSINESS_OUTCOME MEMBER_NOT_FOUND

# a restricted record
npm run replay -- --capability lookup_member_savings_balance --input memberId=10007
#   BUSINESS_OUTCOME PERMISSION_DENIED

# malformed input — rejected before a browser even starts
npm run replay -- --capability lookup_member_savings_balance --input memberId=abc
#   Invalid inputs: "memberId" must match /^[0-9]{1,9}$/

# an injected application error — diagnosed, not reported as a timeout
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001 --fault app_error
#   FAILED surface_error at s3 — observed "Unexpected System Error"
```

Recoverable conditions, handled without a human:

```bash
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001 --fault interstitial
#   a surprise maintenance overlay appears -> dismiss_dialog -> SUCCESS

npm run replay -- --capability lookup_member_savings_balance --input memberId=10001 --fault session
#   session expires mid-flow -> reauthenticate -> flow restarts -> SUCCESS

npm run replay -- --capability lookup_member_savings_balance --input memberId=10001 --fault slow
#   a 6s stall, absorbed by checkpoint polling -> SUCCESS
```

### 4. The same artifact across three institutions

```bash
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001 --tenant firstvalley
#   SUCCESS via 2 overrides, plus 1 drift signal for a control that
#   resolved structurally rather than by name

npm run replay -- --capability lookup_member_savings_balance --input memberId=10001 --tenant harborcu
#   SUCCESS with ZERO overrides, despite a version bump, a reordered
#   accounts table, and a mandatory compliance screen
```

### 5. Human-in-the-loop handoff

`open_sub_account` ends in an irreversible step. Invoked without authorisation,
replay parks instead of committing:

```bash
npm run replay -- --capability open_sub_account \
  --input memberId=10001 --input accountType=Savings \
  --input initialDeposit=100.00 --input "nickname=Holiday Fund"
#   ESCALATED (unattended) at s9 — irreversible step requires authorisation
```

To take control of the live session as a human:

```bash
npm run replay -- --capability open_sub_account \
  --input memberId=10001 --input accountType=Savings \
  --input initialDeposit=100.00 --input "nickname=Holiday Fund" --operator
```

Open http://localhost:4100. You get the intervention with its context, a live
view of the stuck session, **Take control**, and the actual page to click on.
Press **Submit Application** yourself, then **Hand control back** — automation
re-verifies its resume contract and finishes the run.

A scripted end-to-end version of that whole exchange, for reproducible evidence:

```bash
npx tsx scripts/demo-handoff.ts
```

It simulates only the *person*. The console, the screencast, the input path, the
token checks and the resume verification are all the real ones.

With explicit authorisation, the same flow runs unattended:

```bash
npm run replay -- --capability open_sub_account \
  --input memberId=10001 --input accountType=Savings \
  --input initialDeposit=100.00 --input "nickname=Holiday Fund" \
  --authorize-irreversible
```

### 6. The agent-facing capability catalog

```bash
npm run catalog -- list        # what an agent can discover
npm run catalog -- tools       # the same, as function-calling tool definitions
npm run catalog -- describe lookup_member_savings_balance

npm run catalog -- invoke lookup_member_savings_balance --input memberId=10002
```

```json
{
  "status": "success",
  "capability": "lookup_member_savings_balance@1.0.0",
  "outputs": { "savingsBalance": 250, "savingsAccountNumber": "4820224419" }
}
```

### 7. Tests

```bash
npm test
```

95 tests. The end-to-end suite drives a real browser through every arm of the
result contract, including the injected faults and both other tenants.

---

## How it fits together

```
  goal ──▶ agent/loop ──▶ trace ──▶ agent/compile ──▶ capability .yaml
              │                                            │
              │  (LLM in the loop, once)                   │  (human reviews, approves)
              ▼                                            ▼
        ┌───────────────────────────────────────────────────────┐
        │                    surface/  (the seam)               │
        │  observe() → ElementNode[]      act() → the chokepoint │
        └───────────────────────────────────────────────────────┘
              ▲                    ▲                     ▲
              │                    │                     │
        replay/executor       policy/           escalation/
        (no LLM, ever)     allowlist, risk,   control token,
                             redaction        operator console
```

| Path | What lives there |
|---|---|
| [`src/surface/`](src/surface/) | The seam. `Surface`, `ElementNode`, the descriptor model, the scoring resolver. Nothing outside `web/` knows it is a browser. |
| [`src/capability/`](src/capability/) | The artifact: Zod schema, versioned store, tenant overrides, agent-facing catalog. |
| [`src/agent/`](src/agent/) | Discovery: the observe→decide→act loop, LLM providers, and the compiler that turns a trace into an artifact. |
| [`src/replay/`](src/replay/) | The production path: executor, checkpoints, condition classification, bounded recovery. |
| [`src/policy/`](src/policy/) | Allowlist, risk classification, redaction. |
| [`src/escalation/`](src/escalation/) | Control-transfer state machine, intervention broker, operator console. |
| [`apps/corebank/`](apps/corebank/) | The legacy target application and its fault injection. |
| [`config/`](config/) | The allowlist ([`policy.json`](config/policy.json)) and the product profile ([`corebank-servicing.yaml`](config/apps/corebank-servicing.yaml)). |

Two files repay reading first:
[`config/apps/corebank-servicing.yaml`](config/apps/corebank-servicing.yaml) is
the error taxonomy, authored once per vendor product;
[`capabilities/lookup_member_savings_balance@1.0.0.yaml`](capabilities/lookup_member_savings_balance@1.0.0.yaml)
is what a reviewed capability looks like.

---

## Development utilities

```bash
npx tsx scripts/probe-perception.ts http://localhost:4000/member/10001 --login
```

Dumps what perception sees on a screen — roles, accessible names, recovered
captions, table cell coordinates. This is the tool for "why did the resolver not
find that".

```bash
npx tsx scripts/probe-resolve.ts
```

Runs a capability's descriptors against a live screen and prints the full
candidate ranking with scores.

---

## Ground rules honoured

- No real credentials and no real PII anywhere. The target app is local and its
  data is invented; the demo credentials are printed on its own sign-on page.
- No secrets in the repo — `.env` is gitignored, and the app profile names the
  environment variables holding credentials rather than the values.
- The agent cannot reach the app's own test hooks: `/_admin/**` is on the policy
  deny list, so faults can only be armed by the harness, never by the automation.
