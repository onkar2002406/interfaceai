# Replay — open_sub_account@1.0.0

| | |
|---|---|
| Status | **success** |
| Run | `human-handoff` |
| Tenant | base (corebank-servicing) |
| Started | 2026-08-24T01:32:16.276Z |
| Duration | 10121 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Outputs

```json
{
  "newAccountNumber": "[pii:a198979e…0028]"
}
```

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Open the member search screen from the left-hand menu. | click | ok | 618 | 1 via `name:normalized` |
| 2 | `s2` | Type the member identifier into the search field. | type | ok | 192 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Submit the search and land on the member's detail screen. | click | ok | 435 | 1 via `name:normalized` |
| 4 | `s4` | Open the new sub-account form for this member. | click | ok | 386 | 1 via `name:contains` |
| 5 | `s5` | Choose the share account product to open. | select | ok | 138 | 1 via `anchor:proximateLabel` |
| 6 | `s6` | Enter the opening deposit amount. | type | ok | 246 | 1 via `anchor:proximateLabel` |
| 7 | `s7` | Enter the member-facing nickname for the account. | type | ok | 253 | 1 via `anchor:proximateLabel` |
| 8 | `s8` | Submit the form for review, without committing anything yet. | click | ok | 115 | 1 via `name:normalized` |
| 9 | `s9` | Commit the application and open the account. | click | ok | 2827 | — |

## Evidence

- `evidence/replay-human-handoff/events.jsonl` — structured event log
- `evidence/replay-human-handoff/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory