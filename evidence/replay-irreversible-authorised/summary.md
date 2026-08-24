# Replay — open_sub_account@1.0.0

| | |
|---|---|
| Status | **success** |
| Run | `irreversible-authorised` |
| Tenant | base (corebank-servicing) |
| Started | 2026-08-24T01:54:56.954Z |
| Duration | 4435 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Outputs

```json
{
  "newAccountNumber": "[pii:43920b13…0029]"
}
```

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Open the member search screen from the left-hand menu. | click | ok | 474 | 1 via `name:normalized` |
| 2 | `s2` | Type the member identifier into the search field. | type | ok | 174 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Submit the search and land on the member's detail screen. | click | ok | 281 | 1 via `name:normalized` |
| 4 | `s4` | Open the new sub-account form for this member. | click | ok | 357 | 1 via `name:contains` |
| 5 | `s5` | Choose the share account product to open. | select | ok | 142 | 1 via `anchor:proximateLabel` |
| 6 | `s6` | Enter the opening deposit amount. | type | ok | 248 | 1 via `anchor:proximateLabel` |
| 7 | `s7` | Enter the member-facing nickname for the account. | type | ok | 326 | 1 via `anchor:proximateLabel` |
| 8 | `s8` | Submit the form for review, without committing anything yet. | click | ok | 140 | 1 via `name:normalized` |
| 9 | `s9` | Commit the application and open the account. | click | ok | 258 | 1 via `name:normalized` |

## Evidence

- `evidence/replay-irreversible-authorised/events.jsonl` — structured event log
- `evidence/replay-irreversible-authorised/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory