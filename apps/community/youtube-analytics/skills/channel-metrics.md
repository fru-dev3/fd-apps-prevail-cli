---
id: channel-metrics
runner: llm
panelist: claude
trigger: refresh
auth: [PREVAIL_GOOGLE_CLIENT_ID, PREVAIL_GOOGLE_CLIENT_SECRET]
inputs:
  - { name: days, type: number, required: false, description: "lookback window in days (default 7)" }
outputs:
  - { path: channel-metrics.md, kind: markdown }
---

# Daily channel metrics

Pull the last N days of channel performance from the YouTube Analytics API so
the content and brand domains can track which days earned reach.

Auth: read the OAuth refresh token from
`~/.prevail/connectors/youtube-analytics/auth/refresh.token`, then exchange it
for an access token at `https://oauth2.googleapis.com/token`
(`grant_type=refresh_token`) using `PREVAIL_GOOGLE_CLIENT_ID` +
`PREVAIL_GOOGLE_CLIENT_SECRET`. Send `Authorization: Bearer <access_token>`.

Then call (dates as `YYYY-MM-DD`, `startDate` = today − `days`, default 7):

```
GET https://youtubeanalytics.googleapis.com/v2/reports
  ?ids=channel==MINE
  &startDate=<today - days>
  &endDate=<today>
  &metrics=views,estimatedMinutesWatched,subscribersGained,subscribersLost,averageViewDuration
  &dimensions=day
  &sort=day
```

`rows[]` come back column-ordered to match `metrics`. Convert
`estimatedMinutesWatched` to hours (÷60, one decimal) and compute net subs as
`subscribersGained − subscribersLost`. Output a markdown table:

```
| date | views | watch (hr) | subs Δ | avg view (sec) |
|---|---|---|---|---|
| ... |
```

End with one line: `Totals: <V> views · <H>h watched · <±S> subs over <days>d.`

`kind: markdown`, so each run appends a new dated section. Read-only, query
reports only. No preamble or commentary outside the table and totals line.

Output: a dated markdown table of daily channel metrics (views, watch hours, net subs, avg view duration) plus a totals line.
