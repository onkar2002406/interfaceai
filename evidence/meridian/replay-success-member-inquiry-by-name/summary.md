# Replay — member_inquiry@1.0.0

| | |
|---|---|
| Status | **success** |
| Run | `success-member-inquiry-by-name` |
| Tenant | meridian (meridian-core) |
| Started | 2026-09-06T21:03:05.481Z |
| Duration | 3039 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Outputs

```json
{
  "memberNumber": "101555",
  "memberFullName": "Hopper, Grace"
}
```

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Click the Member Inquiry link to open the member inquiry search screen | click | ok | 274 | 1 via `name:normalized` |
| 2 | `s2` | Select 'Last Name' in the Search by dropdown to enable searching by last name | select | ok | 152 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Enter last name '{{lastName}}' into the Value textbox for member search | type | ok | 274 | 1 via `anchor:proximateLabel` |
| 4 | `s4` | Click the Search button to perform the member lookup by last name | click | ok | 353 | 1 via `name:normalized` |
| 5 | `s5` | Click the Select link for the {{lastName}} record to open the member detail screen | click | ok | 281 | 1 via `name:normalized` |

## Evidence

- `evidence/meridian/replay-success-member-inquiry-by-name/events.jsonl` — structured event log
- `evidence/meridian/replay-success-member-inquiry-by-name/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory