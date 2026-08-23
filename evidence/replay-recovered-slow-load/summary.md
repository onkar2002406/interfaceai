# Replay — lookup_member_savings_balance@1.0.0

| | |
|---|---|
| Status | **success** |
| Run | `recovered-slow-load` |
| Tenant | base (corebank-servicing) |
| Started | 2026-08-23T19:36:16.148Z |
| Duration | 7874 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Outputs

```json
{
  "savingsBalance": 8412.55,
  "savingsAccountNumber": "[pii:365ef92e…7735]"
}
```

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Open the member search screen from the left-hand menu. | click | ok | 432 | 1 via `name:normalized` |
| 2 | `s2` | Type the member identifier into the search field. | type | ok | 142 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Submit the search and land on the member's detail screen. | click | ok | 6105 | 1 via `name:normalized` |

## Evidence

- `evidence/replay-recovered-slow-load/events.jsonl` — structured event log
- `evidence/replay-recovered-slow-load/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory