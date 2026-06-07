# prevAIl Vault Specification

> **FROZEN CONTRACT.** Every prevAIl agent, engine, and UI builds against this
> document. Changes that break an existing rule require a schema-version bump
> (see [Schema versioning](#schema-versioning)) and a migration. Additive,
> backward-compatible changes (new *optional* files/fields) do not.

The vault is a folder of **domains**. A domain is a slice of life or work —
`wealth`, `health`, `business`, `career`, … — represented entirely as files on
disk. The vault is plain files so it can live in any synced folder (iCloud,
Dropbox, a git repo) and be read by any tool. prevAIl never requires a database
to function.

---

## 1. The domain rule (NEVER change this)

> **A directory is a domain if and only if it contains a `state.md` file.**

This is the single load-bearing invariant. Everything else is optional.

- A directory **with** `state.md` → it is a domain, always scanned.
- A directory **without** `state.md` → it is **not** a domain, ignored by the
  scanner (it may be a support folder, a connector, anything).
- The scanner additionally skips a fixed set of non-domain directories
  (`complete`, `core`, `scripts`, `.git`, `.claude`, `.claude-plugin`,
  `node_modules`) and any unsafe entry name. See `src/vault.ts`.

The vault **root** is the directory whose immediate children are domains.

```
vault/
├── wealth/        # domain  (has state.md)
│   └── state.md
├── health/        # domain  (has state.md)
│   └── state.md
├── core/          # NOT a domain (reserved support dir)
└── scripts/       # NOT a domain (reserved support dir)
```

---

## 2. Per-domain on-disk layout

A fully-formed domain. Only `state.md` is required; every other entry is
**optional** and its absence means that feature is simply off.

```
<vault>/<domain>/
├── state.md            # REQUIRED. Current state + "## Open Items" section.
├── config.md           # OPTIONAL. Human-edited key:value settings.
├── decisions.md        # OPTIONAL. Dated decision log.
├── open-loops.md       # OPTIONAL. Checkbox to-dos (fallback to state's Open Items).
├── manifest.json       # OPTIONAL (NEW). Machine config — see schema.
├── MEMORY.md           # OPTIONAL (NEW). Durable facts that outlive any single turn.
├── QUICKSTART.md       # OPTIONAL. User-authored how-to for this domain.
├── PROMPTS.md          # OPTIONAL. User-authored prompt library.
│
├── _journal.md         # OPTIONAL. Single-file journal …
│   ── or ──
├── _journal/           # OPTIONAL.  … or a journal directory
│   ├── decisions.md
│   └── facts.md
│
├── _log/               # OPTIONAL. Append-only operational log.
│   ├── 2026-06-06.md       # per-day turn summaries
│   └── score.jsonl         # (NEW) append-only score history (one JSON per line)
│
├── _threads/           # OPTIONAL. Chat transcripts.
│   ├── <id>.md             # human-readable thread (legacy/export)
│   └── <id>.jsonl          # (NEW) append-only chat turns (one ChatEvent per line)
│
├── _drop/              # OPTIONAL (NEW). User-dropped files. IMMUTABLE to agents.
│   └── 2026-q1-statement.pdf
│
├── skills/             # OPTIONAL. Domain-scoped skills.
│   └── <name>/SKILL.md
│
├── 00_current/         # OPTIONAL. Working set — current docs/notes. Agent-writable.
├── 01_prior/           # OPTIONAL. Archived prior material. IMMUTABLE to agents.
└── 02_briefs/          # OPTIONAL. Generated briefs/summaries. Agent-writable.
```

### Existing files (unchanged)

| File / dir              | Purpose                                                            |
| ----------------------- | ----------------------------------------------------------------- |
| `state.md`              | **Required.** Domain's current state. May hold `## Open Items`.    |
| `config.md`             | Human key:value config.                                            |
| `decisions.md`          | Decision log.                                                      |
| `open-loops.md`         | Checkbox to-dos; counted when state has no Open Items.             |
| `_journal.md` / `_journal/` | Distilled journal (single file *or* directory; never both).    |
| `_log/*.md`             | Per-day append-only operational log.                              |
| `_threads/*.md`         | Human-readable chat threads.                                       |
| `skills/<name>/SKILL.md`| Domain-scoped skill definitions.                                  |
| `00_current/`           | Working set of current documents.                                 |
| `01_prior/`             | Archived prior material.                                          |
| `02_briefs/`            | Generated briefs and summaries.                                   |

### New OPTIONAL files (absence = feature off)

All five are additive. A vault that never created them behaves exactly as before.

| File / dir               | Purpose                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `manifest.json`          | Per-domain machine config: identity, engine, goals, routing, heartbeat. See schema.      |
| `MEMORY.md`              | Per-domain **durable facts** — things true across many turns (account names, allocations).|
| `_drop/`                 | **Immutable** inbox: files the *user* drops in. Agents may **read** but never write/edit. |
| `_log/score.jsonl`       | Append-only score history. One JSON object `{ts, score}` per line.                        |
| `_threads/<id>.jsonl`    | Append-only chat transcript. One `ChatEvent` per line (NDJSON).                           |

---

## 3. Write zones (permission contract)

Every path falls into exactly one zone. Agents MUST honor these. The
`manifest.sandbox.mode` field can tighten (`locked`) but never loosen these
defaults.

### Immutable zones — agent **read-only**

Agents may read for context but must NEVER create, modify, or delete here.

- `_drop/` — the user's drop inbox. Only the human adds files.
- `01_prior/` — archived prior material. History is never rewritten.

### Agent-writable zones

Agents may freely create/update/append here (subject to `sandbox.mode`).

- `state.md`
- `decisions.md`
- `open-loops.md`
- `_journal.md` (or `_journal/`)
- `MEMORY.md`
- `00_current/`
- `02_briefs/`
- `_threads/` (including `<id>.jsonl`)
- `_log/` (including `score.jsonl`)
- `manifest.json`

### User-writable zones

Authored by the human. Agents read these; they should not overwrite them
without explicit instruction.

- `config.md`
- `QUICKSTART.md`
- `PROMPTS.md`

> **Summary:** `_drop/` and `01_prior/` are read-only to agents. `config.md`,
> `QUICKSTART.md`, `PROMPTS.md` are the human's. Everything else listed is
> agent-writable.

---

## 4. File-format rule (which format for what)

This mapping is part of the frozen contract. Pick the format by the *kind* of
data, not by convenience.

| Format       | Use for                                                | Examples                                              |
| ------------ | ------------------------------------------------------ | ----------------------------------------------------- |
| **Markdown** | Human knowledge — prose meant to be read & edited.     | `state.md`, `decisions.md`, `MEMORY.md`, `_journal.md`|
| **JSON**     | Config / manifest — structured machine settings.       | `manifest.json`                                       |
| **JSONL**    | Append-only event & chat streams — one record per line.| `_threads/<id>.jsonl`, `_log/score.jsonl`            |
| **SQLite**   | **LOCAL, rebuildable index only.**                     | `~/.prevail/sessions.db`, embedding cache             |

### SQLite is NEVER stored in the synced vault

> A SQLite database MUST NOT live inside the vault folder.

SQLite is used only as a **local, rebuildable index** (chat history cache,
embedding store, search index) under `~/.prevail/` — outside the vault. Reasons:

1. **Sync corruption.** Cloud sync (iCloud/Dropbox) on two machines will corrupt
   a live SQLite file. The two-machine setup (Mac Mini ↔ MacBook) shares the
   vault folder directly; a synced `.db` would race.
2. **Rebuildability.** The vault's Markdown/JSON/JSONL files are the source of
   truth. The index can always be regenerated from them, so losing it is harmless.

If the index is deleted, prevAIl rebuilds it from vault files. The vault stays
human-readable and sync-safe forever.

---

## 5. Schema versioning

`manifest.json` carries a top-level integer `"schema"`. **Current version: `1`.**

```json
{ "schema": 1, "identity": { … }, … }
```

### Migration convention

- **Readers migrate forward.** A reader that supports schema N MUST accept any
  manifest with `schema <= N`, upgrading older shapes in memory before use. This
  mirrors the existing in-code migration pattern (e.g. `migrateLegacyCliKind` in
  `src/config.ts`, which silently rewrites `"gemini"` → `"antigravity"`).
- **Persist on write.** When an upgraded manifest is next written, it is written
  at the current `schema` number. Migrations are idempotent.
- **Bump only on breaking changes.** Adding a new *optional* field is additive —
  no bump. Renaming/removing a field, or changing a field's type/meaning, is
  breaking — increment `schema` and add a migration step.
- **Unknown future versions.** A reader that encounters `schema > N` (a newer
  app wrote it) MUST refuse to silently downgrade. Treat the manifest as
  read-only / feature-limited rather than discarding fields it doesn't
  understand.
- **Unknown fields are tolerated on read** for forward-compatibility, but the
  canonical schemas in `docs/schemas/` are `additionalProperties: false` — the
  writer emits only known fields.

The same `"schema"` convention applies to any future JSON document type added to
the vault; each gets its own independent version line.

---

## 6. Reference

- JSON Schemas (draft 2020-12): [`docs/schemas/`](./schemas/)
  - `DomainManifest`, `ContextScore` (+ `ScoreBreakdown`), `MissingItem`,
    `Domain`, `OnboardingRecommendation`, `ChatEvent`, `BackupResult`.
- Example payloads (one per schema, schema-validated):
  [`docs/fixtures/`](./fixtures/)
- Plumbing API contract: [`docs/ENGINE-JSON-API.md`](./ENGINE-JSON-API.md)
- Implementation of the domain scanner: `src/vault.ts`
