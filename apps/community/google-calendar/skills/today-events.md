---
id: today-events
runner: mcp
panelist: claude
trigger: cron("0 6 * * *")
auth: []
inputs: []
outputs:
  - { path: today.md, kind: replace }
---

# Today's events

⚠ **runner: mcp** — not yet implemented. Lands in v0.6 phase 5 (MCP tool dispatch).

When phase 5 ships, this skill will:

1. Spawn `mcp-server-gcal` (the locally-installed MCP wrapper for Google
   Calendar) and call its `list_events_today` tool.
2. Write the result to `today.md` as a markdown list with time + title +
   attendees.

Auth is handled by the MCP server itself — it manages its own OAuth and
stores the refresh token in its own config dir. prevAIl just calls the tool.

Install the wrapper:

```bash
npm i -g @anthropic-ai/mcp-server-gcal
```

Until then, paste your schedule into `state.md` manually.
