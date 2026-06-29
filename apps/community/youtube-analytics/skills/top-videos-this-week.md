---
id: top-videos-this-week
runner: llm
panelist: claude
trigger: refresh
auth: [PREVAIL_GOOGLE_CLIENT_ID, PREVAIL_GOOGLE_CLIENT_SECRET]
inputs:
  - { name: days, type: number, required: false, description: "lookback window in days (default 7)" }
  - { name: limit, type: number, required: false, description: "how many videos to rank (default 10)" }
outputs:
  - { path: top-videos.md, kind: replace }
---

# Top videos this week

Rank the channel's best-performing videos over the last N days so the content
domain knows what to lean into.

Auth: read the refresh token from
`~/.prevail/connectors/youtube-analytics/auth/refresh.token`, exchange it for
an access token at `https://oauth2.googleapis.com/token` using
`PREVAIL_GOOGLE_CLIENT_ID` + `PREVAIL_GOOGLE_CLIENT_SECRET`, and send it as a
bearer token on every call.

Step 1 — rank by views (dates `YYYY-MM-DD`, `startDate` = today − `days`,
default 7; `limit` default 10):

```
GET https://youtubeanalytics.googleapis.com/v2/reports
  ?ids=channel==MINE
  &startDate=<today - days>
  &endDate=<today>
  &metrics=views,estimatedMinutesWatched,averageViewPercentage,subscribersGained
  &dimensions=video
  &sort=-views
  &maxResults=<limit>
```

Step 2 — resolve titles for the returned video IDs (the analytics API returns
IDs, not titles):

```
GET https://www.googleapis.com/youtube/v3/videos?part=snippet&id=<id1,id2,...>
```

Match each `video` row to its `snippet.title`. Convert
`estimatedMinutesWatched` to hours (÷60, one decimal). Output a single table,
highest views first:

```
| # | title | views | watch (hr) | avg viewed % | subs gained |
|---|---|---|---|---|---|
| 1 | … | … | … | … | … |
```

Truncate titles to 50 chars with …. Below the table add one line:
`Top: "<title>" — <N> views over <days>d.`

Replace `top-videos.md` each run. Read-only. No preamble or commentary outside
the table and summary line.

Output: top-videos.md — a ranked table of the channel's top videos over the window (views, watch hours, avg viewed %, subs gained).
