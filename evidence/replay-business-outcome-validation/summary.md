# Replay — open_sub_account@1.0.0

| | |
|---|---|
| Status | **business_outcome** |
| Run | `business-outcome-validation` |
| Tenant | base (corebank-servicing) |
| Started | 2026-09-02T05:36:43.822Z |
| Duration | 2622 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Business outcome

**`VALIDATION_ERROR`** at step `s8` (condition `validation_error`)

The application rejected the submitted values — most commonly an opening deposit below the institution's $25 minimum, or a nickname longer than 20 characters. Nothing was created; correct the inputs and invoke again.


> This is a legitimate answer to the question asked, not a malfunction. Retrying with the same inputs will produce the same result.

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Open the member search screen from the left-hand menu. | click | ok | 392 | 1 via `name:normalized` |
| 2 | `s2` | Type the member identifier into the search field. | type | ok | 139 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Submit the search and land on the member's detail screen. | click | ok | 214 | 1 via `name:normalized` |
| 4 | `s4` | Open the new sub-account form for this member. | click | ok | 227 | 1 via `name:contains` |
| 5 | `s5` | Choose the share account product to open. | select | ok | 72 | 1 via `anchor:proximateLabel` |
| 6 | `s6` | Enter the opening deposit amount. | type | ok | 146 | 1 via `anchor:proximateLabel` |
| 7 | `s7` | Enter the member-facing nickname for the account. | type | ok | 207 | 1 via `anchor:proximateLabel` |
| 8 | `s8` | Submit the form for review, without committing anything yet. | click | business | 115 | 1 via `name:normalized` |

## Evidence

- `evidence/replay-business-outcome-validation/events.jsonl` — structured event log
- `evidence/replay-business-outcome-validation/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory