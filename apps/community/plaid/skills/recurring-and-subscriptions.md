---
id: recurring-and-subscriptions
runner: llm
panelist: claude
trigger: refresh
auth: [PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ACCESS_TOKEN]
inputs: []
outputs:
  - { path: data/recurring/streams-${date}.json, kind: replace }
---

# Recurring payments and subscriptions

Surface recurring outflows (subscriptions, bills, memberships) detected by
Plaid across every account linked to `PLAID_ACCESS_TOKEN`, so renewals and
creeping charges are visible. Read-only.

POST to `https://production.plaid.com/transactions/recurring/get` with:

```json
{
  "client_id": "<PLAID_CLIENT_ID>",
  "secret": "<PLAID_SECRET>",
  "access_token": "<PLAID_ACCESS_TOKEN>"
}
```

The response returns `outflow_streams[]` and `inflow_streams[]`. Focus on
`outflow_streams[]` (money leaving). For each stream read
`description`, `merchant_name`, `frequency` (e.g. `MONTHLY`, `ANNUALLY`),
`average_amount.amount`, `last_amount.amount`, `last_date`,
`predicted_next_date`, `is_active`, and `status`.

Normalize every active stream to a monthly cost: divide annual by 12,
multiply weekly by ~4.33, biweekly by ~2.17. Sum to get total estimated
monthly recurring spend.

Output a single JSON object (no preamble, no markdown):

```json
{
  "as_of": "2026-06-29",
  "estimated_monthly_total": 412.85,
  "subscriptions": [
    {"merchant":"Netflix","description":"NETFLIX.COM","frequency":"MONTHLY","last_amount":15.49,"average_amount":15.49,"monthly_equiv":15.49,"last_date":"2026-06-12","next_date":"2026-07-12","active":true}
  ]
}
```

Include only `is_active` outflow streams. Sort by `monthly_equiv`
descending. Flag any stream whose `last_amount` rose more than 15% over
`average_amount` in a `"price_increases": [...]` array.

Output: one JSON
object.
