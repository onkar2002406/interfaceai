# Evidence

> [!IMPORTANT]
> **The discovery run below was produced by the offline scripted fixture, not a live model.**
> `OPENAI_API_KEY` was not set when this evidence was captured.
>
> Set the key in `.env` and re-run `npm run evidence` to replace it with a real
> LLM-driven run before this repository is submitted. The compiled capability
> `capabilities/discovered_member_savings@1.0.0.yaml` should be regenerated at the
> same time — its `provenance.model` field records which produced it.

Recorded runs against the local target application. Regenerate with:

```bash
npm run app        # in one terminal
npm run evidence   # in another — everything except the handoff run
npm run handoff    # the human-handoff run
```

Every directory contains:

- `events.jsonl` — the structured event log, one JSON object per line
- `summary.md` — the same run written for a human
- `result.json` — the full machine-readable result
- screenshots and accessibility snapshots for any failure or escalation

Everything written here passes through redaction: secrets are never written,
PII appears as a per-run salted hash, and screenshots have sensitive elements
blacked out *before* capture.

| Run | Outcome | What it shows |
|---|---|---|
| [`discovery-lookup-savings-balance`](discovery-lookup-savings-balance/summary.md) | success in 3 steps via mock:scripted-fixture | The LLM-driven discovery run. compiled discovered_member_savings@1.0.0 (draft). |
| [`replay-success`](replay-success/summary.md) | SUCCESS lookup_member_savings_balance@1.0.0 [base] in 2858ms — outputs: {"savingsBalance":8412.55,"savingsAccountNumber":"4820117735"} | The happy path: three steps, outputs extracted and typed. |
| [`replay-business-outcome-not-found`](replay-business-outcome-not-found/summary.md) | BUSINESS_OUTCOME MEMBER_NOT_FOUND at s3 — No member matches the supplied identifier. This is a complete and correct answer to the question asked — the identifier is wrong or the member does not exist at this institution. | A member that does not exist. Returned as MEMBER_NOT_FOUND — an answer, not a crash. |
| [`replay-business-outcome-permission-denied`](replay-business-outcome-permission-denied/summary.md) | BUSINESS_OUTCOME PERMISSION_DENIED at s3 — The member record is restricted and the signed-on operator lacks the entitlement to view it. A different operator identity may succeed. | A restricted record. PERMISSION_DENIED — a different operator identity might succeed. |
| [`replay-failure-app-error`](replay-failure-app-error/summary.md) | FAILED surface_error at s3 ("Submit the search and land on the member's detail screen.") — expected the member detail screen for the requested member is displayed; observed found "Unexpected System Error" | An injected application error. Reported as surface_error with what was on screen — NOT as a checkpoint timeout. |
| [`replay-recovered-interstitial`](replay-recovered-interstitial/summary.md) | SUCCESS lookup_member_savings_balance@1.0.0 [base] in 2567ms — outputs: {"savingsBalance":8412.55,"savingsAccountNumber":"4820117735"} | A surprise maintenance overlay, dismissed without a human. |
| [`replay-recovered-session-expiry`](replay-recovered-session-expiry/summary.md) | SUCCESS lookup_member_savings_balance@1.0.0 [base] in 3683ms — outputs: {"savingsBalance":8412.55,"savingsAccountNumber":"4820117735"} | The session expires mid-flow. Re-authenticated, then the flow restarts from the entry point because its position was lost. |
| [`replay-recovered-slow-load`](replay-recovered-slow-load/summary.md) | SUCCESS lookup_member_savings_balance@1.0.0 [base] in 8997ms — outputs: {"savingsBalance":8412.55,"savingsAccountNumber":"4820117735"} | A six-second stall, absorbed by checkpoint polling rather than a fixed sleep. |
| [`replay-tenant-firstvalley`](replay-tenant-firstvalley/summary.md) | SUCCESS lookup_member_savings_balance@1.0.0 [firstvalley] in 2673ms — outputs: {"savingsBalance":8412.55,"savingsAccountNumber":"4820117735"} | Relabelled controls. Two overrides carry it; a third difference resolves structurally and reports a drift signal. |
| [`replay-tenant-harborcu`](replay-tenant-harborcu/summary.md) | SUCCESS lookup_member_savings_balance@1.0.0 [harborcu] in 2820ms — outputs: {"savingsBalance":8412.55,"savingsAccountNumber":"4820117735"} | Newer build, reordered accounts table, mandatory privacy screen. ZERO overrides. |
| [`replay-escalation-irreversible-unattended`](replay-escalation-irreversible-unattended/summary.md) | ESCALATED (unattended) at s9 — irreversible step requires an approved artifact and explicit invocation authorisation (IRREVERSIBLE_SUBMIT) | An irreversible step with no authorisation. Parks and escalates; nothing was committed. |
| [`replay-irreversible-authorised`](replay-irreversible-authorised/summary.md) | SUCCESS open_sub_account@1.0.0 [base] in 3249ms — outputs: {"newAccountNumber":"4820990014"} | The same flow with an approved artifact and explicit invocation authorisation. Completes. |
| [`replay-business-outcome-validation`](replay-business-outcome-validation/summary.md) | BUSINESS_OUTCOME VALIDATION_ERROR at s8 — The application rejected the submitted values — most commonly an opening deposit below the institution's $25 minimum, or a nickname longer than 20 characters. Nothing was created; correct the inputs and invoke again. | An opening deposit below the institution minimum. VALIDATION_ERROR — nothing was created. |
| [`replay-human-handoff`](replay-human-handoff/summary.md) | SUCCESS after a human took over | The full handoff: policy stops an irreversible step, an operator views the live session, is **refused** input until they claim control, clicks the real button on the same session, hands back, and the executor re-verifies its resume contract before finishing. |

The human-handoff run is captured by `scripts/demo-handoff.ts`, which stands
in for the *person* only — the console, the screencast, the control tokens and
the resume verification in that run are all the real ones.
