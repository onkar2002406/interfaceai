# Replay — get_balance@1.0.0

| | |
|---|---|
| Status | **failed** |
| Run | `failure-application-error` |
| Tenant | meridian (meridian-core) |
| Started | 2026-09-06T21:02:49.172Z |
| Duration | 3006 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Failure

**`surface_error`** at step `s4`

- **Step intent:** Click the Select link for member {{memberId}} to open the member record
- **Expected:** the route matches /members/[0-9]+(?:[?#]|$) and "MEMBER RECORD" is on screen
- **Observed:** found "APPLICATION ERROR"
- **Recoveries tried:** none

MERIDIAN returned its application error screen. The ERR- reference shown on the page identifies this failure in the vendor's logs.


## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Click the Member Inquiry link to start searching for a member record | click | ok | 186 | 1 via `name:normalized` |
| 2 | `s2` | Enter member number {{memberId}} into the Value field to search for the member record | type | ok | 220 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Click the Search button to retrieve the member record for member number {{memberId}} | click | ok | 451 | 1 via `name:normalized` |
| 4 | `s4` | Click the Select link for member {{memberId}} to open the member record | click | failed | 326 | 1 via `name:normalized` |

## Evidence

- `evidence/meridian/replay-failure-application-error/events.jsonl` — structured event log
- `evidence/meridian/replay-failure-application-error/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory