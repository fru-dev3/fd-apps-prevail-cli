---
id: sync-inbox-mcp
runner: mcp
trigger: refresh
mcp_command: "${env.GMAIL_MCP_COMMAND}"
tool: search_threads
inputs:
  - name: query
    value: "is:important newer_than:7d"
  - name: maxResults
    value: "20"
save: inbox-${date}.json
---
Pull recent important Gmail threads via a local MCP Gmail server. Requires
GMAIL_MCP_COMMAND to be set to the server launch command
(e.g. "npx @modelcontextprotocol/server-gmail"). The engine spawns the
server over stdio, calls the search_threads tool, and saves the result to
data/. The MCP server handles its own Google auth (typically via a stored
credentials.json or GOOGLE_APPLICATION_CREDENTIALS).
