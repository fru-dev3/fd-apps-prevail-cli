---
id: list-institutions
runner: llm
panelist: claude
trigger: on-demand
auth: [PLAID_CLIENT_ID, PLAID_SECRET]
inputs: []
outputs:
  - { path: institutions.md, kind: replace }
---

# List linked institutions

Call Plaid's `/institutions/get` endpoint to list every bank, brokerage, and
credit card linked through this client.

Use `PLAID_CLIENT_ID` + `PLAID_SECRET` from env. POST to
`https://production.plaid.com/institutions/get` with body:

```json
{
  "client_id": "<PLAID_CLIENT_ID>",
  "secret": "<PLAID_SECRET>",
  "count": 100,
  "offset": 0,
  "country_codes": ["US"]
}
```

Output a markdown table:

```
| institution | id | products |
|---|---|---|
| ... |
```

Sort alphabetically. Below the table, a one-line summary count.

No preamble, no commentary outside the table + summary.
