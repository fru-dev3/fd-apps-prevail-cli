---
id: important-unread-digest
runner: llm
panelist: claude
trigger: refresh
auth: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET]
inputs:
  - { name: days, type: number, required: false, description: "lookback window (default 3)" }
outputs:
  - { path: data/digests/important-unread-${date}.md, kind: replace }
---

# Important unread digest

Build a short, scannable digest of important unread mail from the last few
days so a briefing can lead with what actually needs attention. Default
lookback 3 days; respect `${input.days}`. Read-only — never label, archive,
mark read, or reply.

Authenticate with the Gmail REST API using `Authorization: Bearer
${auth.token}` (a fresh OAuth access token the engine mints from the saved
refresh token; scope `gmail.readonly`).

1. List candidates: `GET
   https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=40&q=is:unread%20is:important%20newer_than:${input.days}d`
   (default `newer_than:3d`).
2. For each `messages[].id`, fetch metadata only: `GET
   .../users/me/messages/<id>?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`.
   Read the headers plus the message `snippet`.

Rank by urgency using sender and subject/snippet cues (deadlines, payments,
security alerts, direct questions, replies to me outrank newsletters and
promotions). Group into **Action needed**, **FYI**, and **Low priority**.

Output markdown only (no preamble):

```
# Important unread — 2026-06-29 (last 3d)

**Action needed**
- **From** — Subject _(received)_ — one-line why it matters
**FYI**
- ...
**Low priority**
- ...

_N unread important · X need action_
```

Keep each line under ~100 chars.

Output: the digest markdown.
