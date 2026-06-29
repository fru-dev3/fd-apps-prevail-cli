---
id: profile-views-trend
runner: browser-agent
trigger: refresh
goal: "Read my LinkedIn profile-views analytics and capture the trend: total views over the last 90 days, the week-over-week change, and the most recent named viewers with their headlines."
domain_allow: [linkedin.com]
start_url: https://www.linkedin.com/me/profile-views/
success_url_contains: profile-views
record_as: profile-views-trend-replay
auth: []
outputs:
  - { path: profile-views.md, kind: markdown }
---

# Profile views trend

LinkedIn gives civilians no analytics API, so this runs as a browser-agent
skill: an LLM drives a real Chrome window using the existing logged-in
LinkedIn session (persistent profile), reads the page, and records a
deterministic replay (`profile-views-trend-replay`) for future refreshes.
Read-only — only navigate and read; never connect, message, post, or click
anything that changes state.

Navigate to `https://www.linkedin.com/me/profile-views/` (the
"Who's viewed your profile" analytics page). If a login wall appears, pause
for the human to sign in — LinkedIn enforces a ~30-day session, so visiting
linkedin.com in the browser once a month keeps this connected.

Read from the page:

1. **Total profile views** over the default window (90 days) and the
   percentage change LinkedIn shows vs. the previous period.
2. **Views in the last 7 days** if a weekly figure is shown.
3. The **recent viewers** list — for each visible viewer, the display name
   (or "LinkedIn Member" if anonymized) and their headline.

Summarize as a dated markdown section appended to `profile-views.md`:

```
## <YYYY-MM-DD>

- Views (90d): <N> (<±%> vs prior period)
- Views (7d): <N>
- Recent viewers:
  - <name> — <headline>
  - ...
```

`kind: markdown`, so every weekly run appends a new dated snapshot, building a
trend the brand and career domains can read. Put the numbers in the agent's
done-summary so the trend is captured even before the replay is recorded.

Output: a dated section in profile-views.md with 90-day and 7-day view totals, the period change, and recent viewers.
