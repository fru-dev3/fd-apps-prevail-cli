---
id: sync-activity-api
runner: api
trigger: on-demand
capability: repo-stars-trend
auth: [GH_TOKEN]
url: https://api.github.com/notifications?per_page=50
method: GET
headers:
  - "Authorization: Bearer ${env.GH_TOKEN}"
  - "Accept: application/vnd.github+json"
  - "X-GitHub-Api-Version: 2022-11-28"
save: github-activity-${date}.json
---
# Sync GitHub activity (API fallback)

Headless fallback for the sync-activity capability. Access method derives from
`runner: api`; `method: GET` is the HTTP verb. Pulls notifications via the GitHub
REST API using a personal access token in GH_TOKEN (scopes: notifications, repo).
Read-only GET. Preferred fallback when the favorite browser method cannot run.
