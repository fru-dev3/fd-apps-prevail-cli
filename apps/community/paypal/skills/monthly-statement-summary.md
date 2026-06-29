---
id: monthly-statement-summary
runner: llm
panelist: claude
trigger: refresh
auth: [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV]
inputs:
  - { name: month, type: string, required: false, description: "YYYY-MM to summarize (default: previous calendar month)" }
outputs:
  - { path: data/statements/summary-${date}.json, kind: replace }
---

# Monthly statement summary

Produce a one-month PayPal statement: money in, money out, fees, and net,
broken down by counterparty and transaction type. Default to the previous
complete calendar month; respect `${input.month}` (YYYY-MM) when provided.
Read-only.

First mint an OAuth2 token. POST to
`https://api-m.paypal.com/v1/oauth2/token` (use `api-m.sandbox.paypal.com`
when `PAYPAL_ENV=sandbox`) with HTTP Basic auth
`PAYPAL_CLIENT_ID:PAYPAL_CLIENT_SECRET`, header
`Content-Type: application/x-www-form-urlencoded`, body
`grant_type=client_credentials`. Read `access_token` from the response.

Then GET the Transaction Search endpoint (max 31-day window, so use the
month's first and last day):

```
GET https://api-m.paypal.com/v1/reporting/transactions
  ?start_date=<YYYY-MM-01T00:00:00-0000>
  &end_date=<YYYY-MM-lastT23:59:59-0000>
  &fields=all&page_size=500&page=1
Authorization: Bearer <access_token>
```

Page through using `page` until `total_pages` is exhausted. From each
`transaction_details[].transaction_info` read `transaction_amount.value`,
`fee_amount.value`, `transaction_initiation_date`,
`transaction_event_code`, and `transaction_status`; counterparty name comes
from `payer_info.payer_name.alternate_full_name` or `email_address`.

Money in = sum of positive `transaction_amount`; money out = sum of
negatives; fees = sum of `fee_amount`; net = in + out + fees.

Output a single JSON object (no preamble, no markdown):

```json
{
  "month": "2026-05",
  "currency": "USD",
  "money_in": 2410.00,
  "money_out": -880.50,
  "fees": -71.40,
  "net": 1458.10,
  "txn_count": 37,
  "by_counterparty": [{"name":"Acme LLC","net":1200.00,"count":3}],
  "by_type": [{"event_code":"T0006","label":"Express checkout payment","net":-540.00,"count":12}]
}
```

Sort `by_counterparty` and `by_type` by absolute `net` descending.

Output:
one JSON object.
