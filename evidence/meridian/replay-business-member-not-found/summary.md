# Replay — get_balance@1.0.0

| | |
|---|---|
| Status | **business_outcome** |
| Run | `business-member-not-found` |
| Tenant | meridian (meridian-core) |
| Started | 2026-09-06T21:02:30.442Z |
| Duration | 2352 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Business outcome

**`MEMBER_NOT_FOUND`** at step `s3` (condition `member_search_no_results`)

No member record matches the supplied identifier.

> This is a legitimate answer to the question asked, not a malfunction. Retrying with the same inputs will produce the same result.

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Click the Member Inquiry link to start searching for a member record | click | ok | 215 | 1 via `name:normalized` |
| 2 | `s2` | Enter member number {{memberId}} into the Value field to search for the member record | type | ok | 211 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Click the Search button to retrieve the member record for member number {{memberId}} | click | business | 187 | 1 via `name:normalized` |

## Evidence

- `evidence/meridian/replay-business-member-not-found/events.jsonl` — structured event log
- `evidence/meridian/replay-business-member-not-found/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory