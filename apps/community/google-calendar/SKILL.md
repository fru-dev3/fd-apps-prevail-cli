# Google Calendar connector

MCP server-based access to Google Calendar events and free/busy.

## Auth

Authentication is delegated to the MCP server itself — it handles the OAuth
consent flow on first call and caches a refresh token in its own config dir.
The prevail probe just confirms the server binary is reachable on PATH.

## Skills

- `list-events-today` — events on today's primary calendar
- `find-free-time` — find a meeting slot across multiple invitees
- `create-event` — create an event with attendees and a Meet link
