# MERIDIAN CORE — curated evidence

Regenerate with `npx tsx scripts/capture-meridian-evidence.ts`.

Target: https://web-sample.interface-hiring.com (meridian-core v4.2.1)
Captured: 2026-09-06T21:03:19.840Z
Arguments chosen live from member 103001's record (share 103001-MMKT-5).

Every run below is a deterministic replay. No model is in the decision loop.
Each directory holds the step log (`events.jsonl`), the result contract
(`result.json`), what a calling agent received (`agent-result.json`), a
readable summary (`summary.md`), and screenshots where the run captured them.

| Scenario | What it shows |
|---|---|
| [`success-balance`](success-balance/summary.md) | A capability completes and returns typed outputs |
| [`business-member-not-found`](business-member-not-found/summary.md) | MEMBER_NOT_FOUND — an answer the caller asked for |
| [`business-supervisor-required`](business-supervisor-required/summary.md) | SUPERVISOR_OVERRIDE_REQUIRED — an entitlement answer, not an error |
| [`business-validation-rejected`](business-validation-rejected/summary.md) | VALIDATION_ERROR — the application refused the values |
| [`recovered-maintenance`](recovered-maintenance/summary.md) | A maintenance interstitial is cleared and the run carries on |
| [`recovered-session-timeout`](recovered-session-timeout/summary.md) | The session expires mid-flow and the run re-authenticates |
| [`failure-application-error`](failure-application-error/summary.md) | An application error is diagnosed, not timed out |
| [`escalated-irreversible-transfer`](escalated-irreversible-transfer/summary.md) | A funds transfer runs to the posting step and stops for a human |
| [`business-supervisor-gated-hold`](business-supervisor-gated-hold/summary.md) | SUPERVISOR_OVERRIDE_REQUIRED — the application declines the operator, not the request |
| [`success-sign-on`](success-sign-on/summary.md) | Session handling on its own — the precondition every other run depends on |
| [`success-member-inquiry-by-name`](success-member-inquiry-by-name/summary.md) | Member inquiry by last name — selecting a row from a result set |
| [`success-update-member-info`](success-update-member-info/summary.md) | Update Member Information — e-mail, phone and mailing address |
| [`escalated-irreversible-open-share`](escalated-irreversible-open-share/summary.md) | Open New Share — drives to the commit and stops, having created nothing |

## Notes

**success-balance** — Recorded against one member, replayed against another. No model is involved: the descriptors name the balance cell by its column header and the row holding the requested share id.

**business-member-not-found** — Returned in a few hundred milliseconds because classification runs on every poll of the checkpoint wait, so the condition fires long before a deadline that was never going to be met.

**business-supervisor-required** — HTTP 403. Reported as a business outcome because nothing is broken: the application answered the question "may this operator do this?" and the answer was no. A calling agent needs to route the work to someone entitled, which it can only do if it is told an answer rather than handed an exception.

**business-validation-rejected** — HTTP 400. Also a business outcome: the caller supplied data the business rules refuse, which is information rather than a malfunction, and retrying it unchanged will produce the same answer.

**recovered-maintenance** — HTTP 503 replaces the page mid-flow. `retry_request` asks for it again rather than dismissing it — the Continue link on that screen goes to the main menu, which would clear the condition and lose the flow position in the same motion.

**recovered-session-timeout** — HTTP 440 destroys the session, so every later request lands on sign-on. The run signs on again from environment credentials and restarts the flow from its entry point, because a new session does not restore where it was.

**failure-application-error** — HTTP 500. Reported as `surface_error` naming the screen's own ERR- reference, so it can be traced in the vendor's logs — rather than as a checkpoint timeout that says only "nothing arrived".

**escalated-irreversible-transfer** — Not a failure and not a refusal to try: every step up to the commit ran, the review screen was reached and its contents asserted, and then policy declined to press "Post Transfer" unattended. The browser session stays open and parked so a person can take it over on the live session rather than starting again.

**business-supervisor-gated-hold** — Place Account Hold is entitlement-gated. Nothing is broken: MERIDIAN answered the question "may this operator do this?" and the answer was no. Reported as an outcome code a caller can branch on, with the run stopping before it reaches anything irreversible.

**success-sign-on** — Takes no credentials as arguments. The capability declares that it needs an authenticated session; the runtime supplies the identity from the product profile, and the operator id and password reach the step log as {{__operator}} and [REDACTED:secret] rather than as values.

**success-member-inquiry-by-name** — Recorded searching for one surname and replayed for another. The Select link is addressed by the row it sits in rather than by position, so a result set that comes back in a different order still resolves to the right member.

**success-update-member-info** — Writes the values already on file, so the flow is exercised end to end without changing the record on a shared instance. The mailing address REPLACES what is on file rather than appending, which is why the input is required rather than optional.

**escalated-irreversible-open-share** — The review screen was reached and its contents asserted, and then policy declined to press "Open Share" unattended. Two gates have to open for that step: the artifact must be approved by a human, and the invocation must explicitly authorise it. This run had neither.

