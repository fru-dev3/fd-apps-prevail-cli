---
id: sync-calendar-api
runner: api
trigger: on-demand
capability: today-events
auth: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET]
url: https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=50&singleEvents=true&orderBy=startTime&timeMin=${ts}
method: GET
headers:
  - "Authorization: Bearer ${auth.token}"
  - "Accept: application/json"
save: calendar-${date}.json
summary_path: summary
---
# Sync calendar (API fallback)

Headless fallback for the sync-calendar capability. Access method is derived
from `runner: api`; the `method: GET` key is the HTTP verb the http runner uses.
Pulls upcoming events from the Google Calendar API once a one-time
`prevail connectors oauth google-calendar` has stored a refresh token; the http
runner refreshes the access token via ${auth.token}. Read-only GET.
