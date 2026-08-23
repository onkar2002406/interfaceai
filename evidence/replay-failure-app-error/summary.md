# Replay — lookup_member_savings_balance@1.0.0

| | |
|---|---|
| Status | **failed** |
| Run | `failure-app-error` |
| Tenant | base (corebank-servicing) |
| Started | 2026-08-23T14:07:02.395Z |
| Duration | 2315 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Failure

**`surface_error`** at step `s3`

- **Step intent:** Submit the search and land on the member's detail screen.
- **Expected:** the member detail screen for the requested member is displayed
- **Observed:** found "Unexpected System Error"
- **Recoveries tried:** none

The application returned its system error page. The on-screen error reference identifies the failure in the vendor's logs.


## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Open the member search screen from the left-hand menu. | click | ok | 451 | 1 via `name:normalized` |
| 2 | `s2` | Type the member identifier into the search field. | type | ok | 192 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Submit the search and land on the member's detail screen. | click | failed | 234 | 1 via `name:normalized` |

## Evidence

- `evidence/replay-failure-app-error/events.jsonl` — structured event log
- `evidence/replay-failure-app-error/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory