---
id: repo-stars-trend
runner: llm
panelist: claude
trigger: cron("0 8 * * 1")
auth: [GH_TOKEN]
inputs: []
outputs:
  - { path: stars-trend.md, kind: markdown }
---

# Repo stars trend

Once a week, capture star counts for every repo I own. Append a timestamped
section to `stars-trend.md` so over time it becomes a chart-able history.

Use `GH_TOKEN` to authenticate. Hit
`GET https://api.github.com/user/repos?per_page=100&affiliation=owner` and
collect `name` + `stargazers_count` for each.

Output ONLY the table — the runner will prepend the timestamp header.

```
| repo | ⭐ stars |
|---|---|
| my-project | 142 |
| ... |
```

Sort by stars descending. Skip forks.
