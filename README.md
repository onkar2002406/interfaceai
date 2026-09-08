# Computer-Use Automation System

Teach an agent a back-office flow **once** with an LLM; replay it **forever**
without one.

A model drives a real UI until it achieves a goal. The successful run is compiled
into a **capability** — a typed, versioned, reviewable contract with inputs,
outputs, and the business outcomes a caller should expect. From then on that
capability replays deterministically, with no model involved, and returns
structured results an AI agent can act on.

The target is a deliberately hostile stand-in for legacy banking software:
`<frameset>`, table layout, generated ASP.NET ids, no test IDs, and no
`<label for>` on any input — so perception cannot lean on the DOM.

**[REPORT.md](REPORT.md)** is the design write-up: why the artifact is shaped the
way it is, how determinism and error classification work, how this extends to
desktop surfaces and hundreds of tenants, and what was cut.

**[ADAPTATION.md](ADAPTATION.md)** is the second write-up: what happened when the
same core was pointed at **MERIDIAN CORE**, a live legacy target it had never
seen. The adapter is two config files; the interesting part is the six bugs the
new target exposed in code that had looked correct for months.

**[CODEBASE.md](CODEBASE.md)** is the reference: every file and every function,
what it does and why it exists, plus the ports map and the on-disk layout.

**[FLOWS.md](FLOWS.md)** is the operator's map: every member and account you can
test with on both targets, a flowchart of each kind of run, exactly what to type
into each panel and what to expect back, what the Discover tab is for, the
guardrails in plain words, and why each loop limit is the number it is.

**[GUARDRAILS-SCHEMAS-MODELS.md](GUARDRAILS-SCHEMAS-MODELS.md)** is the focused
interview note for the safety architecture: every guardrail, the capability
artifact schema, the MongoDB run-store schema, and which models are used where —
with the "why this approach" rationale for each choice.

REPORT.md's later sections answer the deployment questions specifically —
[§8](REPORT.md) on which stretch goals are built, where each one's code lives and
which click on the panel shows it working, and [§9](REPORT.md) on hosting,
scaling to many tenants and many users, what load does to this design, durable
state, and what a discovery run actually costs in tokens.

If you have five minutes and want to know what is where before reading anything,
start at [CODEBASE.md §5.0](CODEBASE.md#50-every-file-in-one-line) — every file in
the repository, one plain-English line each. The sections after it cover
[how the agentic loop is implemented](CODEBASE.md#9-the-agentic-loop-step-by-step),
[the MongoDB schema and the measured size of everything](CODEBASE.md#10-data-model-and-sizes),
and [what breaks first under load](CODEBASE.md#11-load-what-grows-with-what).
[REPORT.md §6](REPORT.md) is the safety chapter: the six guardrails, the two-gate
rule for irreversible actions, and exactly what happens to regulated data on its
way to a disk, a database or a model.

---

## Two targets

The system runs against either product. Which one is a single flag.

| | **CoreBank** (bundled) | **MERIDIAN CORE** (hosted) |
|---|---|---|
| Where | `localhost:4000-4002`, `npm run app` | [web-sample.interface-hiring.com](https://web-sample.interface-hiring.com) |
| Shape | `<frameset>`, generated ASP.NET ids | server-rendered tables, POST-redirect-GET, per-transaction hidden token |
| Profile | `config/apps/corebank-servicing.yaml` | `config/apps/meridian-core.yaml` |
| Interesting because | three tenants of one vendor build | a real, shared, messy surface the core had never seen |

```bash
npm run panel                                                  # CoreBank (default)
npm run panel -- --profile config/apps/meridian-core.yaml      # MERIDIAN CORE
```

A profile names its own policy file, so that one flag also switches the
containment boundary — origins, route allowlist and risk rules travel with the
product rather than being a second thing to remember.

**How MERIDIAN was integrated after CoreBank.** Nothing in the replay engine was
forked. MERIDIAN was added as a second *product profile* plus a second policy
file: [`config/apps/meridian-core.yaml`](config/apps/meridian-core.yaml) names
its auth fields, condition taxonomy, chat audience, fault strategy, identities
and hosted tenant; [`config/policy.meridian.json`](config/policy.meridian.json)
names its allowed origin/routes and irreversible controls. Its capabilities are
ordinary YAML artifacts in [`capabilities/`](capabilities/) whose
`metadata.app.product` is `meridian-core`, and the catalog/panel are scoped by
the active profile so a CoreBank capability is not offered against MERIDIAN or
vice versa. The Docker side is the same split: the `meridian` service starts a
panel and operator console, but no local target app because the target is
hosted.

That is different from CoreBank's **tenants**. CoreBank's `base`,
`firstvalley` and `harborcu` are three institutions running the same vendor
product, under one profile, with different base URLs, labels, table order,
product version, credentials and tenant-only conditions. The same CoreBank
artifact replays across them, with JSON-Pointer `overrides:` only where a tenant
really differs. MERIDIAN is not another CoreBank tenant: it is a different
product with different vocabulary, routes, auth, policy and capability set.
Inside MERIDIAN, `teller` and `supervisor` are **identities**, not tenants — the
same hosted institution answers differently depending on who signed on.

It also switches what the **front door says**. A profile's `chat:` block carries
the audience — who uses this console and the vocabulary they use — and the
openers the chat pane offers before anyone types. So the CoreBank panel suggests
*"What is the savings balance for member 10001?"* against real seeded members,
and the MERIDIAN panel suggests *"What is the balance of share 103001-MMKT-11 for
member 103001?"*, with identifiers that exist on that product. The same sentence
also goes into the model's system prompt, so it is not told it is answering for a
console it is not pointed at. Both sets are chosen to walk the four arms of the
result contract: a success, a not-found, an entitlement refusal, and an
irreversible action stopping for a human.

### MERIDIAN CORE demo path

```bash
cp .env.example .env      # MERIDIAN_* are the app's own public demo operators
npm run panel -- --profile config/apps/meridian-core.yaml
```

Open `localhost:4200`, go to **Chat**, and ask:

> what is the balance of share 103001-MMKT-4 for member 103001?

Then ask for something irreversible:

> transfer $1.00 from share 103001-MMKT-11 to share 103001-MMKT-10 for member 103001, memo "rent"

The transfer drives the whole flow — member lookup, both share dropdowns, the
amount, Continue — reaches the `CONFIRM FUNDS TRANSFER` screen, and then stops at
`Post Transfer` and escalates. The modal opens on the parked session. Nothing was
committed, and no phrasing makes it commit: authorising an irreversible action is
an HTTP header the capability API reads, and the chat composes bodies.

**The seven capabilities**, all recorded against the hosted instance:

| | | |
|---|---|---|
| `sign_on` | read-only | establishes a session; takes no credentials as arguments |
| `member_inquiry` | read-only | find a member by last name |
| `get_balance` | read-only | a share's balance and status |
| `update_member_info` | mutating | set e-mail, phone and mailing address |
| `funds_transfer` | **irreversible** | review → `Post Transfer` |
| `open_new_share` | **irreversible** | review → `Open Share` |
| `place_account_hold` | **irreversible** | supervisor-gated; review → `Apply Hold` |

The same thing without the browser:

```bash
P="--profile config/apps/meridian-core.yaml"

# success — deterministic, no model in the loop
npm run replay -- $P -c get_balance -i memberId=103001 -i shareId=103001-MMKT-4 --identity teller

# a business outcome, not a failure — returns in ~3s, never a checkpoint timeout
npm run replay -- $P -c get_balance -i memberId=999999 -i shareId=x

# rejected before a browser even starts
npm run replay -- $P -c get_balance -i memberId=abc -i shareId=x

# the session dies mid-flow: re-authenticates, restarts the flow, still succeeds
npm run replay -- $P -c get_balance -i memberId=103001 -i shareId=103001-MMKT-4 --fault timeout

# a 503 interstitial replaces the page, and the run asks again
npm run replay -- $P -c get_balance -i memberId=103001 -i shareId=103001-MMKT-4 --fault maintenance

# a hard failure, diagnosed by the app's own ERR- reference rather than timed out
npm run replay -- $P -c get_balance -i memberId=103001 -i shareId=103001-MMKT-4 --fault server

# recorded searching for "Hopper", replayed for "Johnson"
npm run replay -- $P -c member_inquiry -i lastName=Johnson

# drives to Post Transfer and stops for a human, having committed nothing
npm run replay -- $P -c funds_transfer -i memberId=103001 \
  -i fromShare=103001-MMKT-11 -i toShare=103001-MMKT-10 -i amount=1.00 \
  -i memo="rent" --identity teller

# the application declines the OPERATOR, not the request — a business outcome
npm run replay -- $P -c place_account_hold -i memberId=103001 \
  -i shareId=103001-MMKT-10 -i reason=FRAUD -i notes="suspected card fraud" --identity teller

# e-mail, phone and mailing address in one flow
npm run replay -- $P -c update_member_info -i memberId=103001 \
  -i email=verified.member@example.net -i phone=415-555-0196 \
  -i address="130 Demo Street, San Francisco, CA 94104" --identity teller

# a goal against an explicit target URL, checked against the allowlist first
npm run discover -- $P --url https://web-sample.interface-hiring.com/ \
  -g "read the e-mail on file for member {{memberId}}" -p memberId=103001
```

The agent-facing surface, with the panel running:

```bash
curl localhost:4200/api/v1/tools
curl -X POST localhost:4200/api/v1/invoke -H 'content-type: application/json' \
  -d '{"capability":"get_balance","arguments":{"memberId":"103001","shareId":"103001-MMKT-4"}}'
```

`npx tsx scripts/capture-meridian-evidence.ts` regenerates
[`evidence/meridian/`](evidence/meridian/) — every runtime state in the brief's
taxonomy, captured end to end. It reads the member's current shares first and
picks live ones, because the target is shared and stateful: balances move and
other people place holds, so nothing hard-codes a share id.

`npx tsx scripts/probe-target.ts --profile config/apps/meridian-core.yaml /members/103001`
dumps what perception sees on any screen of any configured product. Signing on
through it is a genuine smoke test of a new adapter.

On **Git Bash**, prefix that with `MSYS_NO_PATHCONV=1`. The shell otherwise
rewrites a leading-slash path into a Windows one — `/members/103001` becomes
`C:/Program Files/Git/members/103001` — and the probe falls back to the entry
point, reporting a healthy-looking result for a page you did not ask for.
PowerShell and cmd need no prefix.

---

## Quick start

```bash
npm install
npx playwright install chromium
cp .env.example .env      # a model key is optional; only discovery needs one
```

(Or skip all three and run [everything in Docker](#running-it-in-docker) —
`docker compose up --build`.)

Two terminals:

```bash
npm run app               # terminal 1 — the target application (ports 4000-4002)
npm run panel             # terminal 2 — the control panel at localhost:4200
```

`npm run panel` builds the React front end first (`vite build`, about two
seconds) and then starts the server. To iterate on the interface itself, run
`npm run dev:ui` alongside it for hot reload on `localhost:5173`, proxied to the
panel.

Then open **`localhost:4200`** and stay there. The whole system is driven from
that page:

| Tab | What you do there |
|---|---|
| **Chat** | Ask for something in plain language. The system calls a recorded capability if one fits and starts the live discovery agent if none does — and the run's real steps stream inside the message as it happens. |
| **Replay** | Invoke any capability: pick the institution, fill the typed inputs, optionally inject a runtime fault or authorise an irreversible step. No model involved. |
| **Discover** | Type a goal and, if you want, a target URL. A model drives the real browser until it is done, the run streams live, and the compiled artifact comes back as a card you can **Approve**. |
| **Run history** | Every run this process has launched, whichever door it came in by — chat, API or form. |
| **Evidence** | Every run's structured log, screenshots and result contract, curated set separated from ad-hoc ones. |
| **Guardrails** | The live policy — origins, routes, action types, risk rules — read from the same object the engine enforces. |
| **Agent view** | The same capabilities as function-calling definitions, as a calling agent would receive them. |

When a run stops for a human, an **escalation modal opens over the conversation**
with the parked browser session live in it: watch it, take control, act on the
same session, hand it back. The standalone **operator console** on
`localhost:4100` is the same broker and the same session behind a different door.

Code path for that handoff:

1. Replay calls `Surface.act()` for every step. If policy refuses an
   irreversible step, or a target/checkpoint cannot be recovered, the executor's
   `escalateStep()` in [`src/replay/executor.ts`](src/replay/executor.ts)
   creates an `InterventionRequest` with the capability, step intent, reason,
   redacted params and the resume checkpoint.
2. Before raising it, `captureFailureEvidence()` asks the surface for
   `observe({ screenshot: true })`. The Playwright surface masks PII elements in
   the page, takes the screenshot, restores the page, and `RunRecorder` writes
   `escalation-<step>.png` plus an accessibility snapshot beside `events.jsonl`.
3. `InterventionBroker.raise()` cedes control through
   [`ControlAuthority`](src/escalation/control-authority.ts). Automation's token
   is rotated away before the request is visible, so the executor cannot click
   while a human is driving.
4. The operator console and the chat modal both mount
   [`operator/intervention-api.ts`](src/escalation/operator/intervention-api.ts):
   HTTP routes list/claim/hand back interventions, and a WebSocket streams CDP
   screencast frames from the same Chromium page.
5. Watching needs no token. Mouse/keyboard input does: the console claims the
   intervention, receives the current human token, and `dispatchHumanInput()`
   forwards CDP input only while that token is valid. On hand-back, the executor
   re-observes the page and verifies the resume checkpoint before automation gets
   a fresh token.

The original single-file panel is still served at **`/legacy`**. It needs no
build step and no `node_modules`, so it works when the bundle does not.

Everything on that page is also a CLI command, and both go through the identical
code path:

```bash
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001
```

```
SUCCESS lookup_member_savings_balance@1.0.0 [base] in 1864ms
Outputs: { "savingsBalance": 8412.55, "savingsAccountNumber": "4820117735" }
```

No model was involved in that run.

---

## Running it in Docker

The same stack with nothing installed but Docker — no Node, no
`playwright install`, no local MongoDB. [DOCKER.md](DOCKER.md) is the full guide;
this is the whole of it in one command.

```bash
cp .env.example .env      # a model key is still optional
docker compose up --build
```

That brings up **MongoDB, a MongoDB browser UI, both targets' worth of services,
and both panels**:

| | |
|---|---|
| `localhost:4200` | **CoreBank control panel** — start here |
| `localhost:4300` | **MERIDIAN control panel** |
| `localhost:4000-4002` | the three CoreBank institutions |
| `localhost:4100` / `:4101` | the two standalone operator consoles |
| `localhost:27017` | MongoDB |
| `localhost:8081` | Mongo Express UI for browsing MongoDB collections |

Three files do it:

| File | What it is |
|---|---|
| [`Dockerfile`](Dockerfile) | Built on `mcr.microsoft.com/playwright:v1.62.1-jammy`, so the Chromium the surface driver needs is present and version-locked to the `playwright` in `package.json`. It installs dependencies, pre-builds the React panel, then runs `npm run typecheck && npm test` — **a red tree cannot produce an image**, and the e2e suite has ports 4000-4002 to itself at that moment, which it would not have in a running container. |
| [`docker-compose.yml`](docker-compose.yml) | `mongo`, `mongo-express`, and two app services built from that one image. |
| [`docker/start.sh`](docker/start.sh) | The entrypoint. `corebank` mode starts the three tenant instances, waits for the reference install to answer, then brings up the panel and its operator console. `meridian` mode starts the panel alone — that target is hosted, so there is nothing local to run. |

Either half on its own, with MongoDB pulled in by `depends_on`:

```bash
docker compose up --build corebank    # CoreBank instances + panel + console
docker compose up --build meridian    # MERIDIAN panel + console
docker compose up -d mongo mongo-express  # the run store and browser UI
```

**MongoDB is optional and the system says which it got.** Unset, the run
registry, escalation queue and irreversible-authorisation audit stay in memory
and die with the process; set, they survive a restart. `GET /api/health` reports
`"runStore": "mongodb"` or `"memory"`, so it is never a guess. Compose points the
app services at the `mongo` service over the container network, overriding
whatever `.env` says.

Every CLI verb works inside a container:

```bash
docker compose exec corebank node_modules/.bin/tsx src/cli/index.ts \
  replay -c lookup_member_savings_balance -i memberId=10001 --tenant harborcu
```

`docker compose down` stops it; `down -v` also discards the run store. Headful
mode is host-only — there is no display in the container, so `--headful` and
`HEADFUL=1` do nothing there. Screenshots are recorded as evidence either way.

If a port is already taken — a native `npm run app` still running, or a
standalone `mongo` container from an earlier `docker run` — see
[DOCKER.md](DOCKER.md#port-collisions).

---

## Things worth trying

Keep `npm run app` running. Each command below is one line in the panel too.

| Try this | What it shows |
|---|---|
| `npm run replay -- -c lookup_member_savings_balance -i memberId=10001` | success, typed outputs |
| `... -i memberId=99999` | `MEMBER_NOT_FOUND` — a business outcome, not a failure |
| `... -i memberId=10007` | `PERMISSION_DENIED` — restricted record |
| `... -i memberId=abc` | rejected before a browser starts |
| `... -i memberId=10001 --fault app_error` | hard failure, diagnosed as `surface_error` at `s3` — not a timeout |
| `... -i memberId=10001 --fault interstitial` | surprise dialog dismissed, run continues |
| `... -i memberId=10001 --fault session` | session expires mid-flow, re-authenticates, restarts |
| `... -i memberId=10001 --tenant harborcu` | same artifact, different institution, **zero overrides** |
| `npm run replay -- -c open_sub_account -i memberId=10001 -i accountType=Savings -i initialDeposit=250.00 -i nickname=Holiday` | stops at the irreversible step and escalates |
| `... --authorize-irreversible` | performs it, returns the new account number |
| `npm run handoff` | full human takeover of a live session |
| `npm run catalog -- tools` | the capability as an agent function-calling definition |

Discovery needs a model key. Set `GROQ_API_KEY` (free tier), `OPENAI_API_KEY`, or
both — with both, Groq is tried first and **OpenAI becomes an automatic
fallback**. That matters in practice: Groq's free tier allows 8,000 tokens per
minute and one discovery run spends 7k–31k, so a run can take a 429 partway
through. It now moves onto the second key and finishes, printing the switch and
recording a `model_provider_switched` event in the run's evidence rather than
failing silently onto a paid key. `--provider groq` pins one provider and turns
the fallback off.

The Discover tab is the same thing with a textarea:

```bash
npm run discover -- --goal "look up member {{memberId}} and read their current savings balance" \
                    --param memberId=10001
```

`--provider scripted` swaps the model for a fixture so the pipeline runs with no
key. The browser, perception, compiler and evidence are all real; only the
decision-maker is substituted. It refuses to guess on a screen it was not taught,
so it is a fixture, not a general offline mode.

`npm run evidence` regenerates every recorded run in [`evidence/`](evidence/),
discovery included. Stop `npm run app` first — it starts its own instances, and
a stray browser tab can consume an injected fault and corrupt a scenario.

---

## The bundled target application

CoreBank: three instances of the same vendor product, configured as three
institutions. (MERIDIAN CORE is described in [ADAPTATION.md](ADAPTATION.md).)

| URL | Institution | Version | Operator | Password | How it differs |
|---|---|---|---|---|---|
| :4000 | CoreBank Reference Install | 8.2 | `svc.demo` | `demo1234` | the baseline |
| :4001 | First Valley Credit Union | 8.2 | `svc.fvcu` | `valley4321` | two controls relabelled |
| :4002 | Harbor Credit Union | 9.0 | `svc.harbor` | `harbor8765` | reordered accounts table, mandatory privacy screen |

Each install has its own staff directory, so an operator valid at one is rejected
at the next. A capability carries no credentials — it declares that it needs a
session, and the runtime resolves *whose* from the tenant's `credentialEnv` names.
Passwords live in `.env` and are printed nowhere in the application.

**How the dummy banks are made.** [`apps/corebank/start-servers.ts`](apps/corebank/start-servers.ts)
starts the same Express app three times, once per tenant id, on ports 4000, 4001
and 4002. [`apps/corebank/tenants.ts`](apps/corebank/tenants.ts) is the tenant
matrix: institution name, product version, accent colour, staff credentials,
screen labels, accounts-table column order and whether a privacy interstitial
appears. [`apps/corebank/pages.ts`](apps/corebank/pages.ts) renders those knobs
into old-fashioned table/frame HTML. The routes in
[`apps/corebank/server.ts`](apps/corebank/server.ts) are intentionally identical
for all three; only the tenant config changes, which is why it exercises
record-once/replay-many instead of becoming three separate apps.

The three CoreBank tenants differ like this:

| Tenant | Port | Version | UI/config differences | Why it exists |
|---|---:|---|---|---|
| `base` | 4000 | 8.2 | Reference labels: `Member Search`, `Member ID`, `Search`, `Accounts`, `Open Sub-Account`; standard account-table order `number → type → balance → status → openedOn`; no privacy interstitial. | The recording baseline and the simplest happy path. |
| `firstvalley` | 4001 | 8.2 | Same product version and table order, but several labels are changed: `Member Search` → `Find Member`, `Member ID` → `Member Number`, `Search` → `Go`, `Accounts` → `Share Accounts`; no privacy interstitial. | Proves tenant-specific relabels are small JSON-Pointer overrides, not a new recording. |
| `harborcu` | 4002 | 9.0 | Newer build, green branding, `Open Sub-Account` → `New Sub-Account`, account table reordered to `type → number → balance → status → openedOn`, and a mandatory privacy acknowledgement before member detail. | Proves robust locators and tenant conditions absorb bigger drift with zero capability forks. |

All three have their own dummy operator/password pair and their own base URL, but
they share the same in-memory member data. That is deliberate: the fixture is
testing UI/product variation, not ledger isolation.

The seeded members, from [`apps/corebank/seed-data.ts`](apps/corebank/seed-data.ts).
All synthetic — account numbers are shaped like real ones so the redaction
patterns get exercised, but they belong to nobody.

| Member | Name | Accounts | What happens |
|---|---|---|---|
| `10001` | Dana Whitfield | Savings `4820117735` $8,412.55 · Checking `4820117736` $1,290.04 | the worked example throughout |
| `10002` | Marcus Oyelaran | Savings `4820224419` $250.00 · Certificate `4820224420` $15,000.00 | normal |
| `10003` | Priya Ramanathan | Savings `4820331188` $63,207.19 | normal |
| `10004` | Tomas Kereszti | Checking `4820447701` $42.13 · Savings `4820447702` $0.00 (Dormant) | normal |
| `10007` | Eleanor Voss | Savings `4820770001` | restricted → `PERMISSION_DENIED` |
| `99999` | — | — | absent → `MEMBER_NOT_FOUND` |

Each member also carries an e-mail, phone and mailing address, which are the
fields the `update_member_details` capability writes. The full table, and the
same for MERIDIAN, is in [FLOWS.md §2](FLOWS.md#2-test-data-you-can-use).

The data is deliberately in memory. `MEMBERS` is the seed array; `updateMember()`
writes contact details back onto that array; `openSubAccount()` appends a new
account to the member and records an audit-style row in `OPENED_SUBACCOUNTS`.
Those mutations last until the process restarts or the harness-only
`/_admin/reset` route calls `resetData()`. That admin route is on the policy deny
list, so the automation cannot reset its own fixtures or arm its own faults.
The three tenant instances share the same seed array by design: the target is a
test fixture for UI variation, not three real core ledgers.

Only a **savings** lookup is recorded as a capability. Asking the chat for a
*checking* balance is therefore a genuine gap, not a bug — it will start a
discovery run rather than answer, which is the correct behaviour and a good thing
to watch happen.

MERIDIAN CORE's demo data is different: member `103001`, shares
`103001-MMKT-4`, `-10` and `-11`, and two operator identities `teller1` and
`super1` (both password `password`, printed by the app on its own sign-on page).

**Three screens do real work, and they are graded.** *Update Member Details*
writes to the member record and is classified `mutating` — the previous values
are on the form and can be typed back, so it replays unattended. *Open
Sub-Account* creates a record that cannot be un-created, is classified
`irreversible`, and stops for a human unless the caller both approved the
artifact and authorised the invocation. That grading is the point of having three
risk classes rather than two.

Both doors write to the same store: edit a member at
`http://localhost:4000/member/10001/update` by hand, or run
`update_member_details`, and the other sees the change immediately. An automation
that wrote somewhere the website could not read would prove nothing about driving
a real console.

A funds-transfer screen used to exist here and has been **removed**. It never
posted — the server refused it with a 403 by design — so it was a guardrail
demonstration pointed at a dead end, and the `FUNDS_TRANSFER` policy rule that
guarded it turned out never to fire anyway (it keyed on a route, and this product
is a `<frameset>`; see [REPORT.md §6](REPORT.md)). MERIDIAN has a transfer that
genuinely posts, and that is where the irreversible-transfer story is told.

---

## Layout

```
apps/corebank/          the target application (the thing being automated)
capabilities/           saved capability artifacts (YAML)
Dockerfile              the app image; docker/start.sh is its entrypoint
docker-compose.yml      MongoDB + both panels + the three CoreBank instances
config/
  apps/*.yaml           per-product profile: condition taxonomy, auth, tenants
  policy.json           allowlist, action types, risk rules
evidence/               committed run evidence, regenerated by `npm run evidence`
src/
  surface/              perceive/act seam — the port to another surface kind
    web/                accessibility tree + CDP input
    desktop/README.md   the desktop mapping (design only)
  discovery/            the LLM loop, providers, and the trace compiler
  capability/           schema, store, tenant overrides, agent-facing catalog
  replay/               the production path: executor, checkpoints, recovery
  policy/               guardrails and redaction
  escalation/           control transfer, intervention broker, operator console
  api/                  agent-facing capability API + the chat front door
  panel/                the panel server; `ui-dist/` is the built front end
  observability/        structured run evidence
  cli/                  command-line entry point
ui/                     React front end (Vite) — chat, replay, discover, evidence
```

Two files repay reading first:
[`config/apps/corebank-servicing.yaml`](config/apps/corebank-servicing.yaml) (a
product's condition taxonomy) and
[`capabilities/lookup_member_savings_balance@1.0.0.yaml`](capabilities/lookup_member_savings_balance@1.0.0.yaml)
(a worked artifact, hand-authored so the schema is provably human-writable).

---

## Testing

```bash
npm test        # 167 tests; the e2e suite drives a real browser
npm run typecheck   # the engine and the React app
```

Run `npm test` **before** `npm run app` — the e2e file starts its own copy of the
target application on the same ports.

The end-to-end suite covers every arm of the result contract, each injected
runtime condition, both safety gates, and cross-tenant reuse.
[`tests/front-door.test.ts`](tests/front-door.test.ts) covers the surfaces a
person actually touches: that a caller-supplied target URL cannot move a run off
the allowlist, that the chat stream reports a run before it finishes, that the
discovery fallback cannot reach an irreversible action, and that an un-claimed
operator cannot drive a parked session.

Dev tools when something will not resolve:

```bash
npx tsx scripts/inspect-screen.ts http://localhost:4000/member/10001 --login
npx tsx scripts/inspect-locators.ts    # the resolver's full candidate ranking
```

The PDFs beside these documents are build artifacts, not hand exports —
`npm run pdf CODEBASE.md` regenerates one through the Chromium Playwright already
installs. Close the PDF in any viewer first, or it writes `<doc>.new.pdf` and
exits non-zero rather than failing halfway.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `EADDRINUSE` on 4000-4002, 4100, 4200 | An earlier `npm run app` / `panel` is still up. `npx kill-port 4000 4001 4002 4100 4200` |
| `port is already allocated` from `docker compose up` | The same clash from the other direction — a native run, or a leftover `mongo` container, holds a port Compose wants. [DOCKER.md](DOCKER.md#port-collisions). Run the Docker stack or the native one, not both. |
| `Executable doesn't exist at ...chrome-headless-shell` | `npx playwright install chromium` |
| Replay fails at the authentication precondition | The tenant's `COREBANK_*` variables are missing from `.env`. Copy `.env.example` again. |
| `AMBIGUOUS_TARGET` | Working as designed — two controls matched too closely and it refused to guess. `npx tsx scripts/inspect-locators.ts`, then add an anchor or `scope.container`. |
| Model answered in prose instead of calling a tool | Open-weight models do this occasionally despite `tool_choice: required`. The provider retries three times; a larger model fixes it. |
| `npm run evidence` says it used the fixture | No provider key was visible, or the live attempt did not succeed. It prints the reason and repeats it in `evidence/README.md`. |
