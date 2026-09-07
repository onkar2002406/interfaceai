# Replay — get_balance@1.0.0

| | |
|---|---|
| Status | **success** |
| Run | `recovered-session-timeout` |
| Tenant | meridian (meridian-core) |
| Started | 2026-09-06T21:02:44.419Z |
| Duration | 4661 ms |
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
| 1 | `s1` | Click the Member Inquiry link to start searching for a member record | click | ok | 157 | 1 via `name:normalized` |
| 2 | `s2` | Enter member number {{memberId}} into the Value field to search for the member record | type | ok | 168 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Click the Search button to retrieve the member record for member number {{memberId}} | click | ok | 170 | 1 via `name:normalized` |
| 4 | `s4` | Click the Select link for member {{memberId}} to open the member record | click | ok | 287 | 1 via `name:normalized` |

## Evidence

- `evidence/meridian/replay-recovered-session-timeout/events.jsonl` — structured event log
- `evidence/meridian/replay-recovered-session-timeout/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory