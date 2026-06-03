---
id: profile-views
runner: browser
panelist: claude
trigger: cron("0 9 * * *")
auth: []
inputs: []
outputs:
  - { path: profile-views.md, kind: markdown }
---

# Daily profile views

⚠ **runner: browser** — not yet implemented. Lands in v0.6 phase 6 (Playwright executor).

When phase 6 ships, this skill will:

1. Open Chrome with your existing LinkedIn session (no API token needed).
2. Visit `https://www.linkedin.com/me/profile-views/`.
3. Scrape the daily view count + the list of recent viewers.
4. Append a markdown section with today's snapshot.

The browser runner uses Playwright with the `--use-data-dir` flag pointed at
your existing Chrome profile so you stay logged in — LinkedIn enforces a
~30-day session cookie, so as long as you visit linkedin.com in your browser
once a month, this skill stays connected.

Until then, do this manually and paste the count into `state.md`.
