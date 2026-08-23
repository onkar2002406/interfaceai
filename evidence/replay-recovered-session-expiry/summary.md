# Replay — lookup_member_savings_balance@1.0.0

| | |
|---|---|
| Status | **success** |
| Run | `recovered-session-expiry` |
| Tenant | base (corebank-servicing) |
| Started | 2026-08-23T07:38:28.873Z |
| Duration | 4592 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Outputs

```json
{
  "savingsBalance": 8412.55,
  "savingsAccountNumber": "[pii:57efb147…7735]"
}
```

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Open the member search screen from the left-hand menu. | click | ok | 530 | 1 via `name:normalized` |
| 2 | `s2` | Type the member identifier into the search field. | type | ok | 305 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Submit the search and land on the member's detail screen. | click | ok | 408 | 1 via `name:normalized` |

## Evidence

- `evidence/replay-recovered-session-expiry/events.jsonl` — structured event log
- `evidence/replay-recovered-session-expiry/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory