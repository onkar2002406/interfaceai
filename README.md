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

---

## Quick start

```bash
npm install
npx playwright install chromium
cp .env.example .env      # a model key is optional; only discovery needs one
```

Two terminals:

```bash
npm run app               # terminal 1 — the target application (ports 4000-4002)
npm run panel             # terminal 2 — the control panel at localhost:4200
```

The panel is the fastest way to see what this does. Everything in it is also a
CLI command:

```bash
npm run replay -- --capability lookup_member_savings_balance --input memberId=10001
```

```
SUCCESS lookup_member_savings_balance@1.0.0 [base] in 1864ms
Outputs: { "savingsBalance": 8412.55, "savingsAccountNumber": "4820117735" }
```

No model was involved in that run.

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

Discovery needs a model key (`GROQ_API_KEY` — free tier — or `OPENAI_API_KEY`):

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

## The target application

Three instances of the same vendor product, configured as three institutions:

| URL | Institution | Version | Operator | How it differs |
|---|---|---|---|---|
| :4000 | CoreBank Reference Install | 8.2 | `svc.demo` | the baseline |
| :4001 | First Valley Credit Union | 8.2 | `svc.fvcu` | two controls relabelled |
| :4002 | Harbor Credit Union | 9.0 | `svc.harbor` | reordered accounts table, mandatory privacy screen |

Each install has its own staff directory, so an operator valid at one is rejected
at the next. A capability carries no credentials — it declares that it needs a
session, and the runtime resolves *whose* from the tenant's `credentialEnv` names.
Passwords live in `.env` and are printed nowhere in the application.

| Member | What happens |
|---|---|
| `10001` `10002` `10003` `10004` | normal records |
| `10007` | restricted → `PERMISSION_DENIED` |
| `99999` | absent → `MEMBER_NOT_FOUND` |

**Funds Transfer never posts, on purpose.** It is the one maximally irreversible
act in the app, and it exists so the policy layer has something real to refuse:
`FUNDS_TRANSFER` in [`config/policy.json`](config/policy.json) stops the
automation at the button. The server refuses the POST too, and says so plainly
rather than showing a generic error. **Open Sub-Account** is the fully working
irreversible flow, and the one the safety machinery is demonstrated against.

---

## Layout

```
apps/corebank/          the target application (the thing being automated)
capabilities/           saved capability artifacts (YAML)
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
  panel/                web control panel
  observability/        structured run evidence
  cli/                  command-line entry point
```

Two files repay reading first:
[`config/apps/corebank-servicing.yaml`](config/apps/corebank-servicing.yaml) (a
product's condition taxonomy) and
[`capabilities/lookup_member_savings_balance@1.0.0.yaml`](capabilities/lookup_member_savings_balance@1.0.0.yaml)
(a worked artifact, hand-authored so the schema is provably human-writable).

---

## Testing

```bash
npm test        # 96 tests; the e2e suite drives a real browser
npm run typecheck
```

The end-to-end suite covers every arm of the result contract, each injected
runtime condition, both safety gates, and cross-tenant reuse.

Dev tools when something will not resolve:

```bash
npx tsx scripts/inspect-screen.ts http://localhost:4000/member/10001 --login
npx tsx scripts/inspect-locators.ts    # the resolver's full candidate ranking
```

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `EADDRINUSE` on 4000-4002, 4100, 4200 | An earlier `npm run app` / `panel` is still up. `npx kill-port 4000 4001 4002 4100 4200` |
| `Executable doesn't exist at ...chrome-headless-shell` | `npx playwright install chromium` |
| Replay fails at the authentication precondition | The tenant's `COREBANK_*` variables are missing from `.env`. Copy `.env.example` again. |
| `AMBIGUOUS_TARGET` | Working as designed — two controls matched too closely and it refused to guess. `npx tsx scripts/inspect-locators.ts`, then add an anchor or `scope.container`. |
| Model answered in prose instead of calling a tool | Open-weight models do this occasionally despite `tool_choice: required`. The provider retries three times; a larger model fixes it. |
| `npm run evidence` says it used the fixture | No provider key was visible, or the live attempt did not succeed. It prints the reason and repeats it in `evidence/README.md`. |
