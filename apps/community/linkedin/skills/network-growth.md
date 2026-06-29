---
id: network-growth
runner: browser-agent
trigger: refresh
goal: "Read my LinkedIn network size: total connections and total followers, plus how many pending connection invitations are waiting, so I can track network growth over time."
domain_allow: [linkedin.com]
start_url: https://www.linkedin.com/mynetwork/
success_url_contains: mynetwork
record_as: network-growth-replay
auth: []
outputs:
  - { path: network-growth.md, kind: markdown }
---

# Network growth

Browser-agent skill: an LLM drives the logged-in Chrome session to read your
network counts, then records a replay (`network-growth-replay`) for future
weekly refreshes. Read-only — navigate and read only; never accept, send, or
withdraw invitations and never follow/unfollow.

Start at the My Network page (`https://www.linkedin.com/mynetwork/`). If a
login wall appears, pause for the human to sign in. Read:

1. **Connections** — the total connection count (open the "Connections"
   manager link if the count is not shown on the landing page).
2. **Followers** — the total follower count (from the network dashboard or
   your profile's analytics row).
3. **Pending invitations** — the number of incoming connection invitations
   waiting in the "Invitations" / "Manage" view.

Summarize as a dated section appended to `network-growth.md`:

```
## <YYYY-MM-DD>

- Connections: <N>
- Followers: <N>
- Pending invitations: <N>
```

`kind: markdown`, so each weekly run appends a new dated snapshot — the brand
and career domains diff consecutive snapshots to compute growth. Put the three
numbers in the agent's done-summary so growth is tracked even before the
replay is recorded.

Output: a dated section in network-growth.md with connections, followers, and pending invitation counts.
