# Replay — lookup_member_savings_balance@1.0.0

| | |
|---|---|
| Status | **success** |
| Run | `recovered-interstitial` |
| Tenant | base (corebank-servicing) |
| Started | 2026-08-24T01:53:51.742Z |
| Duration | 3062 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Outputs

```json
{
  "savingsBalance": 8412.55,
  "savingsAccountNumber": "[pii:23a0ee6c…7735]"
}
```

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Open the member search screen from the left-hand menu. | click | ok | 626 | 1 via `name:normalized` |
| 2 | `s2` | Type the member identifier into the search field. | type | ok | 174 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Submit the search and land on the member's detail screen. | click | ok | 280 | 1 via `name:normalized` |

## Recovery attempts

| Condition | Handler | Attempt | OK | Note |
|---|---|---|---|---|
| `maintenance_interstitial` | dismiss_dialog | 1 | yes | dismissed via "Continue" |

## Evidence

- `evidence/replay-recovered-interstitial/events.jsonl` — structured event log
- `evidence/replay-recovered-interstitial/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory