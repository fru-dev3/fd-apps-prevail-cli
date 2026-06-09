# prevAIl Engine JSON API

> **FROZEN CONTRACT.** This is the plumbing layer: the set of `prevail …
> --json` commands that the TUI, scripts, and other agents call to read and
> mutate the vault. Output shapes reference the JSON Schemas in
> [`docs/schemas/`](./schemas/). UI agents can build against the
> [`docs/fixtures/`](./fixtures/) payloads before the engine exists.

## Conventions

- Every command accepts `--json`. With `--json`, the command writes a single
  JSON value (or, for streams, NDJSON) to **stdout** and nothing else. Human
  output goes to stdout only when `--json` is absent.
- **Exit codes:** `0` success, non-zero failure. On failure with `--json`, the
  command writes an error envelope to stdout:
  ```json
  { "ok": false, "error": "human-readable message", "code": "MACHINE_CODE" }
  ```
- **Timestamps:** ISO-8601 strings for human-facing fields (`created`,
  `computed_at`); epoch milliseconds (number) for machine fields (`stateMtime`,
  `audited_at`, `ts`).
- **stdin:** commands that take input (`onboard recommend`, `onboard apply`) read
  a JSON document from stdin.
- A type written as `T[]` means a JSON array of `T`. Schema names link to
  `docs/schemas/<Name>.json`.

## Global flags

These apply to every command.

| Flag                 | Meaning                                                                       |
| -------------------- | ---------------------------------------------------------------------------- |
| `--vault <path>`     | Vault root to operate on. Defaults to the configured vault.                   |
| `--json`             | Emit machine-readable JSON (this document's contract).                        |
| `--local-only`       | Forbid all network/cloud engines & tools for this invocation. Overrides config.|
| `--budget <tokens>`  | Hard token budget for any LLM work in this invocation (e.g. `score --audit`). |

---

## Commands

### `prevail domains --json`

List all domains in the vault.

- **Args:** none.
- **Output:** `Domain[]` — array of [`Domain`](./schemas/Domain.json), sorted by
  the priority order in `src/vault.ts`.

```jsonc
[ { "name": "wealth", "path": "…/wealth", "hasState": true,
    "openLoopCount": 3, "stateMtime": 1749220200000, "skills": [ … ] } ]
```

---

### `prevail manifest get <domain> --json`

Read a domain's manifest.

- **Args:** `<domain>` (required).
- **Output:** [`DomainManifest`](./schemas/DomainManifest.json). If the domain
  has no `manifest.json`, the engine returns a fully-defaulted manifest
  (`schema: 1`, identity derived from the directory, empty goals/routing) so
  callers always get a usable object.

### `prevail manifest set <domain> --json`

Write/merge a domain's manifest. The JSON body is read from **stdin** (a partial
or full `DomainManifest`); the engine deep-merges it onto the existing manifest,
bumps/normalizes `schema`, and persists.

- **Args:** `<domain>` (required). Body on stdin.
- **Output:** the resulting [`DomainManifest`](./schemas/DomainManifest.json)
  after merge + write.

---

### `prevail score <domain> [--audit] --json`

Compute a domain's context-readiness score.

- **Args:** `<domain>` (required). `--audit` adds an LLM narrative
  (`assessment` + `audit_source` populated; otherwise both `null`). `--audit`
  respects `--budget` and `--local-only`.
- **Output:** [`ContextScore`](./schemas/ContextScore.json).

```jsonc
{ "domain": "wealth", "score": 78,
  "breakdown": { "coverage": {…}, "density": {…}, "freshness": {…},
                 "structure": {…}, "activity": {…}, "config_completeness": {…} },
  "missing": [ … ], "freshness_secs": 172800,
  "assessment": null, "audit_source": null,
  "computed_at": "2026-06-06T14:30:00.000Z", "audited_at": null }
```

### `prevail score --all --json`

Score every domain and compute the overall life-readiness roll-up.

- **Args:** none (`--audit`/`--budget` honored as above).
- **Output:**
  ```jsonc
  { "lifeReadiness": 81,                       // 0-100 roll-up across domains
    "domains": [ ContextScore, ContextScore ] } // one ContextScore per domain
  ```

### `prevail score history <domain> --json`

Return the append-only score history from `_log/score.jsonl`.

- **Args:** `<domain>` (required).
- **Output:** array of points, oldest → newest:
  ```jsonc
  [ { "ts": 1748000000000, "score": 71 },
    { "ts": 1749220200000, "score": 78 } ]
  ```

---

### `prevail onboard recommend --json`

Propose a starter set of domains from the user's answers.

- **Args:** none. The user's free-form **answers JSON is read from stdin**, e.g.
  `{ "answers": { "focus": "building ventures", "wants_health": false } }`.
- **Output:** [`OnboardingRecommendation`](./schemas/OnboardingRecommendation.json).

### `prevail onboard apply --json`

Scaffold the domains the user picked.

- **Args:** none. The **picks JSON is read from stdin**, e.g.
  `{ "picks": ["wealth", "business"] }` (names from the prior recommendation).
- **Behavior:** creates `<vault>/<name>/state.md` (+ default `manifest.json`,
  starter goals/skills) for each pick. Idempotent — existing domains are left
  intact.
- **Output:** `Domain[]` — the [`Domain`](./schemas/Domain.json) records that now
  exist for the picked names.

---

### `prevail vault backup [--domain X] --json`

Create a backup archive of the vault, or of one domain.

- **Args:** `--domain X` (optional) limits the backup to a single domain;
  omitted = whole vault.
- **Output:** [`BackupResult`](./schemas/BackupResult.json).

### `prevail vault archive <domain> --json`

Archive a domain (sets `archived: true` + `archived_at` in its manifest; hides it
from the active sidebar). Never deletes data.

- **Args:** `<domain>` (required).
- **Output:** `{ "ok": true }`.

### `prevail vault restore <domain> --json`

Un-archive a domain (clears `archived` / `archived_at`).

- **Args:** `<domain>` (required).
- **Output:** `{ "ok": true }`.

### `prevail vault list-archived --json`

List archived domain names.

- **Args:** none.
- **Output:** `string[]` — e.g. `["explore", "intel"]`.

---

### `prevail chat --domain X --json`

Run a chat turn in a domain and stream the result.

- **Args:** `--domain X` (required). The user message is read from stdin (or a
  `--message` flag). `--budget` / `--local-only` honored.
- **Output:** an **NDJSON stream** — one [`ChatEvent`](./schemas/ChatEvent.json)
  per line, flushed as it happens. Typical order:
  `start` → (`delta`*) → `assistant` → `usage` → `done`. Errors emit an
  `error` event. The finalized turn is also appended to
  `<domain>/_threads/<id>.jsonl`.

```jsonl
{"type":"start","thread":"2026-06-06-wealth-01","ts":1749225600000,"domain":"wealth","engine":"claude:opus-4-8"}
{"type":"delta","thread":"2026-06-06-wealth-01","ts":1749225600100,"text":"Your net worth "}
{"type":"assistant","thread":"2026-06-06-wealth-01","ts":1749225601000,"role":"assistant","text":"Your net worth is up 4.2% …"}
{"type":"usage","thread":"2026-06-06-wealth-01","ts":1749225601005,"usage":{"input_tokens":1820,"output_tokens":240,"cost_usd":0.018}}
{"type":"done","thread":"2026-06-06-wealth-01","ts":1749225601010}
```

---

### `prevail council run --domain X --json`

Run a full council: fan the prompt across the configured panel in parallel, then
have a chair synthesize one verdict. The verdict is persisted to the domain's
decision log so the council learns.

- **Args:** `--domain X` (omit / `general` → the domainless General space). The
  user message is read from stdin or `--message "…"`. Flags:
  - `--quorum N` — stop waiting once N panelists produce a usable reply; abort
    the rest and synthesize (the engine-level "Summarize now"; a stuck panelist
    can never block the verdict).
  - `--lens <id>|all|off` — cognitive lens selection (overrides config).
  - `--framework <id>|off` — response framework (overrides config).
  - `--cli claude,codex,…` — restrict the panel to these CLI kinds.
  - `--local-only` — Bunker council: build the panel from local engines only.
- **Output:** an **NDJSON stream** — one event per line, flushed live:

```jsonl
{"type":"start","thread":"c-…","ts":1749225600000,"domain":"wealth","quorum":2,"localOnly":false}
{"type":"panel","thread":"c-…","ts":…,"panelists":[{"idx":0,"cli":"claude","model":"","lens":null},{"idx":1,"cli":"codex","model":"","lens":null}]}
{"type":"delta","thread":"c-…","ts":…,"idx":0,"text":"Renting "}
{"type":"panelist","thread":"c-…","ts":…,"idx":0,"ok":true,"ms":4120}
{"type":"chair","thread":"c-…","ts":…,"chair":"Claude"}
{"type":"verdict-delta","thread":"c-…","ts":…,"text":"VERDICT: rent. "}
{"type":"verdict","thread":"c-…","ts":…,"text":"VERDICT: rent …","chairLabel":"Claude","degraded":false}
{"type":"decision","thread":"c-…","ts":…,"id":"d-…"}
{"type":"done","thread":"c-…","ts":…}
```

`delta` (panelist token, attributed by `idx`) and `verdict-delta` (chair token)
are the streaming events; `panelist`/`chair`/`verdict`/`decision` are the
lifecycle events. Errors emit `{"type":"error",…,"error":"…"}` and exit non-zero.

### `prevail council feedback --id <decisionId> --rating up|down|clear --json`

Attach (or clear) a thumbs up/down + optional note to a recorded verdict, keyed
by its decision `id`. Feeds the learning loop (prefer model/framework/lens combos
that produced liked verdicts).

- **Args:** `--id` (required), `--rating up|down|clear` (required),
  `--note "…"` (optional), `--domain X` (omit → General).
- **Output:** `{ "ok": true }`, or an error envelope if the id isn't found.

---

### `prevail decisions [list] [<domain>] --json [--limit N]`

Read a domain's append-only decision log (`<domain>/_decisions.jsonl`; vault root
for General), newest first.

- **Args:** `<domain>` (optional; omit / `general` → General). `--limit N` caps.
- **Output:** array of decision records:
  ```jsonc
  [ { "id": "d-…", "ts": 1749225601000, "type": "council_verdict",
      "domain": "wealth", "prompt": "rent or buy?", "verdict": "VERDICT: rent …",
      "chair": "Claude", "degraded": false, "source": "cli",
      "panel": [ { "cli": "claude", "model": "", "lens": null, "ok": true, "ms": 4120 } ],
      "feedback": { "rating": "up", "note": "good call" } } ]
  ```

### `prevail memory read [<domain>] --json`

Read a domain's distilled long-term memory (`<domain>/_memory.md`; vault root for
General) — the curated context the council reads on the next question.

- **Args:** `<domain>` (optional; omit → General).
- **Output:** `{ "domain": "wealth", "text": "…markdown…" }`.

---

### `prevail surface [<domain>] --json [--force]`

Proactive insights: sharp questions worth resolving + concrete next actions,
generated from the domain's memory/state/decisions and cached at
`<domain>/_surface.json` (6h TTL). Under `--local-only` / Bunker it runs on a
local model.

- **Args:** `<domain>` (optional; omit → General). `--force` bypasses the cache.
- **Output:**
  ```jsonc
  { "questions": ["…", "…"], "actions": ["…", "…"],
    "generated_at": 1749225601000, "stale": false }
  ```

### `prevail frameworks list --json` · `prevail lenses list --json`

The response-framework / cognitive-lens catalogs (so a frontend can render the
pickers from the engine instead of hardcoding them).

- **Output:** `[ { "id": "bluf", "label": "BLUF", "blurb": "…" }, … ]`.

---

### `prevail modes get|set [<domain>] --json`

Read/write the per-domain turn dials. `set` accepts any subset:
`--web allow|deny`, `--save on|off`, `--serendipity on|off`,
`--auto off|suggest|auto`, `--framework <id>|off`, `--lens <id>|all|off`.

- **Args:** `<domain>` (optional; omit → global/General scope).
- **Output (both get and set):** the resolved modes for that scope:
  ```jsonc
  { "domain": "wealth", "web": "allow", "save": true, "serendipity": false,
    "auto": "suggest",
    "framework": { "id": "bluf", "scope": "global" },
    "lens": { "sel": "outsider", "scope": "domain" } }
  ```

### `prevail privacy get|set --json [--bunker on|off]`

Read/set **Bunker Mode** — a persisted, global local-only switch. Frontends read
it to decide whether to pass `--local-only` on every engine call.

- **Output:** `{ "bunker": false }`.

---

### `prevail search <query> --json [--limit N]`

Full-text search across the indexed chat history (the FTS5 index at
`~/.prevail/sessions.db`).

- **Args:** `<query>` (required, may be multiple words). `--limit N` (default 20).
- **Output:** array of hits:
  ```jsonc
  [ { "domain": "wealth", "session_id": "…", "role": "assistant",
      "content": "…matching message…", "ts": 1749225601000 } ]
  ```

---

### `prevail bench list --json` · `prevail connectors list --json` · `prevail gateway status --json`

Machine listings for the benchmark question catalog, installed connectors, and
the deterministic channel-routing status (all pure reads).

- `bench list --json` → `[ { "id", "domain", "stakes", "verifiable", "prompt" } ]`
- `connectors list --json` → `[ { "id", "title", "integration", "path" } ]`
- `gateway status --json` → `{ "ok", "vault", "channels": [...], "routing": [...] }`

---

### `prevail heartbeat install --json`

Install the OS scheduler hooks (cron/launchd) for all enabled domain heartbeat
routines (`manifest.heartbeat`).

- **Args:** none.
- **Output:** `{ "ok": true, "installed": ["wealth-op-weekly-pulse", …] }`.

### `prevail heartbeat status --json`

Report heartbeat installation + routine state.

- **Args:** none.
- **Output:**
  ```jsonc
  { "ok": true,
    "installed": true,
    "routines": [ { "domain": "wealth", "id": "wealth-op-weekly-pulse",
                    "schedule": "weekly mon 08:00", "enabled": true,
                    "lastRun": 1749220200000, "nextRun": 1749825000000 } ] }
  ```

---

## Schema index

| Schema                                                                   | Emitted by                                                       |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| [`Domain`](./schemas/Domain.json)                                        | `domains`, `onboard apply`                                       |
| [`DomainManifest`](./schemas/DomainManifest.json)                        | `manifest get`, `manifest set`                                   |
| [`ContextScore`](./schemas/ContextScore.json) (+ `ScoreBreakdown`)       | `score`, `score --all`                                           |
| [`MissingItem`](./schemas/MissingItem.json)                              | nested in `ContextScore.missing`                                 |
| [`OnboardingRecommendation`](./schemas/OnboardingRecommendation.json)    | `onboard recommend`                                              |
| [`ChatEvent`](./schemas/ChatEvent.json)                                  | `chat` (NDJSON stream)                                           |
| [`BackupResult`](./schemas/BackupResult.json)                            | `vault backup`                                                   |
