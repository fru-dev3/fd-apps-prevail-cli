---
id: sync-feed-api
runner: api
trigger: on-demand
capability: profile-views-trend
auth: [LINKEDIN_ACCESS_TOKEN]
url: https://api.linkedin.com/v2/me
method: GET
headers:
  - "Authorization: Bearer ${env.LINKEDIN_ACCESS_TOKEN}"
  - "X-Restli-Protocol-Version: 2.0.0"
save: linkedin-activity-${date}.json
---
# Sync LinkedIn activity (API fallback)

Headless fallback for the sync-feed capability. Access method derives from
`runner: api`; `method: GET` is the HTTP verb. Only usable if the user holds a
LinkedIn API token (LINKEDIN_ACCESS_TOKEN); most members will not, which is why
the browser method is the favorite. Read-only GET against the member endpoint.
