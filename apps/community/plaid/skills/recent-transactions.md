---
id: recent-transactions
runner: llm
panelist: claude
trigger: cron("0 */2 * * *")
auth: [PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ACCESS_TOKEN]
inputs:
  - { name: days, type: number, required: false, description: "lookback window (default 7)" }
outputs:
  - { path: transactions/recent.jsonl, kind: replace }
---

# Recent transactions

Pull the last N days of transactions across every account linked to
`PLAID_ACCESS_TOKEN`. Default lookback is 7 days; respect `${input.days}`
when provided.

POST to `https://production.plaid.com/transactions/get` with:

```json
{
  "client_id": "<PLAID_CLIENT_ID>",
  "secret": "<PLAID_SECRET>",
  "access_token": "<PLAID_ACCESS_TOKEN>",
  "start_date": "<today - days>",
  "end_date": "<today>",
  "options": { "count": 500 }
}
```

Output one JSON object per line (JSONL). Each line is:

```json
{"date":"2026-06-01","amount":42.18,"name":"Whole Foods","category":["Food","Groceries"],"account_id":"abc123"}
```

No preamble. No markdown — pure JSONL.
