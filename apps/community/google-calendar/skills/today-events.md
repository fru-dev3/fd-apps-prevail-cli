---
id: today-events
runner: api
trigger: refresh
auth: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET]
url: https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=15&timeMin=${now.rfc3339}
method: GET
headers:
  - "Authorization: Bearer ${auth.token}"
  - "Accept: application/json"
save: today-${date}.json
summary_path: summary
---

# Today's events

Pull the next block of events from the primary Google Calendar so the calendar
and chief domains can weave meetings into the daily briefing.

The Google Calendar REST API `events.list` is called with `singleEvents=true`
(recurring series expanded into individual instances), `orderBy=startTime`, and
`timeMin=${now.rfc3339}` so only events from this moment forward are returned.
`maxResults=15` keeps the pull to the rest of today plus a little spillover.

The raw JSON response is saved to `data/today-${date}.json`; each event in
`items[]` carries `start.dateTime`, `summary`, `attendees[]`, `location`, and
`hangoutLink`. The run summary is the calendar name (the `summary` field at the
response root).

Auth: requires a one-time `prevail connectors oauth google-calendar` (PKCE,
scope `calendar.readonly`). The api runner refreshes the access token from the
stored refresh token via `${auth.token}`. Read-only, never creates, edits, or
responds to events.

Output: data/today-${date}.json with the next block of events (start time, title, attendees, location, video link).
