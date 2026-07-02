---
id: sync-calendar-browser
runner: browser-agent
trigger: refresh
favorite: true
method: browser
capability: today-events
session: profile
start_url: https://calendar.google.com/calendar/u/0/r/week
domain_allow: [calendar.google.com, accounts.google.com]
success_url_contains: calendar.google.com/calendar
goal: Open Google Calendar in the logged-in session and read the next 7 days of events, capturing title, date, start and end time, location, and attendees. Read-only: never create, move, edit, or delete an event.
outputs:
  - { path: data/calendar-${date}.json, kind: replace }
---
# Sync calendar (browser, favorite)

Read the upcoming week from Google Calendar using the logged-in browser session,
no API key required. Falls through to the API method when the browser is blocked.

Read-only. Capture title, date, start and end, location, and attendees for the
next 7 days, then write a normalized JSON document to data/. Never create, edit,
move, respond to, or delete an event.
