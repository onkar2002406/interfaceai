# Replay — lookup_member_savings_balance@1.0.0

| | |
|---|---|
| Status | **business_outcome** |
| Run | `business-outcome-permission-denied` |
| Tenant | base (corebank-servicing) |
| Started | 2026-08-23T14:07:00.263Z |
| Duration | 2028 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Business outcome

**`PERMISSION_DENIED`** at step `s3` (condition `permission_denied`)

The member record is restricted and the signed-on operator lacks the entitlement to view it. A different operator identity may succeed.


> This is a legitimate answer to the question asked, not a malfunction. Retrying with the same inputs will produce the same result.

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Open the member search screen from the left-hand menu. | click | ok | 381 | 1 via `name:normalized` |
| 2 | `s2` | Type the member identifier into the search field. | type | ok | 148 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Submit the search and land on the member's detail screen. | click | business | 74 | 1 via `name:normalized` |

## Evidence

- `evidence/replay-business-outcome-permission-denied/events.jsonl` — structured event log
- `evidence/replay-business-outcome-permission-denied/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory