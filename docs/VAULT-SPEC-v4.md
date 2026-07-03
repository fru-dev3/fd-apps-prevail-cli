# Vault Spec v4 — the clean domain layout

Status: **approved (folder scheme + names), migrator shipped, reader/writer switch pending.**

v4 is not a new storage engine — it is a **reorganization of the per-domain (and
per-app) folder** so that opening it in Finder is self-explanatory. It builds on
the v4 `data/` and `build/` containers (already live) and replaces the flat,
mixed, mixed-case pile inside each domain with three lowercase folders sorted by
ownership.

## The principle

Every entry in a domain belongs to exactly one of three buckets, by **who owns
it and how it changes**:

| Bucket | Folder | Meaning |
|---|---|---|
| **You** | `source/` | Data you brought or authored. Never rewritten by the AI. |
| **Generated** | `memory/` | Derived by the AI. Regenerable — safe to delete, it rebuilds. |
| **System** | `.system/` | App plumbing: the raw capture ledger, daemon cursors, caches. Hidden. |

Only the two files that **define** a domain stay at its root.

## Target layout

```
<domain>/
  ideal.md            the domain's ideal state (was soul.md) — its target, used
                      everywhere; the domain-detection marker. Purpose + target
                      are ONE file (the "why" is its opening line).
  manifest.json       domain config (routing / engine / sensitivity / sandbox)

  source/             — what YOU own —
    goals.md          objectives + targets
    config.md         your settings
    starters.md       was PROMPTS.md — static starter prompts
    quickstart.md     how-to
    files/            raw docs you brought in (was 01_prior/ + data/); read-only to agents

  memory/             — what the AI DERIVED (all regenerable) —
    state.md          current snapshot        (was _state.md / state.md)
    memory.md         distilled long-term memory (was _memory.md / MEMORY.md)
    decisions.jsonl   decision log            (was _decisions.jsonl / decisions.md)
    journal.md        curated journal         (was _journal.md)
    skills/           learned procedures      (merges _skills/ + skills/)
    threads/          chat transcripts        (was _threads/)
    briefs/           generated briefs        (was 02_briefs/)
    current/          agent working set       (was 00_current/)
    tasks.jsonl       working task set        (was _tasks.*)
    open-loops.md     open items

  .system/            — plumbing, hidden —
    intents.jsonl     raw capture ledger — the rebuild-from-scratch source
    surface.cache.json   regenerable UI cache (was _surface.json)
    *.cursor.json     daemon cursors (was _skillgen.json / _taskgen.json / _distill.json)
```

### Naming rules
- **All lowercase, no exceptions.** The only shouty names today (`PROMPTS.md`,
  `QUICKSTART.md`, `MEMORY.md`, and the `00_/01_/02_` numbers) are gone. Nothing
  looks special unless it is.
- **`ideal`, not `soul`.** "Soul" anthropomorphized and fought the "Ideal State"
  term used throughout the UI. One word, both levels: the vault root holds the
  global ideal state, each domain its own; the path disambiguates.
- **One skills folder.** The desktop wrote `_skills/`, the CLI daemon wrote
  `skills/`; they merge into `memory/skills/`.

### UI mapping (now 1:1)
Context panel → file: **Memory** → `memory/memory.md`, **State** →
`memory/state.md`, **Decisions** → `memory/decisions.jsonl`, **Journal** →
`memory/journal.md`, **Skills** → `memory/skills/`, **Ideal** → `ideal.md`.

Apps get the **identical** shape (`data/apps/<id>/` with the same three folders),
so domains and apps match.

## Migration — non-destructive, staged

Reuses the proven pattern from the `data/`/`build/` migrations: **copy, verify by
file count, drop a marker, never delete.** Originals stay until a separate,
explicitly-confirmed archive step.

1. **Migrator (this ships now):** `prevail vault migrate-layout`
   - dry-run by default (prints the plan);
   - `--apply` copies each entry into `source/ · memory/ · .system/`, merges the
     two skills folders, and drops `.prevail-layout-v4`. Idempotent.
   - `--archive --force` (separate) renames the migrated originals into
     `<domain>/_pre-v4-<stamp>/`. Never deletes.
   - Implemented in `src/vault-layout-v4.ts`; mapping in `v4Destination()`;
     tested in `src/vault-layout-v4.test.ts`.
2. **Dual-read (next):** teach every reader the new paths while it still reads the
   old ones (exactly as it already tolerates legacy names via `normalize.rs`).
   Ships safely with zero migration.
3. **Flip writers + UI labels:** once reads are proven, point writers and the
   Context panel at the new paths. The UI already prints filenames, so labels and
   files finally converge.
4. **Profiles into the vault (pending decision C):** move per-profile config into
   `<vault>/.system/profile.json` so a profile's settings travel with its vault
   and are captured by backup; device secrets (credentials, passcode hash) stay
   machine-local.

Nothing in steps 2–4 runs until reviewed. The migrator in step 1 is inert — it
creates the new folders alongside the originals; the app keeps working on the
originals until step 3 flips the readers.
