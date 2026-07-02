---
id: weekly-contribution-summary
runner: llm
panelist: claude
trigger: refresh
auth: [GH_TOKEN]
inputs:
  - { name: days, type: number, required: false, description: "lookback window (default 7)" }
outputs:
  - { path: data/contributions/weekly-${date}.md, kind: replace }
---

# Weekly contribution summary

Recap what I shipped on GitHub over the last week, PRs opened and merged,
issues closed, and review activity, for a status update or self-review.
Default lookback 7 days; respect `${input.days}`. Read-only.

Authenticate with `GH_TOKEN` (header `Authorization: Bearer <GH_TOKEN>`,
`Accept: application/vnd.github+json`). First resolve my login via
`GET https://api.github.com/user` (read `login`). Let `<since>` be
`today - days` (ISO date). Then run these Search API queries (`GET
https://api.github.com/search/issues?q=<q>&per_page=100`):

- PRs opened: `is:pr author:<login> created:>=<since>`
- PRs merged: `is:pr author:<login> is:merged merged:>=<since>`
- Issues closed by me: `is:issue assignee:<login> is:closed closed:>=<since>`
- Reviews given: `is:pr reviewed-by:<login> -author:<login> updated:>=<since>`

From each result item read `repository_url` (derive `owner/repo`),
`number`, `title`, `html_url`, and `pull_request.merged_at` where present.

Output markdown only (no preamble):

```
# Contributions, week ending 2026-06-29

**Merged (N)**
- owner/repo #42, title
**Opened (N)**
- ...
**Issues closed (N)**
- ...
**Reviews (N)**
- owner/repo #58, title

_N merged · M opened · K reviews across R repos_
```

Group by bucket, then by repo. De-dupe items that appear in multiple
buckets (prefer Merged over Opened).

Output: the summary markdown.
