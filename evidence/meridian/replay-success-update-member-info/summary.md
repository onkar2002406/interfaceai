# Replay — update_member_info@1.0.0

| | |
|---|---|
| Status | **success** |
| Run | `success-update-member-info` |
| Tenant | meridian (meridian-core) |
| Started | 2026-09-06T21:03:08.609Z |
| Duration | 5052 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Outputs

```json
{}
```

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Click the 'Member Inquiry / Selection' link to start member lookup | click | ok | 166 | 1 via `name:normalized` |
| 2 | `s2` | Enter member number {{memberId}} into the Value textbox for member lookup | type | ok | 179 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Click the Search button to find member {{memberId}} | click | ok | 189 | 1 via `name:normalized` |
| 4 | `s4` | Click the Select link for member {{memberId}} to open the member details page | click | ok | 263 | 1 via `name:normalized` |
| 5 | `s5` | Click the 'Update Member Information' link to open the edit form for email and phone | click | ok | 278 | 0.997 via `name:normalized` |
| 6 | `s6` | Enter {{email}} into the E-mail textbox | type | ok | 794 | 1 via `anchor:proximateLabel` |
| 7 | `s7` | Enter {{phone}} into the Phone textbox | type | ok | 624 | 1 via `anchor:proximateLabel` |
| 8 | `s7a` | Enter {{address}} into the Mailing Address textbox | type | ok | 808 | 1 via `anchor:proximateLabel` |
| 9 | `s8` | Click the Save Changes button to commit the updated email and phone values | click | ok | 162 | 1 via `name:normalized` |

## Evidence

- `evidence/meridian/replay-success-update-member-info/events.jsonl` — structured event log
- `evidence/meridian/replay-success-update-member-info/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory