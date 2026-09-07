# Replay — funds_transfer@1.0.0

| | |
|---|---|
| Status | **escalated** |
| Run | `escalated-irreversible-transfer` |
| Tenant | meridian (meridian-core) |
| Started | 2026-09-06T21:02:52.332Z |
| Duration | 8421 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Escalation

Intervention `int_efdf4677` at step `s10` — resolution: **unattended**

irreversible step requires an approved artifact and explicit invocation authorisation (FUNDS_TRANSFER)

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Click the 'Member Inquiry / Selection' link to start member lookup | click | ok | 225 | 1 via `name:normalized` |
| 2 | `s2` | Enter member number {{memberId}} into the Value textbox for member search | type | ok | 217 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Click the Search button to find member {{memberId}} | click | ok | 196 | 1 via `name:normalized` |
| 4 | `s4` | Click the 'Select' link for member {{memberId}} to open member details | click | ok | 305 | 1 via `name:normalized` |
| 5 | `s5` | Click the 'Funds Transfer' link to start a new transfer for member {{memberId}} | click | ok | 875 | 0.997 via `name:normalized` |
| 6 | `s6` | Select {{fromShare}} in the From Share dropdown | select | ok | 1081 | 1 via `anchor:proximateLabel` |
| 7 | `s7` | Select {{toShare}} in the To Share dropdown | select | ok | 1014 | 1 via `anchor:proximateLabel` |
| 8 | `s8` | Enter transfer amount {{amount}} into the Amount textbox | type | ok | 975 | 1 via `anchor:proximateLabel` |
| 9 | `s8a` | Enter {{memo}} into the Memo textbox | type | ok | 1177 | 1 via `anchor:proximateLabel` |
| 10 | `s9` | Click the Continue button to go to the transfer confirmation screen | click | ok | 576 | 1 via `name:normalized` |
| 11 | `s10` | Click Post Transfer to commit the transfer shown on the confirmation screen | click | escalated | 175 | — |

## Evidence

- `evidence/meridian/replay-escalated-irreversible-transfer/events.jsonl` — structured event log
- `evidence/meridian/replay-escalated-irreversible-transfer/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory