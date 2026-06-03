# Connector architecture (v0.6 redesign)

> **TL;DR:** Each connector is a folder with auth, runnable skills, a data store, and a chat surface. The app detail view becomes a workspace with tabs: Overview / Auth / Sync / Skills / Data / Chat. Skills are runnable. Data accumulates. Domains depend on connectors — if the apps don't actually pull data, the domains stay empty.

## Why we're redoing this

Current state (v0.5):

- Manifests have `integration: api|oauth|browser|mcp|manual` ✓
- `auth_check` block describes how to probe auth ✓
- Skills are listed in `SKILL.md` files ✓
- **Skills aren't executable.** They're documentation.
- **No data is pulled.** `data/` doesn't exist as a concept.
- **No sync runner.** Even API connectors can't actually call the API.
- **No A2A integration type.** Agent-to-agent connections (OpenClaw, Paperclip on Mac mini) have nowhere to live.
- App detail view is a manifest viewer with a chat hint, not a workspace.

The gap is the whole point. Without working connectors, every life domain is a markdown file with no data flowing in. The vault never updates.

## The new shape of a connector

```
~/.prevail/connectors/<id>/
├── manifest.json          # name, integration, oauth config, auth_check, skill index
├── SKILL.md               # human-readable overview
├── auth/                  # credentials (chmod 0600)
│   ├── refresh.token      # OAuth refresh token
│   ├── oauth.json         # OAuth metadata (client_id, scopes, token_url)
│   ├── access-tokens/     # per-resource access tokens (Plaid per-institution)
│   └── session.json       # browser-automation session cookies
├── skills/                # runnable skill files
│   ├── sync-transactions.md   # one file per skill
│   ├── get-balance.md
│   └── list-institutions.md
├── data/                  # synced data — JSONL/JSON/markdown
│   ├── transactions/<institution>/YYYY-MM.jsonl
│   ├── balance/latest.json
│   └── _meta.json         # cursors, last_sync, errors
└── _log/                  # connector log: sync runs, errors, manual interactions
    └── YYYY-MM-DD.md
```

Same markdown-first principle as the vault. Auth is the only binary tier (and it's gitignored).

## Integration types

| type | what it is | example |
|---|---|---|
| `api` | REST/GraphQL with stored key in env or auth/ | Plaid, GitHub, OpenAI |
| `oauth` | OAuth 2.0 + refresh token | YouTube Analytics, Google Calendar (API mode) |
| `mcp` | Wrapped via local MCP server binary | Google Calendar (MCP mode), Filesystem |
| `a2a` | Remote MCP server over network | Paperclip on Mac mini, Khoj instance, shared family bot |
| `browser` | Playwright session against the live UI | LinkedIn, Wells Fargo, AppFolio |
| `manual` | User drops files in a watched folder | CSV exports, screenshots |

**A2A is just MCP over network.** Same protocol — JSON-RPC. Different transport — HTTP/WS instead of stdio. Hub allowlist is the security boundary. We can collapse A2A into MCP for v1 with a `transport: stdio|http|ws` field.

## What's a skill, really?

A skill is a unit of work that the connector knows how to do. It has:

- An **id** (`sync-transactions`, `get-balance`)
- A **runner type** that says how to execute it (api / browser / mcp / subprocess / **llm**)
- **Inputs** (institution_id, query, date_range)
- **Outputs** (a data path it writes to, or a string it returns)
- **Auth requirements** (which env vars / auth files it needs)
- A **trigger** (cron schedule, on-demand, or webhook)

```yaml
---
id: sync-transactions
runner: api
trigger: cron("0 2 * * *")
auth: ["PLAID_CLIENT_ID", "PLAID_SECRET"]
inputs:
  - { name: institution_id, type: string, required: true }
outputs:
  - { path: data/transactions/<institution_id>/<YYYY-MM>.jsonl, kind: append }
http:
  method: POST
  url: https://production.plaid.com/transactions/sync
  body:
    client_id: ${env.PLAID_CLIENT_ID}
    secret: ${env.PLAID_SECRET}
    access_token: ${file:auth/access-tokens/${institution_id}.token}
    cursor: ${meta:cursors/${institution_id}}
  response:
    each: $.added[*]
    append_to: data/transactions/${institution_id}/${slice(.date,0,7)}.jsonl
    cursor: $.next_cursor
---

# Sync transactions

Pulls incremental transactions for the given institution from Plaid via
`/transactions/sync`. Resumes from the cursor stored in `_meta.json`.
```

### Why the `llm` runner matters most

Most skills can be expressed as: *"given this connector's auth and these tools, please do X."* The connector provides authentication; the LLM does the logic. For something like "search my Gmail for the receipts from last month," writing imperative HTTP code is silly when you can hand Claude/Codex/Gemini the auth context and the Gmail MCP and let it figure it out.

```yaml
---
id: monthly-receipts
runner: llm
trigger: cron("0 8 1 * *")
panelist: claude   # which CLI to use; default = best-available
tools: [gmail-mcp]
auth: ["GMAIL_OAUTH"]
outputs: [{ path: data/receipts/<YYYY-MM>.md, kind: replace }]
---

# Monthly receipts

For the prior month, find every Gmail message that's clearly a receipt
(order confirmation, invoice, payment receipt). Output one row per
receipt as a markdown table: date | vendor | amount | category guess.

Append the table to data/receipts/<YYYY-MM>.md.
```

The runner builds a prompt that includes the YAML metadata, the skill description, the auth env, and any input args, then spawns Claude (or whichever) with the right MCP servers attached. The model writes the output file.

This is the skill type we'll start with — it covers 80% of what people actually want.

## The new app detail UI

Tabs at the top. Each tab is a focused panel.

```
┌─ Plaid · api · ☑ connected ────────────────────────────────────────────┐
│ [Overview*]  [Auth]  [Sync]  [Skills]  [Data]  [Chat]   ⟳ Test Connection│
├────────────────────────────────────────────────────────────────────────┤
│ Overview                                                               │
│   Aggregates bank, brokerage, and credit card history via Plaid.       │
│   Used by: wealth · tax · business                                     │
│                                                                        │
│   Connection: API · stored key                                         │
│   Status:     ☑ connected   ·   probed 2 min ago                      │
│   Skills:     3 runnable    ·   last sync 2h ago                       │
│   Data:       312 files     ·   8.2 MB     ·   3 institutions linked  │
│                                                                        │
│   Quick actions:                                                       │
│     [▶ Run sync-transactions]   [📂 Browse data/]   [💬 Chat with data]│
└────────────────────────────────────────────────────────────────────────┘
```

Each tab:

- **Overview** — what you see now, plus quick-action buttons
- **Auth** — type, status, env vars / files with check marks, "Re-link" if expired
- **Sync** — schedule of cron-triggered skills, last run, next run, manual fire
- **Skills** — runnable list with [▶ Run] button and last result
- **Data** — file tree under `data/`, file sizes, last modified
- **Chat** — scoped chat session that sees ONLY this connector's `data/` and `SKILL.md`, not the whole vault. This is the "chat with my Plaid data" surface.

The Chat tab is the biggest UX shift. Currently chat opens against a domain (`wealth/`). The new chat tab opens against a connector — much narrower context, much more focused.

## Build phases

| phase | scope | deliverable |
|---|---|---|
| **1. Skill schema + LLM runner** | manifest extension, `runSkill()`, llm runner | run a "list institutions" skill end-to-end |
| **2. API runner + data store** | http runner, data/ + _meta.json writes | sync-transactions actually pulls Plaid data |
| **3. Tabbed UI** | App workspace with 6 tabs | clickable tabs replace the single-panel detail view |
| **4. Connector-scoped chat** | chat session bound to a connector | "chat with my GitHub data" works |
| **5. Sync orchestration** | tickConnectorSyncs(), daemon integration | scheduled skills fire on cron |
| **6. Browser runner** | Playwright skill executor | LinkedIn skills actually pull data |
| **7. A2A as MCP-over-network** | http/ws transport for MCP | OpenClaw/Paperclip discoverable as A2A connectors |

## Security additions

The skill runner is a powerful new attack surface. Specific guards:

1. **Sandbox per-skill.** Skills run in a subprocess with `scrubbedEnv()` minus the secrets THIS skill explicitly declares it needs (already in v0.4).
2. **Manifest auth declaration is a whitelist.** Skills can only access env vars + auth files they list in `auth:`. The runner reads the manifest's `auth:` array and only passes those values.
3. **Output path scoping.** Skills can ONLY write to their declared `outputs:` paths under their own connector's `data/`. The runner refuses writes outside.
4. **A2A allowlist.** Peer agents must be in `~/.prevail/peers.json` with a fingerprint. No discovery.
5. **HTTP runner SSRF guard** (extend the existing one in connector-probe.ts) — refuse to hit private IPs / metadata services unless explicitly opted in.
6. **LLM runner auth scoping.** When spawning Claude/etc for an LLM-runner skill, the env it inherits is `scrubbedEnv()` + only the explicitly-declared auth keys.

## What I'm shipping in this session

The user said "work on the plan even though I'm not around." So:

- ✅ This doc
- ✅ Phase 1: skill schema + LLM runner (most leverage — covers 80% of skills)
- ✅ A real runnable skill for at least one connector to prove the loop
- ⏳ Phase 3 partial: tabbed UI scaffolding so the user sees the new shape
- ⏳ Phase 4 stub: "chat with this connector's data" wired in (LLM runner makes it free)

What's deferred to the next session (clearly documented at the bottom of this doc):

- API runner (Phase 2) — important but not as leveraged as LLM runner
- Real sync orchestration (Phase 5) — depends on Phase 2
- Browser runner (Phase 6) — Playwright is heavy; build last
- A2A transport (Phase 7) — model as MCP over network; small follow-up

---

## Open questions for next time

1. **Where do connector skills install from?** Currently `apps/community/` ships with the binary. Should community connectors be cloneable like `prevail connector install github.com/user/connector-name`?
2. **Skill discovery in the LLM runner.** When a panelist runs an `llm` skill, does it see the OTHER connector skills as MCP tools? (i.e. should the Plaid `monthly-summary` skill be able to call the GitHub `pr-queue` skill via MCP?)
3. **Connector versioning.** A skill schema change is breaking. Do we version the manifest with `schema: 1` and refuse newer manifests we don't understand?
4. **Cost limits per skill.** Should `runner: llm` skills declare a max-token budget so a runaway skill can't burn $50?
