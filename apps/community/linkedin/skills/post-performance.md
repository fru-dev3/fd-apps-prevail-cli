---
id: post-performance
runner: browser-agent
trigger: refresh
goal: "Read the analytics for my recent LinkedIn posts: for each of the latest ~10 posts capture impressions, reactions, comments, reposts, and the post's first line so I can see which content earned its reach."
domain_allow: [linkedin.com]
start_url: https://www.linkedin.com/in/me/recent-activity/all/
success_url_contains: recent-activity
record_as: post-performance-replay
auth: []
outputs:
  - { path: post-performance.md, kind: markdown }
---

# Post performance

Browser-agent skill: an LLM drives the logged-in Chrome session to read the
analytics on your own recent LinkedIn posts, then records a replay
(`post-performance-replay`) for future refreshes. Read-only, navigate and
read only; never like, comment, repost, edit, or delete.

Start at your activity feed
(`https://www.linkedin.com/in/me/recent-activity/all/`). If a login wall
appears, pause for the human to sign in.

For each of the latest ~10 posts you authored, read the engagement surface
shown under the post (and the "View analytics" / impressions count where
LinkedIn exposes it):

- **Impressions** (views), the headline reach number.
- **Reactions** (likes + other reactions, total).
- **Comments**.
- **Reposts**.
- The post's **first line** (≤60 chars, truncate with …) and its relative age.

Summarize as a dated section appended to `post-performance.md`:

```
## <YYYY-MM-DD>

| posted | first line | impressions | reactions | comments | reposts |
|---|---|---|---|---|---|
| 3d | … | … | … | … | … |
```

Sort newest first. Below the table add one line:
`Top by impressions: "<first line>", <N> impressions.`

`kind: markdown`, so each run appends a new dated snapshot. Carry the table in
the agent's done-summary so the data is captured even before the replay is
recorded.

Output: a dated section in post-performance.md, a table of the latest ~10 posts with impressions, reactions, comments, and reposts.
