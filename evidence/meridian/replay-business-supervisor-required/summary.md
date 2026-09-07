# Replay — get_balance@1.0.0

| | |
|---|---|
| Status | **business_outcome** |
| Run | `business-supervisor-required` |
| Tenant | meridian (meridian-core) |
| Started | 2026-09-06T21:02:32.880Z |
| Duration | 2296 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Business outcome

**`SUPERVISOR_OVERRIDE_REQUIRED`** at step `s4` (condition `supervisor_required`)

The signed-on operator is not entitled to perform this restricted function. A supervisor must carry it out.


> This is a legitimate answer to the question asked, not a malfunction. Retrying with the same inputs will produce the same result.

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Click the Member Inquiry link to start searching for a member record | click | ok | 241 | 1 via `name:normalized` |
| 2 | `s2` | Enter member number {{memberId}} into the Value field to search for the member record | type | ok | 204 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Click the Search button to retrieve the member record for member number {{memberId}} | click | ok | 199 | 1 via `name:normalized` |
| 4 | `s4` | Click the Select link for member {{memberId}} to open the member record | click | business | 174 | 1 via `name:normalized` |

## Evidence

- `evidence/meridian/replay-business-supervisor-required/events.jsonl` — structured event log
- `evidence/meridian/replay-business-supervisor-required/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory