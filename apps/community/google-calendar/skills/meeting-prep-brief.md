---
id: meeting-prep-brief
runner: llm
panelist: claude
trigger: on-demand
after: today-events
auth: []
inputs:
  - { name: limit, type: number, required: false, description: "max meetings to brief (default 5)" }
outputs:
  - { path: meeting-prep.md, kind: replace }
---

# Meeting prep brief

Turn today's calendar into a short prep brief for each upcoming meeting.

This skill reads the synced events, it does not call the network. Read the
most recent `data/today-*.json` in this connector directory (the file written
by the `today-events` skill; pick the one with the latest date in the name).
Parse `items[]`.

Keep only events that:

- start later than now (skip anything already finished), and
- have more than one attendee OR a `hangoutLink`/`location` (skip solo holds
  and focus blocks).

Take the first `limit` (default 5) by start time. For each, write a brief:

```
## <HH:MM>–<HH:MM> · <title>

- Who: <attendee display names / emails, organizer marked ★>
- Where: <location or video link, "-" if none>
- Agenda: <one line distilled from the event description, "-" if blank>
- Prep: <one concrete prep suggestion, e.g. "review last thread with <name>">
```

Order earliest first. If no qualifying meetings remain today, write a single
line: `No meetings need prep, the rest of today is clear.`

Replace `meeting-prep.md` each run. No preamble or commentary outside the
briefs. Read-only, never propose creating, editing, or declining events.

Output: meeting-prep.md, a short prep brief for each of today's upcoming meetings.
