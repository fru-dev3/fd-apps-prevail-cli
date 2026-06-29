---
id: investments-holdings
runner: llm
panelist: claude
trigger: refresh
auth: [PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ACCESS_TOKEN]
inputs: []
outputs:
  - { path: data/investments/holdings-${date}.json, kind: replace }
---

# Investment holdings

Pull current brokerage / retirement holdings across every investment account
linked to `PLAID_ACCESS_TOKEN` and write a dated position-level snapshot.
Read-only.

POST to `https://production.plaid.com/investments/holdings/get` with:

```json
{
  "client_id": "<PLAID_CLIENT_ID>",
  "secret": "<PLAID_SECRET>",
  "access_token": "<PLAID_ACCESS_TOKEN>"
}
```

The response has three arrays: `accounts[]`, `securities[]`, and
`holdings[]`. Join each holding to its security via `security_id`. For each
holding read `quantity`, `institution_price`, `institution_value`,
`cost_basis`, and `iso_currency_code`; from the joined security read
`ticker_symbol`, `name`, and `type` (e.g. `equity`, `etf`, `mutual_fund`,
`cash`).

Compute, per position, `gain = institution_value - cost_basis` when
`cost_basis` is present. Total portfolio value = sum of all
`institution_value`.

Output a single JSON object (no preamble, no markdown):

```json
{
  "as_of": "2026-06-29",
  "currency": "USD",
  "total_value": 152340.18,
  "positions": [
    {"ticker":"VTI","name":"Vanguard Total Stock Market ETF","type":"etf","quantity":120.5,"price":268.40,"value":32342.20,"cost_basis":21000.00,"gain":11342.20,"account_id":"inv_001"}
  ]
}
```

Sort positions by `value` descending.

Output: one JSON object of holdings.
