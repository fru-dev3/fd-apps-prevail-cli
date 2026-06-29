---
id: recurring-detect
runner: llm
panelist: claude
trigger: on-demand
auth: [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV]
inputs:
  - { name: months, type: number, required: false, description: "lookback in months (default 6, max 12)" }
outputs:
  - { path: data/recurring/detected-${date}.json, kind: replace }
---

# Recurring payment detection

Detect recurring PayPal charges (subscriptions and repeat billers) by
clustering transactions to the same counterparty at a regular cadence over
the last several months. Default lookback 6 months (cap at 12); respect
`${input.months}`. Read-only.

Mint an OAuth2 token: POST `https://api-m.paypal.com/v1/oauth2/token` (use
`api-m.sandbox.paypal.com` when `PAYPAL_ENV=sandbox`) with HTTP Basic auth
`PAYPAL_CLIENT_ID:PAYPAL_CLIENT_SECRET`, `Content-Type:
application/x-www-form-urlencoded`, body `grant_type=client_credentials`.
Read `access_token`.

The Transaction Search API caps each call at a 31-day window, so iterate
month by month across the lookback, calling:

```
GET https://api-m.paypal.com/v1/reporting/transactions
  ?start_date=<window start>&end_date=<window end>
  &fields=all&page_size=500&page=<n>
Authorization: Bearer <access_token>
```

Collect outgoing payments only (negative `transaction_amount.value`). Group
by counterparty (`payer_info` name / `email_address`) plus rounded amount.
A group is **recurring** when it has 3+ charges with a roughly consistent
interval (monthly ≈ 28-31d, weekly ≈ 7d, annual ≈ 365d) and stable amount
(within ~10%).

For each recurring group estimate `frequency`, `average_amount`,
`last_charge_date`, and `predicted_next_date`.

Output a single JSON object (no preamble, no markdown):

```json
{
  "as_of": "2026-06-29",
  "lookback_months": 6,
  "estimated_monthly_total": 84.97,
  "recurring": [
    {"counterparty":"Spotify","frequency":"MONTHLY","average_amount":-10.99,"charge_count":6,"last_charge_date":"2026-06-08","predicted_next_date":"2026-07-08"}
  ]
}
```

Sort `recurring` by monthly-equivalent cost descending.

Output: one JSON
object.
