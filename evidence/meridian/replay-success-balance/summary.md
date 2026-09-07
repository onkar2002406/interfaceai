# Replay — get_balance@1.0.0

| | |
|---|---|
| Status | **success** |
| Run | `success-balance` |
| Tenant | meridian (meridian-core) |
| Started | 2026-09-06T21:02:26.293Z |
| Duration | 4000 ms |
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
| 1 | `s1` | Click the Member Inquiry link to start searching for a member record | click | ok | 286 | 1 via `name:normalized` |
| 2 | `s2` | Enter member number {{memberId}} into the Value field to search for the member record | type | ok | 317 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Click the Search button to retrieve the member record for member number {{memberId}} | click | ok | 270 | 1 via `name:normalized` |
| 4 | `s4` | Click the Select link for member {{memberId}} to open the member record | click | ok | 447 | 1 via `name:normalized` |

## Evidence

- `evidence/meridian/replay-success-balance/events.jsonl` — structured event log
- `evidence/meridian/replay-success-balance/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory