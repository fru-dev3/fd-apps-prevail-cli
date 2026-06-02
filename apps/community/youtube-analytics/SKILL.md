# YouTube Analytics connector

Reads channel metrics via the YouTube Analytics API.

## Auth

OAuth 2.0 — first run opens a browser to Google's consent screen, then
caches a refresh token under `~/.prevail/connectors/youtube-analytics/auth/`.
After that, every sync uses the refresh token to mint a short-lived access
token without prompting.

## Skills

- `sync-channel-metrics` — daily views / watch time / subscribers
- `top-videos-30d` — top performers last 30 days
- `retention-curves` — per-video retention graph data
