---
id: sync-feed-browser
runner: browser-agent
trigger: refresh
favorite: true
method: browser
capability: profile-views-trend
session: profile
start_url: https://www.linkedin.com/feed/
domain_allow: [www.linkedin.com, linkedin.com]
success_url_contains: linkedin.com/feed
goal: Open LinkedIn in the logged-in session and capture recent notifications, profile view count, and the performance of your own recent posts (impressions, reactions, comments). Read-only: never post, react, comment, connect, or message.
outputs:
  - { path: data/linkedin-activity-${date}.json, kind: replace }
---
# Sync LinkedIn activity (browser, favorite)

LinkedIn offers no civilian API, so browser automation over the logged-in
session is the primary and favorite method. The MCP/API variant only applies if
the user has approved partner API access, so browser leads here by design.

Read-only. Capture notifications, profile views, and recent post performance,
then write a normalized JSON document to data/. Never post, react, comment,
connect, or message.
