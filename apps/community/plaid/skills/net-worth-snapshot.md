---
id: net-worth-snapshot
runner: llm
panelist: claude
trigger: refresh
auth: [PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ACCESS_TOKEN]
inputs: []
outputs:
  - { path: data/net-worth/snapshot-${date}.json, kind: replace }
---

# Net worth snapshot

Compute a point-in-time net worth across every account linked to
`PLAID_ACCESS_TOKEN`, then write a dated snapshot so the series becomes
chart-able over time. Read-only.

POST to `https://production.plaid.com/accounts/balance/get` with:

```json
{
  "client_id": "<PLAID_CLIENT_ID>",
  "secret": "<PLAID_SECRET>",
  "access_token": "<PLAID_ACCESS_TOKEN>"
}
```

For each returned `accounts[]` entry, read `account_id`, `name`, `type`,
`subtype`, and `balances.current` (fall back to `balances.available` when
`current` is null). Use `balances.iso_currency_code` for currency.

Classify each account:
- **Assets**, `type` of `depository`, `investment`, or `brokerage`. Use
  the positive balance.
- **Liabilities**, `type` of `credit` or `loan`. A balance here is money
  owed, so it subtracts from net worth.

Net worth = sum(asset balances) − sum(liability balances).

Output a single JSON object (no preamble, no markdown):

```json
{
  "as_of": "2026-06-29",
  "currency": "USD",
  "total_assets": 84210.55,
  "total_liabilities": 12380.10,
  "net_worth": 71830.45,
  "accounts": [
    {"account_id":"abc123","name":"Checking","type":"depository","subtype":"checking","balance":4210.55,"side":"asset"}
  ]
}
```

Output: one JSON object, the net-worth snapshot for today.
