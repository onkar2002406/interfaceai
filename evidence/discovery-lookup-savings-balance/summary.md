# Discovery — look up member {{memberId}} and read their current savings balance

| | |
|---|---|
| Outcome | **success** |
| Run | `lookup-savings-balance` |
| Model | scripted:scripted-fixture |
| Tenant | base (corebank-servicing) |
| Model calls | 4 |
| Tokens | 0 prompt / 0 completion |
| Steps taken | 3 |

## What the model did

| # | Tool | Target | Its stated reason | OK |
|---|---|---|---|---|
| 1 | click | Member Search | Open the member search screen from the left-hand menu. | yes |
| 2 | type | Member ID | Type the member identifier into the search field. | yes |
| 3 | click | Search | Submit the search and land on the member's detail screen. | yes |

## Compiled capability

`discovered_member_savings@1.0.0` — **draft**

- **Inputs:** `memberId` (string, pii)
- **Outputs:** `savingsBalance` (money)
- **Declared business outcomes:** `PERMISSION_DENIED`, `MEMBER_NOT_FOUND`, `VALIDATION_ERROR`

The model contributed the order of actions, which element each touched, and the prose intent of
each step. Locators, checkpoints, risk classes and the error taxonomy were derived by the compiler
and inherited from the product profile — not authored by the model.