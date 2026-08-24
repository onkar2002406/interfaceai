# Replay — open_sub_account@1.0.0

| | |
|---|---|
| Status | **escalated** |
| Run | `escalation-irreversible-unattended` |
| Tenant | base (corebank-servicing) |
| Started | 2026-08-24T01:54:46.707Z |
| Duration | 9989 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Escalation

Intervention `int_edffe020` at step `s9` — resolution: **unattended**

irreversible step requires an approved artifact and explicit invocation authorisation (IRREVERSIBLE_SUBMIT)

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Open the member search screen from the left-hand menu. | click | ok | 453 | 1 via `name:normalized` |
| 2 | `s2` | Type the member identifier into the search field. | type | ok | 156 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Submit the search and land on the member's detail screen. | click | ok | 243 | 1 via `name:normalized` |
| 4 | `s4` | Open the new sub-account form for this member. | click | ok | 1674 | 1 via `name:contains` |
| 5 | `s5` | Choose the share account product to open. | select | ok | 754 | 1 via `anchor:proximateLabel` |
| 6 | `s6` | Enter the opening deposit amount. | type | ok | 273 | 1 via `anchor:proximateLabel` |
| 7 | `s7` | Enter the member-facing nickname for the account. | type | ok | 404 | 1 via `anchor:proximateLabel` |
| 8 | `s8` | Submit the form for review, without committing anything yet. | click | ok | 197 | 1 via `name:normalized` |
| 9 | `s9` | Commit the application and open the account. | click | escalated | 3035 | — |

## Evidence

- `evidence/replay-escalation-irreversible-unattended/events.jsonl` — structured event log
- `evidence/replay-escalation-irreversible-unattended/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory