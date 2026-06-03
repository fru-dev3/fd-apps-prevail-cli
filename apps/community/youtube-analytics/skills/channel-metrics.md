---
id: channel-metrics
runner: llm
panelist: claude
trigger: cron("0 7 * * *")
auth: [PREVAIL_GOOGLE_CLIENT_ID, PREVAIL_GOOGLE_CLIENT_SECRET]
inputs:
  - { name: days, type: number, required: false, description: "lookback window (default 7)" }
outputs:
  - { path: channel-metrics.md, kind: markdown }
---

# Daily channel metrics

Pull the last N days of channel performance from the YouTube Analytics API.

Auth: read the OAuth refresh token from
`~/.prevail/connectors/youtube-analytics/auth/refresh.token`, then exchange
it for an access token via `https://oauth2.googleapis.com/token` using
`PREVAIL_GOOGLE_CLIENT_ID` + `PREVAIL_GOOGLE_CLIENT_SECRET`.

Then call:

```
GET https://youtubeanalytics.googleapis.com/v2/reports
  ?ids=channel==MINE
  &startDate=<today - days>
  &endDate=<today>
  &metrics=views,watchTime,subscribersGained,averageViewDuration
  &dimensions=day
```

Output a markdown table:

```
| date | views | watch (hr) | subs Δ | avg view (sec) |
|---|---|---|---|---|
| ... |
```

Append (`kind: markdown`), so each run adds a new dated section.

No preamble, no commentary outside the table.
