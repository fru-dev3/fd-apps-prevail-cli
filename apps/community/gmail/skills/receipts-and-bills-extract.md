---
id: receipts-and-bills-extract
runner: llm
panelist: claude
trigger: refresh
auth: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET]
inputs:
  - { name: days, type: number, required: false, description: "lookback window (default 30)" }
outputs:
  - { path: data/receipts/extracted-${date}.jsonl, kind: replace }
---

# Receipts and bills extract

Find purchase receipts, order confirmations, and bills/invoices in recent
mail and extract structured line items so the wealth and tax domains have a
clean expense feed. Default lookback 30 days; respect `${input.days}`.
Read-only, never label, archive, or reply.

Authenticate with the Gmail REST API using `Authorization: Bearer
${auth.token}` (OAuth access token, scope `gmail.readonly`).

1. Search: `GET
   https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=80&q=<query>`
   where `<query>` is URL-encoded:
   `newer_than:${input.days}d (receipt OR invoice OR "order confirmation" OR "your bill" OR "payment received" OR statement) -category:promotions`.
2. For each message, fetch `GET
   .../users/me/messages/<id>?format=full`, read From/Subject/Date headers,
   and decode the `text/plain` part (base64url) of the payload; fall back to
   the `snippet` if no plain part.

From each, extract: merchant/biller, total amount + currency, order/invoice
number, purchase or due date, and a 1-3 word category guess (e.g.
`software`, `utilities`, `groceries`, `travel`). Skip marketing mail with no
real transaction. Do not invent values, omit fields you cannot find.

Output one JSON object per line (JSONL, no preamble, no markdown):

```json
{"date":"2026-06-12","merchant":"GitHub","amount":21.00,"currency":"USD","doc_type":"receipt","ref":"INV-88231","category":"software","message_id":"18f..."}
```

`doc_type` is one of `receipt`, `invoice`, `bill`, `statement`.

Output: pure
JSONL, one row per transaction.
