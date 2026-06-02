# GitHub connector

REST API access to repos, PRs, issues, and notifications.

## Auth

Personal access token (PAT). Generate at
`github.com/settings/tokens` with `user`, `repo`, `notifications` scope.
Set as `GH_TOKEN` in your shell.

The probe hits `GET https://api.github.com/user` — a 200 means the token
is valid; a 401 means it's expired or revoked.

## Skills

- `pr-queue` — open PRs assigned to or authored by you
- `notifications-unread` — unread notification count
- `repo-stars-trend` — star-count delta last 7 days per owned repo
