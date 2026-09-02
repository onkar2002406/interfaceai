# Replay — open_sub_account@1.0.0

| | |
|---|---|
| Status | **success** |
| Run | `irreversible-authorised` |
| Tenant | base (corebank-servicing) |
| Started | 2026-09-02T05:36:40.911Z |
| Duration | 2848 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Outputs

```json
{
  "newAccountNumber": "[pii:a2d61939…0001]"
}
```

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Open the member search screen from the left-hand menu. | click | ok | 368 | 1 via `name:normalized` |
| 2 | `s2` | Type the member identifier into the search field. | type | ok | 125 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Submit the search and land on the member's detail screen. | click | ok | 210 | 1 via `name:normalized` |
| 4 | `s4` | Open the new sub-account form for this member. | click | ok | 241 | 1 via `name:contains` |
| 5 | `s5` | Choose the share account product to open. | select | ok | 67 | 1 via `anchor:proximateLabel` |
| 6 | `s6` | Enter the opening deposit amount. | type | ok | 169 | 1 via `anchor:proximateLabel` |
| 7 | `s7` | Enter the member-facing nickname for the account. | type | ok | 166 | 1 via `anchor:proximateLabel` |
| 8 | `s8` | Submit the form for review, without committing anything yet. | click | ok | 79 | 1 via `name:normalized` |
| 9 | `s9` | Commit the application and open the account. | click | ok | 297 | 1 via `name:normalized` |

## Evidence

- `evidence/replay-irreversible-authorised/events.jsonl` — structured event log
- `evidence/replay-irreversible-authorised/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory