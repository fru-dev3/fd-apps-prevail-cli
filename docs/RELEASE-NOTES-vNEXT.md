# prevAIl — Release Notes (vNEXT)

The "Prevail" release brings prevAIl from a TUI cockpit to a full life-OS
engine: a deterministic scoring core, a machine-readable JSON API, multi-channel
gateway routing, and a native desktop app — all over the same vault.

Base version at cut: **1.6.5**. This document tracks everything shipped in the
vNEXT integration milestone.

---

## What shipped

### Context Score (deterministic readiness engine)
- `prevail score <domain> --json` computes a per-domain **ContextScore** with a
  full `breakdown` (coverage, density, freshness, structure, activity,
  config_completeness), a 0–100 `score`, `freshness_secs`, and a deterministic
  `missing[]` list (`{label, severity, kind}`) that explains exactly what's
  absent and why it matters.
- `prevail score --all --json` rolls every domain up into a single
  **`lifeReadiness`** number alongside the per-domain `domains[]` array.
- `prevail score history <domain> --json` exposes the append-only score history.
- `--audit` augments the deterministic score with an optional model pass; the
  deterministic path always runs first so scores are reproducible without any
  CLI/model installed.
- Works for **any** vault shape: a brand-new sparse domain (just a `state.md`)
  scores LOW with a sensible, deterministic `missing[]` — proven in E2E by
  scaffolding a `shoes` domain on the fly and scoring it (27/100, 7 missing).

### Manifest
- Every scored domain gets a `manifest.json` (identity, routing, scoring
  metadata). `prevail manifest get|set <domain> --json` reads/deep-merges it via
  the engine JSON API.
- Scoring side-writes `manifest.json` + appends `_log/score.jsonl`
  (`{ts, score}` per run) so history is captured automatically.

### Onboarding
- `prevail onboard recommend --json` takes an `{answers:{…}}` payload on stdin
  and returns a tailored starter domain set (`domains[]` with label/emoji/
  summary/reason/starterGoals/suggestedSkills) plus a `rationale`.
- `prevail onboard apply --json` scaffolds the picked domains.

### Backup / Archive lifecycle
- `prevail vault backup --json` now emits a machine-readable **BackupResult**
  (`{ok, archivePath, bytes}`) — the archive is written and the path is
  verifiable. (Human/TTY mode still prints the friendly progress line.)
- `prevail vault archive <domain> --json` / `restore <domain> --json` /
  `list-archived --json` move a domain in and out of the active set without
  deleting data. Archived domains drop out of `domains`/scoring and reappear on
  restore. Frozen `{ok:true}` envelopes per the engine JSON API.

### Privacy / Budget
- `privacy.ts` redaction + `--local-only` flag plumbed through the JSON sub-arg
  parser so engine commands can run without leaking to remote models.
- `budget.ts` cost guardrails for council/model calls.

### Heartbeat
- `prevail heartbeat install --json` / `status --json` install and report OS
  scheduler hooks that keep domains warm (scoring/briefings on a cadence).

### Chat unification
- One chat path (`cli-bridge.runChatTurn`) is shared by the TUI, `prevail chat
  --domain <d> --json` (NDJSON streaming), Telegram, and the gateway — so a
  message behaves identically regardless of entry point.

### Gateway (multi-channel routing) — wired this release
- `prevail gateway status --json` reports configured channel adapters
  (`telegram`, `whatsapp`) and the **deterministic per-domain routing** table
  (each domain's keywords + default flag). Pure read: no adapters start, no
  model is called.
- Routing invariant: the **model never picks the channel or the domain** —
  routing is a pure keyword match (`manifest.routing.keywords` → `default` →
  first domain) computed before any model call, so the same message always lands
  in the same domain.
- `domains --json` and `gateway status --json` were wired into the `index.tsx`
  argument parser and dispatcher in this milestone.

### Desktop UI
- Tauri desktop app (`fd-apps-prevail-desktop`): React + Vite frontend over a
  Rust core. `cargo check` and `npm run build` both green.

---

## Engine JSON API surface (machine-only commands)

All of the following require `--json`, accept `--vault <path>`, and emit the
frozen `{ok:false, error, code}` envelope on failure:

| Command | Output |
| --- | --- |
| `prevail domains --json` | array of domains |
| `prevail score <domain> --json` | ContextScore |
| `prevail score --all --json` | `{lifeReadiness, domains[]}` |
| `prevail score history <domain> --json` | `[{ts, score}]` |
| `prevail manifest get\|set <domain> --json` | manifest object |
| `prevail onboard recommend\|apply --json` | recommendation / scaffold result |
| `prevail vault archive\|restore <domain> --json` | `{ok:true}` |
| `prevail vault list-archived --json` | `[name, …]` |
| `prevail vault backup --json` | BackupResult `{ok, archivePath, bytes}` |
| `prevail heartbeat install\|status --json` | heartbeat state |
| `prevail gateway status --json` | GatewayStatus `{ok, vault, channels[], routing[]}` |

---

## Verification (this milestone)

**CLI**
- `bunx tsc --noEmit` — **PASS** (0 errors).
- End-to-end on a fresh copy of `vault-demo` (run with `--vault <tmp>`, repo
  never mutated) — all 6 steps PASS:
  1. `domains --json` → array of 20 domains.
  2. `score wealth --json` → valid ContextScore; `manifest.json` + `_log/score.jsonl` written.
  3. `score --all --json` → `lifeReadiness: 53` + 20-entry `domains[]`.
  4. `onboard recommend --json` → recommendation; new sparse `shoes` domain scores 27/100 with 7 deterministic missing[].
  5. `vault archive shoes` → `{ok}`; `domains` drops shoes; `list-archived` includes shoes; `vault restore shoes` → back.
  6. `vault backup --json` → BackupResult, archive path exists on disk.
- `bun test src/` — **182 pass, 3 skip, 0 fail** (185 across 22 files).

**Desktop**
- `cargo check` — **PASS** (1 dead-code warning, no errors).
- `npm run build` — **PASS** (`tsc && vite build`).

---

## Known gaps / notes

- **WhatsApp adapter is a TODO.** `gateway status` lists it as
  `{id:"whatsapp", configured:false}`; only Telegram is implemented today.
- **3 skipped tests** are conditional integration tests
  (`cli-bridge.integration.test.ts` — "no CLIs detected on PATH" and gated
  OAuth/port checks). They are environment-dependent, not regressions, and skip
  cleanly when no AI CLI / free port is available.
- `vault backup --json` writes to `~/prevail-backup-<date>.tar.gz` by default;
  pass `--output <path>` to redirect.
- Desktop `cargo check` emits one `dead_code` warning
  (`IngestedArtifact` unused in `src/ingestion/mod.rs`) — harmless, slated for
  cleanup when ingestion lands.
- Vite reports a >500 kB JS chunk for the desktop bundle — functional, but a
  code-splitting pass is a future optimization.
