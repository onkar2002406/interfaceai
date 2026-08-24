# Replay — lookup_member_savings_balance@1.0.0

| | |
|---|---|
| Status | **business_outcome** |
| Run | `business-outcome-not-found` |
| Tenant | base (corebank-servicing) |
| Started | 2026-08-24T01:53:41.402Z |
| Duration | 3203 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Business outcome

**`MEMBER_NOT_FOUND`** at step `s3` (condition `member_not_found`)

No member matches the supplied identifier. This is a complete and correct answer to the question asked — the identifier is wrong or the member does not exist at this institution.


> This is a legitimate answer to the question asked, not a malfunction. Retrying with the same inputs will produce the same result.

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Open the member search screen from the left-hand menu. | click | ok | 624 | 1 via `name:normalized` |
| 2 | `s2` | Type the member identifier into the search field. | type | ok | 197 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Submit the search and land on the member's detail screen. | click | business | 410 | 1 via `name:normalized` |

## Evidence

- `evidence/replay-business-outcome-not-found/events.jsonl` — structured event log
- `evidence/replay-business-outcome-not-found/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory