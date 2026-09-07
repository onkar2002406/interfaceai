# Replay — place_account_hold@1.0.0

| | |
|---|---|
| Status | **business_outcome** |
| Run | `business-supervisor-gated-hold` |
| Tenant | meridian (meridian-core) |
| Started | 2026-09-06T21:03:00.867Z |
| Duration | 3195 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Business outcome

**`SUPERVISOR_OVERRIDE_REQUIRED`** at step `s5` (condition `supervisor_required`)

The signed-on operator is not entitled to perform this restricted function. A supervisor must carry it out.


> This is a legitimate answer to the question asked, not a malfunction. Retrying with the same inputs will produce the same result.

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Click the 'Member Inquiry / Selection' link to start member search | click | ok | 156 | 1 via `name:normalized` |
| 2 | `s2` | Type the member number {{memberId}} into the Value textbox to search for the member | type | ok | 191 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Click the Search button to find the member with number {{memberId}} | click | ok | 188 | 1 via `name:normalized` |
| 4 | `s4` | Click the 'Select' link for the matching member row to open the member details | click | ok | 255 | 1 via `name:normalized` |
| 5 | `s5` | Click the 'Place Account Hold' link to start the hold process | click | business | 702 | 0.997 via `name:normalized` |

## Evidence

- `evidence/meridian/replay-business-supervisor-gated-hold/events.jsonl` — structured event log
- `evidence/meridian/replay-business-supervisor-gated-hold/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory