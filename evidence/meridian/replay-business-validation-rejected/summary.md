# Replay — get_balance@1.0.0

| | |
|---|---|
| Status | **business_outcome** |
| Run | `business-validation-rejected` |
| Tenant | meridian (meridian-core) |
| Started | 2026-09-06T21:02:35.277Z |
| Duration | 4147 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Business outcome

**`VALIDATION_ERROR`** at step `s4` (condition `transaction_rejected`)

The application rejected the submitted transaction.

> This is a legitimate answer to the question asked, not a malfunction. Retrying with the same inputs will produce the same result.

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Click the Member Inquiry link to start searching for a member record | click | ok | 523 | 1 via `name:normalized` |
| 2 | `s2` | Enter member number {{memberId}} into the Value field to search for the member record | type | ok | 618 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Click the Search button to retrieve the member record for member number {{memberId}} | click | ok | 602 | 1 via `name:normalized` |
| 4 | `s4` | Click the Select link for member {{memberId}} to open the member record | click | business | 369 | 1 via `name:normalized` |

## Evidence

- `evidence/meridian/replay-business-validation-rejected/events.jsonl` — structured event log
- `evidence/meridian/replay-business-validation-rejected/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory