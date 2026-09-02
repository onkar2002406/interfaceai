# Discovery — look up member {{memberId}} and read their current savings balance

| | |
|---|---|
| Outcome | **success** |
| Run | `lookup-savings-balance` |
| Model | groq:openai/gpt-oss-120b |
| Tenant | base (corebank-servicing) |
| Model calls | 4 |
| Tokens | 6691 prompt / 465 completion |
| Steps taken | 3 |

## What the model did

| # | Tool | Target | Its stated reason | OK |
|---|---|---|---|---|
| 1 | click | Member Search | Click the Member Search link to open the member search screen | yes |
| 2 | type | Member ID | Enter member ID 10001 into the Member ID textbox | yes |
| 3 | click | Search | Click the Search button to look up member 10001 | yes |

## Compiled capability

`discovered_member_savings@1.0.0` — **draft**

- **Inputs:** `memberId` (string, pii)
- **Outputs:** `savingsBalance` (money)
- **Declared business outcomes:** `PERMISSION_DENIED`, `MEMBER_NOT_FOUND`, `VALIDATION_ERROR`

The model contributed the order of actions, which element each touched, and the prose intent of
each step. Locators, checkpoints, risk classes and the error taxonomy were derived by the compiler
and inherited from the product profile — not authored by the model.