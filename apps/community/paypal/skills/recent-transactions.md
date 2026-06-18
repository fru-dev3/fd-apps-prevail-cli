---
id: recent-transactions
runner: api
trigger: refresh
auth: [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV]
url: https://api-m.paypal.com/v1/reporting/transactions?start_date=${days_ago.rfc3339:31}&end_date=${now.rfc3339}&fields=all&page_size=500
headers:
  - "Authorization: Bearer ${auth.token}"
  - "Accept: application/json"
save: data/transactions/latest.json
summary_path: total_items
outputs:
  - { path: data/transactions/latest.json, kind: replace }
---

# Recent PayPal transactions

Pull the last 31 days of PayPal transactions (the API's max single window) via the
REST Transaction Search endpoint and save the raw response to
`data/transactions/latest.json`. The `${auth.token}` is a fresh OAuth2
client-credentials token minted from your Client ID + Secret; `summary_path`
surfaces `total_items` as the run summary, and the saved JSON feeds the
wealth + tax domains.

> Note: the live endpoint is used by default. When `PAYPAL_ENV=sandbox`, the
> token is minted against the sandbox host; point the URL at
> `api-m.sandbox.paypal.com` for a full sandbox test.
