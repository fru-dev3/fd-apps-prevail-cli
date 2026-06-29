---
id: free-time-finder
runner: llm
panelist: claude
trigger: on-demand
after: weekly-overview
auth: []
inputs:
  - { name: day_start, type: string, required: false, description: "working day start, HH:MM (default 09:00)" }
  - { name: day_end, type: string, required: false, description: "working day end, HH:MM (default 17:00)" }
  - { name: min_slot, type: number, required: false, description: "minimum open block in minutes (default 30)" }
outputs:
  - { path: free-time.md, kind: replace }
---

# Free-time finder

Find the open slots in the working week from the synced calendar.

This skill reads the synced events — it does not call the network. Read the
most recent `data/week-*.json` in this connector directory (written by the
`weekly-overview` skill; pick the latest date in the name) and parse `items[]`.

Build the list of busy intervals from each event's `start`/`end`. Use
`start.dateTime`/`end.dateTime` for timed events; treat all-day events (`date`
only) as blocking the whole working day. Ignore events the user has declined
(`attendees[]` where `self: true` and `responseStatus: "declined"`).

For each of the next 7 calendar days, within the working window
(`day_start`–`day_end`, default 09:00–17:00, local time), subtract the busy
intervals and report every remaining gap of at least `min_slot` minutes
(default 30). Skip Saturday and Sunday unless they already contain events.

Output one section per day that has open time:

```
## <Weekday> <YYYY-MM-DD>

- <HH:MM>–<HH:MM> (<N>m free)
- ...
```

End with a one-line total: `Total open: <H>h <M>m across <D> days.` If the
week is fully booked, write `No open slots in the working week.`

Write to `free-time.md`, replacing it each run. No preamble or commentary
outside the slots. Read-only — this only reports availability; it never books.

Output: free-time.md — the open slots per day across the working week, with a total.
