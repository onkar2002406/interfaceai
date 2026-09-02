# Replay — lookup_member_savings_balance@1.0.0

| | |
|---|---|
| Status | **success** |
| Run | `tenant-harborcu` |
| Tenant | harborcu (corebank-servicing) |
| Started | 2026-09-02T05:36:35.970Z |
| Duration | 2039 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Outputs

```json
{
  "savingsBalance": 8412.55,
  "savingsAccountNumber": "[pii:230c34d1…7735]"
}
```

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Open the member search screen from the left-hand menu. | click | ok | 380 | 1 via `name:normalized` |
| 2 | `s2` | Type the member identifier into the search field. | type | ok | 127 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Submit the search and land on the member's detail screen. | click | ok | 293 | 1 via `name:normalized` |

## Recovery attempts

| Condition | Handler | Attempt | OK | Note |
|---|---|---|---|---|
| `privacy_acknowledgement` | dismiss_dialog | 1 | yes | dismissed via "Acknowledge and Continue" |

## Evidence

- `evidence/replay-tenant-harborcu/events.jsonl` — structured event log
- `evidence/replay-tenant-harborcu/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory