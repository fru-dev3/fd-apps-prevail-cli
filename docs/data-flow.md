# Data flow

How data moves through prevAIl, from keystroke to disk to recall.

## 1. A turn end-to-end

A single chat turn in a domain workspace:

```
 user types in chat-pane.tsx
        │
        │  send (Enter)
        ▼
 app.tsx handleSend
        │
        │  capture framework + lens at send time
        │  (NOT at receive time — chips can change mid-turn)
        ▼
 cli-bridge.ts runChatTurn
        │  buildFrameworkPreamble(framework) + prompt
        │  + (claude only) --append-system-prompt = AGENTS-operating.md
        │  + (web=deny) WEB_DENY_NOTE appended to manual
        ▼
 spawn(<cli.bin>, argv, scrubbedEnv, own process group)
        │
        │  onChunk(delta)  ─────►  chat-pane streams partial text
        ▼
 full reply string returned
        │
        ├──►  persistMessage()         → ~/.prevail/sessions DB (SQLite)
        ├──►  writeTurnSummary()       → <domain>/_log/YYYY-MM-DD.md
        │                                 + .shasum sibling
        │                                 + memory.indexEntry() (best-effort embed)
        └──►  distillTurnToJournal()   → <domain>/_journal/decisions.md
                                          <domain>/_journal/facts.md
```

The framework + lens labels chosen by the user at *send* time travel
through the whole pipeline so the `_log/` meta line records exactly which
toggles were on when the question fired. This is captured in
`src/app.tsx` around line 1545 (single chat) and 1849 (council).

## 2. A council turn

`/council <prompt>` (or council-mode-toggle ON + Enter):

```
 user prompt
   │
   ▼
 expand panelists (CLIs × pinned models)
   │
   ├── lens=null  →  one call per panelist
   ├── lens=<id>  →  one call per panelist, same lens on each
   └── lens=all   →  panelists × LENSES   ← cap by councilMaxCallsPerTurn
   │
   ▼
 fan out (parallel) — runChatTurn(bare=true) per panelist call
   │
   ▼
 sanitize each reply (## → "(panelist) ## ")
   │
   ▼
 chair synthesis call — chair model reads all panelist outputs
   │
   ▼
 verdict bubble + parseVerdict() → divergence flag
   │
   ├──►  persistMessage          → sessions DB
   ├──►  writeTurnSummary        → _log/  (kind="council-verdict")
   └──►  distillTurnToJournal    → _journal/
```

`lens=all` is the only mode that multiplies the panelist count, which is
why every council turn first prints an estimated cost line and refuses to
exceed `councilMaxCallsPerTurn` (default 16) without explicit consent.

## 3. The vault folder layout

```
<vault>/
  AGENTS-operating.md            ← user-edited (operating manual for claude)
  <domain>/
    state.md                     ← user-edited
    QUICKSTART.md                ← user-edited
    PROMPTS.md                   ← user-edited
    open-loops.md                ← user-edited
    skills/<skill-id>/SKILL.md   ← user-edited (n on Skills tab scaffolds new ones)
    _log/<YYYY-MM-DD>.md         ← AUTO-WRITTEN by writeTurnSummary() on every turn
    _log/<YYYY-MM-DD>.md.shasum  ← AUTO-WRITTEN sibling — one (entry-id, sha256) per line
    _journal/decisions.md        ← AUTO-WRITTEN by distillTurnToJournal()
    _journal/facts.md            ← AUTO-WRITTEN by distillTurnToJournal()
```

Who reads what:

- The model reads `state.md`, `QUICKSTART.md`, `PROMPTS.md`, `open-loops.md`,
  `skills/*/SKILL.md`, and recall hits surfaced by `src/memory.ts`.
- `_log/` is for the user (and `prevail vault verify`).
- `_journal/` is for the user and any future recall index.
- `.shasum` is for `prevail vault verify`.

## 4. Config + secrets

Everything under `~/.prevail/` is machine-local and **must not be synced**
to iCloud / Dropbox / git:

```
~/.prevail/
  config.json              ← chmod 0600  (vault path, chair pin, model pins,
                                          per-domain framework/lens overrides,
                                          web-access, councilMaxCallsPerTurn, ...)
  telegram.json            ← chmod 0600  (bot token, chat-ID allowlist)
  mcp.json                 ← chmod 0600  (auto-generated bearer token)
  connectors/<id>/auth/    ← chmod 0600  (per-connector OAuth refresh tokens)
  daemon.pid               ← (PID of running daemon, for zombie detection)
  sessions/<db>            ← chat session SQLite DB (persistMessage target)
```

The cockpit refuses to write any secret with looser permissions than 0600.

## 5. The benchmark loop

`bench/` lives under the vault so question sets are version-controlled
with the user's context, not buried in `~/.prevail/`:

```
 <vault>/benchmark/
   questions/<question-id>.md         ← user-authored test cases
        │
        │  prevail bench run [--cli=...] [--model=...]
        ▼
   runs/<YYYY-MM-DD>_<cli>_<model>/
     results.json                     ← raw replies + timings + token counts
        │
        │  prevail bench score        (rubric LLM judges results.json)
        ▼
     score.json                       ← per-question scores + summary
        │
        │  prevail bench leaderboard  (aggregates score.json across runs)
        ▼
   stdout: ranked board
```

The benchmark loop never touches `_log/` or `_journal/` — bench output is
isolated under `runs/` so a noisy benchmark session doesn't pollute the
domain history.

## 6. State that survives a restart vs state that doesn't

**Survives:**
- Everything under `<vault>/` (markdown is the source of truth).
- `~/.prevail/config.json`, `telegram.json`, `mcp.json`, `connectors/`.
- `~/.prevail/sessions/<db>` — chat sessions can be re-opened.
- `.shasum` siblings — log integrity carries across restarts.

**Does not survive:**
- In-process chat session memory in the cockpit (state held in React
  state via `src/session.ts`'s in-memory cache layer).
- Pending council fanouts (an in-flight `/council` aborted by quit is
  gone; nothing was written yet).
- Per-session "gut" takes captured by `/gut` — held in
  `pendingGutRef.current` and consumed by the next council verdict.
  Quit before the verdict and the gut is lost.
- Streaming partial-reply buffers (onChunk deltas) — only the final
  reply is persisted.

If a turn completed (reply received), it persisted. If it was cancelled
or the process died mid-turn, nothing landed on disk for that turn.
