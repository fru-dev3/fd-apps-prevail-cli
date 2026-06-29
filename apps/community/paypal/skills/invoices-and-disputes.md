---
id: invoices-and-disputes
runner: llm
panelist: claude
trigger: refresh
auth: [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV]
inputs: []
outputs:
  - { path: data/invoices/status-${date}.json, kind: replace }
---

# Invoices and disputes

Snapshot outstanding invoices and any open disputes/chargebacks so the
business domain can chase unpaid invoices and respond to cases on time.
Read-only — never create, send, cancel, or resolve anything.

Mint an OAuth2 token: POST `https://api-m.paypal.com/v1/oauth2/token` (use
`api-m.sandbox.paypal.com` when `PAYPAL_ENV=sandbox`) with HTTP Basic auth
`PAYPAL_CLIENT_ID:PAYPAL_CLIENT_SECRET`, `Content-Type:
application/x-www-form-urlencoded`, body `grant_type=client_credentials`.
Read `access_token`. Use `Authorization: Bearer <access_token>` on the
calls below.

1. **Invoices** — `GET
   https://api-m.paypal.com/v2/invoicing/invoices?page_size=100&page=1&total_required=true`.
   Page until all are collected. Per invoice read `id`, `status` (e.g.
   `SENT`, `PAID`, `MARKED_AS_PAID`, `UNPAID`, `PARTIALLY_PAID`, `CANCELLED`),
   `detail.invoice_number`, `detail.currency_code`, `amount.value`,
   `due_amount.value`, `detail.metadata.create_time`,
   `detail.payment_term.due_date`, and the recipient
   `primary_recipients[0].billing_info.name`/`email_address`. Flag any
   non-paid invoice past its `due_date` as overdue.

2. **Disputes** — `GET
   https://api-m.paypal.com/v1/customer/disputes?page_size=50`. Per
   `items[]` read `dispute_id`, `reason`, `status`, `dispute_amount.value`,
   `create_time`, and `seller_response_due_date`.

Output a single JSON object (no preamble, no markdown):

```json
{
  "as_of": "2026-06-29",
  "invoices": {
    "open_count": 4,
    "open_total": 5200.00,
    "overdue_count": 1,
    "items": [{"invoice_number":"INV-1042","status":"SENT","recipient":"Acme LLC","amount":1200.00,"due_amount":1200.00,"due_date":"2026-06-20","overdue":true}]
  },
  "disputes": {
    "open_count": 1,
    "items": [{"dispute_id":"PP-D-123","reason":"MERCHANDISE_OR_SERVICE_NOT_RECEIVED","status":"WAITING_FOR_SELLER_RESPONSE","amount":89.00,"response_due_date":"2026-07-03"}]
  }
}
```

List overdue invoices and disputes with a near `response_due_date` first.
Output: one JSON object.
