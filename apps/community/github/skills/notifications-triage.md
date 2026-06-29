---
id: notifications-triage
runner: llm
panelist: claude
trigger: refresh
auth: [GH_TOKEN]
inputs:
  - { name: all, type: boolean, required: false, description: "include already-read notifications (default false)" }
outputs:
  - { path: data/notifications/triage-${date}.md, kind: replace }
---

# Notifications triage

Sort my unread GitHub notifications into action buckets so I can clear the
inbox fast. Read-only — never mark as read or unsubscribe.

Authenticate with `GH_TOKEN` (header `Authorization: Bearer <GH_TOKEN>`,
`Accept: application/vnd.github+json`). Fetch:

```
GET https://api.github.com/notifications?per_page=100&all=${input.all}
```

(`all` defaults to `false` — unread only.) For each notification read
`reason`, `subject.title`, `subject.type` (Issue / PullRequest / Release /
etc.), `subject.url`, `repository.full_name`, and `updated_at`. Derive the
human URL from the repo + subject (e.g. issue/PR number from the API url's
trailing segment).

Bucket by `reason`:
- **Mentions & reviews** — `mention`, `review_requested`, `assign`
- **My threads** — `author`, `comment`, `team_mention`
- **Subscribed / CI** — `subscribed`, `ci_activity`, `state_change`
- **Everything else**

Output markdown only (no preamble):

```
# Notifications triage — 2026-06-29

**Mentions & reviews (N)**
- owner/repo #123 — title _(reason, 2h ago)_
**My threads (N)**
- ...
**Subscribed / CI (N)**
- ...

_N unread · X need a reply or review_
```

Within each bucket sort oldest `updated_at` first. Truncate titles to ~60
chars.

Output: the triage markdown.
