# Replay — sign_on@1.0.0

| | |
|---|---|
| Status | **success** |
| Run | `success-sign-on` |
| Tenant | meridian (meridian-core) |
| Started | 2026-09-06T21:03:04.137Z |
| Duration | 1247 ms |
| Overrides applied | 0 |
| Drift signals | 0 |

## Outputs

```json
{
  "signedOnAs": "Signed on as J. TELLER (TELLER)"
}
```

## Steps

| # | Step | Intent | Action | Status | ms | Locator |
|---|---|---|---|---|---|---|
| 1 | `s1` | Enter the configured operator ID into the Operator ID box | type | ok | 245 | 1 via `anchor:proximateLabel` |
| 2 | `s2` | Enter the configured password into the Password box | type | ok | 218 | 1 via `anchor:proximateLabel` |
| 3 | `s3` | Click Sign On to establish the operator session | click | ok | 239 | 1 via `name:normalized` |

## Evidence

- `evidence/meridian/replay-success-sign-on/events.jsonl` — structured event log
- `evidence/meridian/replay-success-sign-on/result.json` — full machine-readable result
- screenshots and accessibility snapshots for any failure are in the same directory