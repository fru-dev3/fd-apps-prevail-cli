---
id: travel-confirmations-extract
runner: llm
panelist: claude
trigger: refresh
auth: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET]
inputs:
  - { name: days, type: number, required: false, description: "lookback window for booking emails (default 120)" }
outputs:
  - { path: data/travel/itinerary-${date}.json, kind: replace }
---

# Travel confirmations extract

Pull flight, hotel, rail, and car-rental confirmations from recent mail into
a forward-looking itinerary so calendar and briefings know about upcoming
trips. Default lookback 120 days of booking emails (trips are often booked
well ahead); respect `${input.days}`. Read-only — never label or reply.

Authenticate with the Gmail REST API using `Authorization: Bearer
${auth.token}` (OAuth access token, scope `gmail.readonly`).

1. Search: `GET
   https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=60&q=<query>`
   with URL-encoded query:
   `newer_than:${input.days}d (flight OR itinerary OR "booking confirmation" OR reservation OR "e-ticket" OR "check-in" OR boarding) (from:(confirmation OR reservations OR booking) OR subject:(confirmation OR itinerary OR reservation))`.
2. For each message fetch `format=full`, read headers, and decode the
   `text/plain` part (base64url); fall back to `snippet`.

Extract per booking: `type` (`flight`/`hotel`/`rail`/`car`), provider,
confirmation/record-locator code, start datetime, end datetime, origin and
destination (or city/property), and total cost if shown. For flights capture
each segment (carrier, flight number, depart/arrive airports + times). Do
not invent values — omit unknown fields.

Only include trips whose start date is today or later (future/in-progress).

Output a single JSON object (no preamble, no markdown):

```json
{
  "as_of": "2026-06-29",
  "trips": [
    {"type":"flight","provider":"United","confirmation":"ABC123","start":"2026-07-10T08:15:00","end":"2026-07-10T11:40:00","origin":"SFO","destination":"JFK","cost":318.40,"currency":"USD","segments":[{"carrier":"UA","flight":"UA512","from":"SFO","to":"JFK","depart":"2026-07-10T08:15:00","arrive":"2026-07-10T16:40:00"}],"message_id":"18f..."}
  ]
}
```

Sort `trips` by `start` ascending.

Output: one JSON object.
