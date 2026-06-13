---
id: sync-inbox
runner: api
trigger: refresh
provider: gmail
op: sync
auth: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET]
outputs:
  - path: data/inbox-${date}.md
    kind: replace
---
Summarize the most recent important Gmail threads (sender, subject, one-line gist,
any action needed). End with a `===SUMMARY===` line stating how many threads were pulled.
