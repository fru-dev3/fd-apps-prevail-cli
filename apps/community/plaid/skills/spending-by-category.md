---
id: spending-by-category
runner: llm
panelist: claude
trigger: refresh
auth: [PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ACCESS_TOKEN]
inputs:
  - { name: days, type: number, required: false, description: "lookback window (default 30)" }
outputs:
  - { path: data/spending/by-category-${date}.json, kind: replace }
---

# Spending by category

Roll up the last N days of spending into category buckets so the wealth and
tax domains can see where money goes. Default lookback is 30 days; respect
`${input.days}` when provided. Read-only.

POST to `https://production.plaid.com/transactions/get` with:

```json
{
  "client_id": "<PLAID_CLIENT_ID>",
  "secret": "<PLAID_SECRET>",
  "access_token": "<PLAID_ACCESS_TOKEN>",
  "start_date": "<today - days>",
  "end_date": "<today>",
  "options": { "count": 500, "offset": 0 }
}
```

Page through results using `options.offset` until you have collected
`total_transactions` items.

For each transaction, treat a positive `amount` as money spent (Plaid uses
positive for outflow). Skip transfers and inflows (negative amounts). Bucket
by the transaction's category: prefer
`personal_finance_category.primary` when present, else the first element of
the legacy `category[]` array.

For each bucket compute total spent, transaction count, and percent of total
spend.

Output a single JSON object (no preamble, no markdown):

```json
{
  "as_of": "2026-06-29",
  "window_days": 30,
  "total_spend": 3842.10,
  "categories": [
    {"category":"FOOD_AND_DRINK","total":842.55,"count":48,"pct":21.9},
    {"category":"GENERAL_MERCHANDISE","total":612.20,"count":22,"pct":15.9}
  ],
  "top_merchants": [
    {"merchant":"Whole Foods","total":312.40,"count":9}
  ]
}
```

Sort `categories` by `total` descending; include the top 10 `top_merchants`
by spend.

Output: one JSON object.
