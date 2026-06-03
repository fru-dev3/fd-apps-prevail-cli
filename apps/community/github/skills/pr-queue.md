---
id: pr-queue
runner: llm
panelist: claude
trigger: on-demand
auth: [GH_TOKEN]
inputs:
  - { name: scope, type: string, required: false, description: "owned|review-requested|all" }
outputs:
  - { path: pr-queue.md, kind: replace }
---

# PR queue

Fetch the open pull requests that need my attention. Three scopes:

- `owned` — PRs I authored that are still open
- `review-requested` — PRs where I'm requested as a reviewer
- `all` (default) — both

Use the GitHub REST API with the `GH_TOKEN` environment variable. Hit
`GET https://api.github.com/search/issues` with:

- `q=is:pr is:open author:@me` for owned
- `q=is:pr is:open review-requested:@me` for review-requested

Output a single markdown table:

```
| repo | # | title | who | age |
|---|---|---|---|---|
| ... |
```

Sort by age (oldest first — those are the most urgent). One row per PR.
Age formatted as "3d", "2w", "1mo". Keep titles under 60 chars (truncate
with …).

Below the table, add a one-line summary: "N owned · M to review · oldest
is X days".

Do not include any preamble, explanation, or commentary outside the table
and the summary line.
