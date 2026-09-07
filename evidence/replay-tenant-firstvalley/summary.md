# Replay — lookup_member_savings_balance@1.0.0

| | |
|---|---|
| Status | **success** |
| Run | `tenant-firstvalley` |
| Tenant | firstvalley (corebank-servicing) |
| Started | 2026-09-02T05:36:34.016Z |
| Duration | 1890 ms |
| Overrides applied | 2 |
| Drift signals | 1 |

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
| 1 | `s1` | Open the member search screen from the left-hand menu. | click | ok | 418 | 1 via `name:normalized` |
| 2 | `s2` | Type the member identifier into the search field. | type | ok | 148 | 0.571 via `frame` ⚠︎drift |
| 3 | `s3` | Submit the search and land on the member's detail screen. | click | ok | 296 | 1 via `name:normalized` |

## Tenant overrides applied

- `/steps/0/action/target/name` — Their menu says "Find Member" where the reference install says "Member Search". A pure relabel with no behavioural difference.

- `/steps/2/action/target/name` — Their search button is captioned "Go". Nothing else about the search form differs.


## Drift signals

Each of these resolved successfully, but not by the signal it was recorded with. That is the earliest cheap warning that this tenant has diverged — it is information, not a failure.

| Step | Wanted | Matched | Score | Strategy |
|---|---|---|---|---|
| `s2` | unnamed textbox, labelled "Member ID", in frame main/contentFrame | — | 0.571 | `frame` |

## Evidence

- `evidence/replay-tenant-firstvalley/events.jsonl` — structured event log
- `evidence/replay-tenant-firstvalley/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory