---
id: retention-and-watchtime
runner: llm
panelist: claude
trigger: on-demand
auth: [PREVAIL_GOOGLE_CLIENT_ID, PREVAIL_GOOGLE_CLIENT_SECRET]
inputs:
  - { name: video_id, type: string, required: false, description: "specific videoId; if omitted, uses the top video by views over the window" }
  - { name: days, type: number, required: false, description: "lookback window in days (default 28)" }
outputs:
  - { path: retention.md, kind: replace }
---

# Retention and watch time

Read the audience-retention curve and watch-time for a single video so the
content domain can see where viewers drop off.

Auth: read the refresh token from
`~/.prevail/connectors/youtube-analytics/auth/refresh.token`, exchange it for
an access token at `https://oauth2.googleapis.com/token` using
`PREVAIL_GOOGLE_CLIENT_ID` + `PREVAIL_GOOGLE_CLIENT_SECRET`, and bearer-auth
every call.

Pick the target video: use `video_id` if provided; otherwise query the most-
viewed video over the window (`dimensions=video&sort=-views&maxResults=1`,
`startDate` = today − `days`, default 28) and take that ID. Resolve its title
via `GET https://www.googleapis.com/youtube/v3/videos?part=snippet&id=<id>`.

Watch-time + summary metrics for the video:

```
GET https://youtubeanalytics.googleapis.com/v2/reports
  ?ids=channel==MINE
  &startDate=<today - days>&endDate=<today>
  &metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage
  &filters=video==<id>
```

Relative retention curve (sampled across the video's length):

```
GET https://youtubeanalytics.googleapis.com/v2/reports
  ?ids=channel==MINE
  &startDate=<today - days>&endDate=<today>
  &metrics=audienceWatchRatio,relativeRetentionPerformance
  &dimensions=elapsedVideoTimeRatio
  &filters=video==<id>
```

Output:

```
# <title>

- Views: <N> · Watch time: <H>h · Avg view: <sec>s (<avg viewed %>)

Retention (by % of video elapsed):

| elapsed % | watch ratio | vs similar videos |
|---|---|---|
| 0% | … | … |
```

Sample the retention rows at roughly 0/10/25/50/75/90/100% elapsed so the
table is readable. After the table, add one line naming the biggest single
drop-off, e.g. `Sharpest drop: 0%→10% (−<X> pts) — fix the hook.`

Replace `retention.md` each run. Read-only. No preamble outside the report.
