---
id: stale-pr-nudge-list
runner: llm
panelist: claude
trigger: on-demand
auth: [GH_TOKEN]
inputs:
  - { name: stale_days, type: number, required: false, description: "min days since last update to count as stale (default 3)" }
outputs:
  - { path: data/pr-nudges/stale-${date}.md, kind: replace }
---

# Stale PR nudge list

List open PRs that have gone quiet — mine waiting on others, and others'
waiting on my review — so I know exactly what to nudge or unblock. A PR is
stale when its last update is older than `${input.stale_days}` (default 3).
Read-only — never comment, merge, or close.

Authenticate with `GH_TOKEN` (header `Authorization: Bearer <GH_TOKEN>`,
`Accept: application/vnd.github+json`). Resolve my login via
`GET https://api.github.com/user`. Then query the Search API (`GET
https://api.github.com/search/issues?q=<q>&sort=updated&order=asc&per_page=100`):

- Mine: `is:pr is:open author:<login>`
- To review: `is:pr is:open review-requested:<login>`

Keep only items whose `updated_at` is older than `now - stale_days`. For
each, derive `owner/repo` from `repository_url`, and read `number`,
`title`, `html_url`, `updated_at`, `draft`, and `comments`. Compute age
since last update.

Output markdown only (no preamble):

```
# Stale PRs (>3d quiet) — 2026-06-29

**Mine — waiting on others (N)**
- owner/repo #42 — title _(stale 6d · 0 comments)_
**To review — waiting on me (N)**
- owner/repo #58 — title _(stale 9d)_

_Oldest: owner/repo #58, quiet 9d_
```

Sort each section by staleness (oldest first). Mark drafts with `[draft]`.
Truncate titles to ~60 chars.

Output: the nudge-list markdown.
