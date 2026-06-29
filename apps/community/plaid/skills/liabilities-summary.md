---
id: liabilities-summary
runner: llm
panelist: claude
trigger: refresh
auth: [PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ACCESS_TOKEN]
inputs: []
outputs:
  - { path: data/liabilities/summary-${date}.json, kind: replace }
---

# Liabilities summary

Summarize outstanding debt — credit cards, student loans, and mortgages —
across every account linked to `PLAID_ACCESS_TOKEN`, with due dates and
APRs so upcoming payments are visible. Read-only.

POST to `https://production.plaid.com/liabilities/get` with:

```json
{
  "client_id": "<PLAID_CLIENT_ID>",
  "secret": "<PLAID_SECRET>",
  "access_token": "<PLAID_ACCESS_TOKEN>"
}
```

The response returns `accounts[]` plus a `liabilities` object with three
arrays: `credit[]`, `student[]`, and `mortgage[]`. Each is keyed back to an
account via `account_id`.

Extract per liability:
- **credit** — `last_statement_balance`, `minimum_payment_amount`,
  `next_payment_due_date`, `last_payment_amount`, `is_overdue`, and the top
  entry of `aprs[]` (`apr_percentage`, `apr_type`).
- **student** — `outstanding_interest_amount`, `next_payment_due_date`,
  `minimum_payment_amount`, `interest_rate_percentage`, `loan_status.type`.
- **mortgage** — `outstanding_principal_balance`, `next_monthly_payment`,
  `next_payment_due_date`, `interest_rate.percentage`, `loan_type_description`.

Total debt = sum of current balances across all three categories.

Output a single JSON object (no preamble, no markdown):

```json
{
  "as_of": "2026-06-29",
  "total_debt": 312450.00,
  "credit": [{"account_id":"cc_1","balance":1240.10,"min_payment":35.00,"due_date":"2026-07-15","apr":21.99,"is_overdue":false}],
  "student": [{"account_id":"sl_1","balance":18200.00,"min_payment":210.00,"due_date":"2026-07-01","rate":4.5,"status":"repayment"}],
  "mortgage": [{"account_id":"mtg_1","principal":293000.00,"payment":1820.00,"due_date":"2026-07-01","rate":3.25}]
}
```

Flag any `is_overdue` account or due date within 7 days of today in a
`"alerts": [...]` array of short strings.

Output: one JSON object.
