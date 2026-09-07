# Replay — get_balance@1.0.0

| | |
|---|---|
| Status | **success** |
| Run | `recovered-maintenance` |
| Tenant | meridian (meridian-core) |
| Started | 2026-09-06T21:02:39.910Z |
| Duration | 4387 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Outputs

```json
{
  "shareBalance": 123,
  "shareStatus": "OPEN"
}
```

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Click the Member Inquiry link to start searching for a member record | click | ok | 213 | 1 via `name:normalized` |
| 2 | `s2` | Enter member number {{memberId}} into the Value field to search for the member record | type | ok | 198 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Click the Search button to retrieve the member record for member number {{memberId}} | click | ok | 196 | 1 via `name:normalized` |
| 4 | `s4` | Click the Select link for member {{memberId}} to open the member record | click | ok | 1636 | 1 via `name:normalized` |

## Recovery attempts

| Condition | Handler | Attempt | OK | Note |
|---|---|---|---|---|
| `maintenance_interstitial` | retry_request | 1 | yes | re-requested https://web-sample.interface-hiring.com/members/103001 after 1200ms |

## Evidence

- `evidence/meridian/replay-recovered-maintenance/events.jsonl` — structured event log
- `evidence/meridian/replay-recovered-maintenance/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory