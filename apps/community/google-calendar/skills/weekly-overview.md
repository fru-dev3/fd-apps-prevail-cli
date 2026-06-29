---
id: weekly-overview
runner: api
trigger: refresh
auth: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET]
url: https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=50&timeMin=${now.rfc3339}
method: GET
headers:
  - "Authorization: Bearer ${auth.token}"
  - "Accept: application/json"
save: week-${date}.json
summary_path: summary
---

# Weekly overview

Pull the upcoming week of events from the primary Google Calendar so the
chief domain can frame the week ahead — load, recurring commitments, and any
clustering of meetings.

Calls `events.list` with `singleEvents=true`, `orderBy=startTime`, and
`timeMin=${now.rfc3339}`. `maxResults=50` covers a full forward week for most
calendars (the result is already start-time ordered, so the early items are
the soonest). The Calendar API token tokens are relative-from-now, so this is
a rolling "next N events" window rather than a hard 7-day cutoff — downstream
skills (see `free-time-finder`) trim it to the working week.

The raw JSON is saved to `data/week-${date}.json`. Each `items[]` entry carries
`start`/`end` (`dateTime` for timed events, `date` for all-day), `summary`,
`attendees[]`, and `recurringEventId`. The run summary is the calendar name.

Auth: a one-time `prevail connectors oauth google-calendar` (scope
`calendar.readonly`); the access token is refreshed via `${auth.token}`.
Read-only.

Output: data/week-${date}.json with the upcoming week of events (start/end, title, attendees, recurrence).
