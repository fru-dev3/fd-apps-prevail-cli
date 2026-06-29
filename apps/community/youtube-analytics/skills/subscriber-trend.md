---
id: subscriber-trend
runner: llm
panelist: claude
trigger: refresh
auth: [PREVAIL_GOOGLE_CLIENT_ID, PREVAIL_GOOGLE_CLIENT_SECRET]
inputs:
  - { name: days, type: number, required: false, description: "lookback window in days (default 30)" }
outputs:
  - { path: subscriber-trend.md, kind: markdown }
---

# Subscriber trend

Track subscriber gains and losses over the last N days so the brand domain can
see whether the channel is net-growing and which days moved the needle.

Auth: read the refresh token from
`~/.prevail/connectors/youtube-analytics/auth/refresh.token`, exchange it for
an access token at `https://oauth2.googleapis.com/token` using
`PREVAIL_GOOGLE_CLIENT_ID` + `PREVAIL_GOOGLE_CLIENT_SECRET`, and bearer-auth
the call.

Query daily subs movement (dates `YYYY-MM-DD`, `startDate` = today − `days`,
default 30):

```
GET https://youtubeanalytics.googleapis.com/v2/reports
  ?ids=channel==MINE
  &startDate=<today - days>&endDate=<today>
  &metrics=subscribersGained,subscribersLost
  &dimensions=day
  &sort=day
```

Compute per-day net (`gained − lost`) and a running cumulative net across the
window. Output a markdown table:

```
| date | gained | lost | net | cumulative |
|---|---|---|---|---|
| ... |
```

End with one line:
`Net over <days>d: <±N> subs (gained <G>, lost <L>); best day <date> +<X>.`

`kind: markdown`, so each run appends a new dated section. Read-only. No
preamble or commentary outside the table and summary line.

Output: a dated markdown table of daily subscriber gains/losses with net and cumulative, plus a summary line.
