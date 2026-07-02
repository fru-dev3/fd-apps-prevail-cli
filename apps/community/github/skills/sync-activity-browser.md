---
id: sync-activity-browser
runner: browser-agent
trigger: refresh
favorite: true
method: browser
capability: repo-stars-trend
session: profile
start_url: https://github.com/notifications
domain_allow: [github.com]
success_url_contains: github.com
goal: Open GitHub in the logged-in session and capture current notifications and the open pull request queue (title, repo, author, state, age). Read-only: never merge, close, comment, or change any setting.
outputs:
  - { path: data/github-activity-${date}.json, kind: replace }
---
# Sync GitHub activity (browser, favorite)

Read notifications and the open PR queue using the user's logged-in browser
session, no token required. Falls through to the REST API method when the
browser is blocked or unavailable.

Read-only. Capture notifications and open PRs (title, repo, author, state, age)
and write a normalized JSON document to data/. Never merge, close, comment,
review, or change settings.
