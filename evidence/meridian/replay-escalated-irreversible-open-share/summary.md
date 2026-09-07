# Replay — open_new_share@1.0.0

| | |
|---|---|
| Status | **escalated** |
| Run | `escalated-irreversible-open-share` |
| Tenant | meridian (meridian-core) |
| Started | 2026-09-06T21:03:13.760Z |
| Duration | 5796 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Escalation

Intervention `int_fe9ad303` at step `s9` — resolution: **unattended**

irreversible step requires an approved artifact and explicit invocation authorisation (OPEN_SHARE)

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Click the 'Member Inquiry / Selection' link to start member search | click | ok | 321 | 1 via `name:normalized` |
| 2 | `s2` | Enter member number {{memberId}} into the Value textbox for member search | type | ok | 347 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Click the Search button to find member {{memberId}} | click | ok | 425 | 1 via `name:normalized` |
| 4 | `s4` | Click the Select link for member {{memberId}} to open member details | click | ok | 555 | 1 via `name:normalized` |
| 5 | `s5` | Click the 'Open New Share' link to start creating a new share for the member | click | ok | 881 | 0.997 via `name:normalized` |
| 6 | `s6` | Select {{shareType}} - Money Market in the Share Type dropdown | select | ok | 321 | 1 via `anchor:proximateLabel` |
| 7 | `s7` | Enter the initial deposit amount of {{deposit}} into the Initial Deposit textbox | type | ok | 215 | 1 via `anchor:proximateLabel` |
| 8 | `s8` | Click the Continue button to proceed to the share confirmation screen | click | ok | 239 | 1 via `name:normalized` |
| 9 | `s9` | Click Open Share to create the share shown on the confirmation screen | click | escalated | 530 | — |

## Evidence

- `evidence/meridian/replay-escalated-irreversible-open-share/events.jsonl` — structured event log
- `evidence/meridian/replay-escalated-irreversible-open-share/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory