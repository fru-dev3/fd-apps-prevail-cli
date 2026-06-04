# Changelog

All notable changes to prevAIl are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project tracks [Semantic Versioning](https://semver.org/) on the `vX.Y.Z` tag scheme.

The release page on GitHub mirrors the same notes for each tag:
<https://github.com/fru-dev3/prevail/releases>

---

## [1.0.0] — 2026-06-04 · 1.0

prevAIl 1.0. The deliberation cockpit is feature-complete for its scope, production-hardened for its threat model, and OSS-ready for outside contribution.

### What 1.0 means

This release is the consolidation marker for the v0.9.x + v0.10.0 audit cluster. Nothing new ships in 1.0 itself — it's the version where:

- **The threat model is documented.** SECURITY.md, docs/threat-model.md, and the operating manual cover what's defended and what isn't.
- **The security defenses are real, not aspirational.** Prompt injection hardening, tamper-evident logs, MCP token auth, council cost caps, output truncation, secrets at chmod 0600 — all in code, all under test.
- **The operational surface is complete.** Vault prune, backup, restore, verify. Debug log with rotation. Self-update.
- **The OSS scaffolding is in place.** CODE_OF_CONDUCT, CONTRIBUTING, ISSUE_TEMPLATE/, PR template, docs/, pinned scope discussion, Homebrew formula.
- **The codebase is maintainable by one person.** Biome lint in CI, `<Chip />` deduplication, `<ErrorBoundary />` defense in depth, void-silencer cleanup, two of the largest files refactored.
- **The tests carry their weight.** 181 passing, 0 failing — coverage across the security primitives, the vault tooling, the upgrade flow, the chip rendering, the error recovery.

### What 1.0 does NOT mean

- **Not enterprise-grade.** prevAIl is single-user by design. See SECURITY.md and the pinned scope discussion.
- **Not the final feature set.** Several follow-ups are tracked as GitHub issues (#2 app-scope overrides, #3 recall JOIN, #4 MCP/Telegram framework+lens). They'll ship as 1.x minor releases.
- **Not a stability freeze.** Semver discipline starts now: breaking changes only on major bumps. Within 1.x, any keyboard shortcut / slash command / config key / vault file shape / persisted format is stable.

### Going forward

- v1.x minor releases: new lenses, new frameworks, new connectors, new docs.
- v1.x patches: bug fixes, dependency bumps, perf tweaks.
- v2.0.0 would be a deliberate design break — none on the roadmap.

Thank you to everyone who chased a screenshot bug in the chips, found a typo in the threat model, or just used the cockpit. The deliberation was the point.

---

## [0.10.0] — 2026-06-04 · Code quality + refactors + self-update

Phases 5, 6, and 7 of the production-readiness audit. The codebase is now smaller, more maintainable, defensively wrapped, and can update itself.

### Added — Biome lint + format
- `biome.json` at the repo root, `bun run lint` and `bun run lint:fix` scripts.
- 21 unused imports auto-removed across 15 files.
- CI workflow now runs `biome check` before typecheck.

### Added — `<Chip />` shared component
- New `src/chip.tsx` encodes the proven opentui-safe pattern (two adjacent `<text>` cells, NBSP-prefixed value, dim label + highlighted value) in one place.
- 11 chip sites replaced across `workspace-config-bar.tsx` and `branding.tsx`. ~150 lines of duplication removed.
- 9 new chip tests covering NBSP prefix, attributes bit, color overrides, click wiring.

### Added — `<ErrorBoundary />` around every major pane
- Sidebar, DomainDetail, ChatPane, ToolsPanel, CouncilConfigPanel, EditorPane each wrapped.
- Render-time crash shows "this panel crashed — press R to reload, or q to quit" instead of taking down the whole cockpit.
- Errors logged to `~/.prevail/debug.log` via the existing `logDebug` channel.
- Shift+R force-remounts every boundary by bumping a reset counter.

### Cleaned — `void varName` silencers gone
5 silencer statements removed (`fwScope`, `lensScope`, `bundledDemoVaultPath`, `existsSync` in wizard, `activeChats` / `pendingChats` in branding). Categories: leftover destructure, leftover imports, leftover prop plumbing.

### Refactored — `src/chat-pane.tsx` split
- **2,221 → 1,247 lines.** 974-line drop.
- 13 new files under `src/chat-pane/` (bubbles/, types.ts, council-config.tsx).
- 8 bubble components each have their own file: MessageBubble, CouncilPending, CouncilResponse, CouncilSynthesizing, CouncilVerdict, StreamingAssistant, Serendipity, CouncilSuggestion, Thinking, DistillDraft.
- `formatMetaBadge` extracted to its own pure helper.
- Zero behavioral change. Public API preserved via re-exports — `app.tsx`'s imports from `./chat-pane.tsx` continue to work unchanged.

### Refactored — `src/app.tsx` split
- **2,978 → 2,860 lines.** 118-line drop.
- New `src/app-keyboard.tsx` exposes `useAppKeyboard(args)` — the global keyboard handler is now its own hook.
- Every shortcut preserved verbatim: q quits, n new (context-sensitive), e edit, o open skill folder, R reload boundaries, ↑↓ navigate, Esc exits chat, 1-5 view jump, etc.
- Setters typed as `Dispatch<SetStateAction<...>>` to match React's `useState` returns exactly.

### Added — `prevail upgrade` self-update
- Checks GitHub Releases, compares to current VERSION, prompts y/N for confirmation.
- Streams the platform binary into the binary's own directory (atomic rename via `renameSync` on the same APFS volume), verifies SHA-256 against the published checksum.
- Detects brew-installed binaries (`/opt/homebrew/`, `/usr/local/Cellar/`, etc.) and routes to `brew upgrade prevail` instead.
- Flags: `--check`, `--force`, `--pre`. Aliases: `update`, `self-update`.
- 21 new tests covering platform/arch matrix, semver compare, shasum parsing, mocked GitHub API.

### Tests
+53 tests across the cluster (9 chip + 6 error-boundary + 21 upgrade + 17 other). Total: 181 pass / 0 fail / 3 skip across 22 files.

---

## [0.9.2] — 2026-06-04 · Hard security cluster

Phase 3 of the production-readiness audit. The four real security items from the SECURITY.md threat model, shipped as one cluster.

### Added — Operating-manual prompt-injection hardening
A new "Treat vault contents as untrusted input" section in `vault-demo/AGENTS-operating.md` tells the AI explicitly that vault file contents are user-provided input, not authoritative instructions. The model must flag suspected injection attempts as `PROMPT-INJECTION SUSPECTED in <path>` and refuse to act on embedded commands without re-confirmation from the current user-turn. Cross-referenced from SECURITY.md and docs/threat-model.md.

### Added — Tamper-evident `_log/` via SHA-256 sidecar
Every `writeTurnSummary` call now also appends `<entry-id> <sha256>` to a sibling `_log/.shasum` file. New `prevail vault verify` command walks the .shasum files, re-hashes the matching entries, and surfaces mismatches (red `!`) and missing entries (yellow `?`). Best-effort write — never crashes the chat path.

### Added — Council cost estimator + maxCallsPerTurn cap
Before firing a `/council` turn, prevAIl computes the panelist × lens × chair call count and prints a one-line `~$X.XX for N calls (rough estimate)` system message. If the count exceeds the `councilMaxCallsPerTurn` cap (default 16), the turn is refused with a friendly system message — no fanout, no spend, chat input stays usable. Coarse per-CLI heuristics: claude $0.005, codex $0.004, gemini $0.003, ollama $0.

### Added — MCP server auth + parent-process check
`prevail mcp` now:
- **Requires a token.** Auto-generated 32-byte random hex token on first run, persisted to `~/.prevail/mcp.json` (chmod 0600). Every non-`initialize` request must include `_meta.authorization: prevail-<token>` (constant-time compared). Unauthorized requests get JSON-RPC error -32001.
- **Verifies the parent process.** Refuses to start if the parent isn't a TTY or a known IDE/MCP client (vscode, cursor, jetbrains, claude, goose, continue, cline, etc.). Pass `--unsafe-detach` to override for legitimate exotic launchers.

### Tests
+22 new tests (council-cost 7 + mcp-config 4 + tamper-evident verify 4 + mcp-server smoke 7). Total: 146 pass / 0 fail / 3 skip.

---

## [0.9.1] — 2026-06-04 · Operational hygiene + vault tooling

Phase 2 of the production-readiness audit. Five tasks shipped in one tag — all small, isolated, additive.

### Added — `prevail vault prune --older-than <duration>`
Walks `<vault>/<domain>/_log/*.md` and `<vault>/<domain>/_journal/{decisions,facts}.md` older than the threshold. Dry-run by default; `--force` to actually delete. Reports "would free X / N files" before doing anything. Will NEVER touch `state.md`, `QUICKSTART.md`, `PROMPTS.md`, `open-loops.md`, or `skills/`. Duration syntax: `30d`, `12h`, `7d12h`, `1y`.

### Added — `prevail vault backup` and `prevail vault restore`
Tarball the vault + safe parts of `~/.prevail/` (config.json, sessions DB). Explicitly excludes `telegram.json`, `mcp.json`, `connectors/*/auth/*`, and anything matching `*.token`. Restore prompts for the exact vault basename to confirm before overwriting.

### Added — `prevail vault verify` (placeholder)
No-op stub for now. Will be the tamper-evident-log verifier when #41 lands.

### Added — `~/.prevail/debug.log` with rotation
New module `src/debug-log.ts` exposes `logDebug(category, message, meta)`. Synchronous JSON-Lines append. Rotates at 5MB (keeps 3 archives). All files chmod 0600. `prevail doctor --debug` prints the last 50 entries.

### Added — Output caps on lightweight LLM calls
`runChatTurn` gained an optional `maxOutputChars` field. When the stream crosses the cap, the child process gets SIGKILL'd via process group and the reply returns sliced with a `... (truncated at N chars)` suffix. Wired into:
- Journal distillation — 8000 chars
- Auto-council classifier — 200 chars (it should only say YES or NO)
- Serendipity post-turn — 4000 chars

### Hardening — secrets at rest
Audited every `~/.prevail/` writer. All sensitive files (config.json, telegram.json, OAuth refresh tokens) already chmod 0600. No new code needed; verified and documented.

### Docs
README Scope section now includes the vault-sync caveat: sync `<vault>/` only; **never** sync `~/.prevail/`.

### Tests
+27 new tests (14 vault-ops + 6 debug-log + 7 cli-bridge truncation). Total: 131 pass / 0 fail / 3 skip.

---

## [0.9.0] — 2026-06-04 · OSS scaffolding + threat model

Phase 1 of the production-readiness audit. Docs and OSS scaffolding only — no code changes, no behavioral changes. Sets up the foundation the subsequent security hardening work will lean on.

### Added — Security posture
- **SECURITY.md** at repo root — full threat model, in-scope / out-of-scope, known limitations, private reporting flow via GitHub Security Advisories.
- **docs/threat-model.md** — long-form expansion of SECURITY.md with code cross-references, trust-boundary diagram, worked example of a prompt-injection scenario.

### Added — Open-source scaffolding
- **CODE_OF_CONDUCT.md** — direct, project-tailored expectations for contributors.
- **CONTRIBUTING.md** refresh — adds Welcome / Before-you-start / Dev setup / Code style / Commit convention / PR flow sections. Existing LifeApp plugin protocol content preserved verbatim.
- **.github/ISSUE_TEMPLATE/** — bug report + feature request YAML form templates, plus config.yml that disables blank issues and links security reports to the private advisory channel.
- **.github/PULL_REQUEST_TEMPLATE.md** — short checklist (typecheck, build, tests, CHANGELOG, backwards-compat).

### Added — Architecture docs
- **docs/data-flow.md** — how a turn moves end-to-end through cockpit → CLI → \_log → \_journal → benchmark, plus the vault folder layout.
- **docs/extending.md** — how to add a framework, lens, CLI bridge, ConfigBar chip, slash command. Line-targeted references into the codebase.
- **docs/scope-discussion.md** — what prevAIl is and isn't, copy-paste-ready for the pinned GitHub Discussion.

### Added — Distribution scaffolding
- **Formula/prevail.rb** — Homebrew formula targeting the prebuilt release binaries (macOS arm/intel + Linux arm/intel). SHA256 placeholders to be filled by release automation.
- **Formula/README.md** — release-process notes for maintainers.

### Added — README updates
- New **Platform** section documenting bun-only runtime and supported targets (macOS arm64/x64, Linux arm64/x64, Windows via WSL).
- Expanded **Docs · changelog · roadmap** to link the new docs/ files.
- New **Scope** section before License making the single-user / not-SaaS framing explicit.

### Added — Pinned GitHub issues
- [Issue #1](https://github.com/fru-dev3/prevail/issues/1) — pinned "Project scope" canonical reference.
- [Issue #2](https://github.com/fru-dev3/prevail/issues/2), [#3](https://github.com/fru-dev3/prevail/issues/3), [#4](https://github.com/fru-dev3/prevail/issues/4) — three "follow-up" items lifted from prior commit messages into real tracked work.

---

## [0.8.2] — 2026-06-04 · Skills tab — edit, open, scaffold

Three new entry points into the Skills tab. Zero impact on existing flows (click-to-select still toggles chat-context selection, all other tabs unchanged).

### Added — Edit the highlighted skill
- **Keyboard:** `e` on the Skills tab opens the highlighted skill's `SKILL.md` in the bundled `EditorPane`. Reuses the existing edit-mode plumbing — same `Ctrl+S` to save, same `Esc` to back out.
- **Mouse:** the highlighted row sprouts a right-aligned `✎ edit` chip; click to fire the same action. Non-cursor rows render unchanged — no chip clutter.

### Added — Open the skill folder
- **Keyboard:** `o` on the Skills tab opens the highlighted skill's folder in Finder / Explorer / xdg-open. Lets you edit any file in the skill bundle, not just `SKILL.md`.
- **Mouse:** the highlighted row also gets a `▸ open` chip alongside `✎ edit`. Both have `stopPropagation` so clicking either never accidentally toggles the skill's chat-context selection.

### Added — Scaffold a new skill
- **Keyboard:** `n` on the Skills tab opens the CommandBar with prompt `new skill in <domain> ›`. Submit a name → writes `<vault>/<domain>/skills/<id>/SKILL.md` with a minimal frontmatter + section template. Cursor lands on the new row so `e` immediately opens it in the editor.
- **Mouse:** a `+ new skill` footer row appears at the bottom of the skills list.
- **Toolbar:** the bottom `[n new]` chip is now context-aware — on Skills tab it scaffolds a skill; elsewhere it still scaffolds a domain.

### Help text update
The skills tab subheader now reads: `[n] new skill  ·  [e] edit highlighted in $EDITOR  ·  [o] open its folder`.

---

## [0.8.1] — 2026-06-04 · UI polish + the GIFs the v0.8 release deserved

A polish pass on top of v0.8.0's seven new features.

### Fixed — ConfigBar chips
The ConfigBar rendered correctly during typecheck but the chips' values were either clipped, missing, or run-together in the actual terminal. Five distinct bugs, each found by user screenshot:
- **Values blank.** opentui clips when a single `<text>` mixes a literal segment with a JSX interpolation. Pre-building a single template literal didn't help; splitting label + value into TWO `<text>` cells inside one `<box>` did.
- **No space between label and value.** opentui strips BOTH leading and trailing whitespace inside text cells. Fix: leading character on every value cell is a non-breaking space (U+00A0), which terminals render as a space but opentui treats as a normal glyph.
- **Inconsistent casing.** Framework + Lens labels (BLUF, FIRST PRINCIPLES) were uppercase but on/off/suggest were lowercase. All values now uppercase for visual uniformity.
- **Labels and values same color.** Hard to scan. Now two-tone: label dim (theme.fgDim), value highlighted (aiAccent cyan, or gold for Council when ON).
- **Council scope-hint noise.** Removed the `· domain` / `· global` suffix on framework/lens chips — the user already knows scope by which surface they clicked.

### Fixed — `_log/` meta line carries the full cockpit state
The `> meta:` blockquote on every chat-turn entry now includes the FULL config snapshot at send time:
```
> meta: claude · model=claude-opus-4-7 · framework=BLUF · lens=CONTRARIAN · web=on · serendipity=off · council=on
```
Date stays implicit in the file path, time in the `## HH:MM` section header. Every other dial that could have shaped the turn is now greppable.

### Changed — `journal/` → `_journal/`
Parity with `_log/`. Same naming convention for both AI-managed sidecar folders.

### Added — Two new demo GIFs
- `assets/demo.gif` — main hero. Boot, walk the 20+ life domains, return. Shows wordmark + sidebar + active workspace + ConfigBar.
- `assets/deliberation.gif` — navigate to wealth, walk the tabs (state / quick start / prompts / skills / back to chat). Shows the per-domain workspace structure.

---

## [0.8.0] — 2026-06-04 · Memory, judgment, calibration

Six features bolted onto v0.7.0's council foundation. Each one stands alone; together they turn the cockpit from "ask multiple models" into a system that remembers, distills, and audits itself.

### Added — ⬡ Web toggle on the ConfigBar
The `webAccess` allow/deny setting was buried in the Tools panel. Promoted to a first-class clickable chip on the WorkspaceConfigBar AND the global defaults block in the banner. Click cycles allow ↔ deny.

### Added — ▣ Checkpoint (raw transcript persistence)
Default ON. Every chat turn (single chat + council verdict) appends the full prompt + full reply verbatim to `<domain>/_log/YYYY-MM-DD.md`. The existing summarized log shape is preserved for `raw: false` callers; the user's chats are no longer truncated to 220/400 chars. New `▣ Save` chip on the ConfigBar with per-domain override.

### Added — `journal/` folder with AI-distilled decisions + facts
New module `src/journal.ts`. After every turn, an async lightweight call extracts:
- `DECISION:` — one short sentence naming the decision the user is making, or NONE.
- `FACTS:` — up to 5 bullets of concrete numbers / dates / rules surfaced, or NONE.

Appended to `<domain>/journal/decisions.md` and `<domain>/journal/facts.md` with timestamped backlinks to the `_log/` entry that produced them. Best-effort and silent on failure — the raw `_log/` stays the source of truth, journal is the index on top.

### Added — ◉ Serendipity (Option B)
Per-domain toggle, OFF by default. When on, every turn fires a SECOND lightweight call after the main reply asking for one non-obvious adjacent angle, fact, or question the user did NOT ask but would benefit from. The result lands as its own dim `◉ serendipity` bubble below the main reply. Distinct from the main answer so the visual hierarchy makes it obvious which is which.

### Added — ◐ Auto-council detection
Three modes (`autoCouncil` config, default `"suggest"`):
- `"off"`: skip the classifier; sendMessage runs single chat as today.
- `"suggest"`: fire classifier in PARALLEL with the chat. On YES, append a passive `⚖ this looks council-worthy` bubble. Click re-runs through council. Zero latency penalty on the main reply.
- `"auto"`: BLOCK on the classifier. On YES route to runCouncil; on NO fall through to chat. The user opts into latency for auto-routing.

Classifier prompt explicitly includes the user's stated examples — "Summarize this email" (NO), "Should I leave my job?" (YES). Per-domain override available.

### Added — Canonical benchmark dataset
The biggest one. Three new CLI subcommands wrap a new `<vault>/benchmark/` area:

- `prevail bench seed --domain <name>` — write a stub canonical question with FILL-IN placeholders.
- `prevail bench seed --from-log <domain>` — import the most recent council verdict from that domain's `_log/` as a draft (the user's ground-truth answers already live there).
- `prevail bench run --canonical [--cli <kind>] [--model <id>] [--council]` — fire every canonical question at the target CLI (or council). Reuses `runChatTurn` + `runCouncilOneShot` so behavior matches the cockpit. Writes results + timing to `<vault>/benchmark/runs/<date>_<label>/results.{md,json}`.
- `prevail bench score [--run <name>] [--no-judge]` — two-layer scoring:
  - **Mechanical keyword match** (0-100%): hits/misses on `expected_verdict_keywords`. Objective floor.
  - **LLM-as-judge** (0-10): tight rubric (10 = right decision + matching reasoning, 0 = wrong or fails to commit). Per-question rationale captured.
- `prevail bench leaderboard` — cross-run scoreboard sorted by judge_avg then keyword_avg.

Distinct from the bundled `bench/questions/` generic suite. This one is for the user's personal Q&A with KNOWN ground truth — the test you can point at a new model the day it ships.

### Fixed — Council escalation symmetry
`council-suggestion` bubble reuses the existing `kind: "council"` ChatCommand path, so a click re-fires the prompt through `runCouncil` with no special-case glue.

---

## [0.7.0] — 2026-06-04 · Council, lens, framework — the deliberation release

The biggest jump since v0.6. prevAIl's pitch is now sharply about ONE thing — hard decisions across multiple models — and the cockpit, persistence, and ergonomics all aligned around that.

### Added — Cognitive lenses
- **8 lenses** that change HOW a panelist attacks a question (orthogonal to frameworks, which change how the answer is STRUCTURED): `FIRST PRINCIPLES`, `OUTSIDER`, `CONTRARIAN`, `EXPANSIONIST`, `EXECUTOR`, `ALIEN`, `MOM`, `DAD`.
- **Lens = "all" fanout.** Every council panelist runs every lens (4 CLIs × 8 lenses = 32 panelist calls per question). The chair synthesizes ACROSS lenses with a different prompt — "divergence is the signal, not noise."
- **Per-domain lens overrides** stored in `domainLenses`. Cycling the chip on a domain workspace mutates that domain only; cycling the global chip in the banner sets the fallback.

### Added — Per-domain framework overrides
- Same mechanic, `domainFrameworks` map. Workspace bar chip = domain override; banner chip = global fallback. `resolveResponseFramework` / `resolveResponseLens` centralize resolution so every consumer (council runner, CLI bridge, chat status line) agrees.

### Added — Per-bubble metadata + decision log
- **Every assistant bubble** renders a dim badge underneath: `claude · claude-opus-4-7 · ◆ BLUF · ◇ CONTRARIAN`. Captured at SEND TIME, not render time.
- **Default-model fallback.** When a panelist runs on a CLI's default model, the badge shows `gpt-5.4 (default)` rather than blank. Every panelist reads uniformly informative.
- **Per-domain decision log.** `writeTurnSummary` emits a `> meta: <cli> · framework=… · lens=…` blockquote in `<domain>/_log/YYYY-MM-DD.md`.
- **SQLite persistence.** New `messages_ext` sidecar table (FTS5 won't ALTER) joins framework/lens onto message rowid.

### Changed — UI architecture
- **Unified ConfigBar.** `⚖ Council · ◆ Framework · ◇ Lens   ▸ vault   ✎ edit` — rendered at the BOTTOM of the content area in BOTH chat and workspace mode. Built once in `app.tsx`, passed as `bottomBar` to ChatPane and DomainDetail.
- **TabStrip slimmed.** Council toggle and configure left the strip — they lived there AND on the workspace bar. Picking one removes the duplication.
- **Banner compacted** to match the wordmark's 7-row height. Defaults block is two rows: `⚖ Council · ◆ Framework · ◇ Lens` / `◇ configure · ▸ tools`. Each chip gets a distinct glyph.

### Changed — Apps collapsed
- `SHOW_APPS = false` at the top of `src/app.tsx` hides the LIFE APPS sidebar section, the `s` swap-focus key, AppDetail, and the new-app flow. The connector architecture stays in the codebase. Flip the constant to re-enable when the connector → council grounding pipeline is wired.

### Fixed
- **Gemini ESC cancel.** The `gemini` wrapper script swallows SIGTERM. Spawn with `detached: true` and signal the whole pgroup with SIGKILL.
- **Overlay keyboard leak.** Arrows inside Tools / Council Config were navigating the sidebar underneath. Overlays now own the keyboard; only ctrl+c propagates.
- **Skills tab header bleed.** Switched to single template literals — multiple JSX expressions inside one `<text>` caused opentui to interleave lines.
- **Branding chip clipping.** Split into two rows with distinct glyphs (⚖ ◆ ◇).
- **"· domain" scope hint removed.** Scope is implicit in where the chip lives.

### Skill count accuracy
- Connector stubs (`type: app` in frontmatter) no longer counted toward domain skill totals.

---

## [0.6.1] — 2026-06-03 · UX polish + visibility

Iterative fixes to v0.6.0 based on real-use feedback. No new features so much as **making the existing ones findable**.

### Fixed — Navigation
- **No more "press Escape to see the app."** Removed the auto-open-chat `useEffect` that was silently re-setting mode to "chat" on every navigation, undoing every nav-fix attempt. Clicking a sidebar item now lands you on the workspace immediately.
- **Tab strip off-by-one.** Clicking `state` was selecting `quickstart`, clicking `skills` was selecting nothing. TabStrip array includes `chat` at index 0 but `VIEW_ORDER` doesn't — the click handler was passing TabStrip indices straight to `setViewIdx`. Now offset by 1 so each tab actually selects what it says.
- **Arrow nav + Enter / `c` keys** no longer force-open a separate chat pane. The embedded chat in every workspace is enough.

### Fixed — Layout
- **Wordmark spacing.** Five iterations on this. Final shape: 10×7 uniform ANSI-Shadow-style letters in identical bounding boxes, all gaps equal (single cell between every letter, no group breaks). The `A` glyph's body is now centered with its top rows. Banner padding above and below the hero.
- **Domain pane: nothing below the chat input.** No more reference strip — chat fills the entire pane, input at the very bottom.
- **App Overview compacted** from 8 labeled rows to 4 (`kind` / `how` / `scope` plus the title line carrying status + last probe). Issue + fix rows only appear when the connection is broken.

### Added — Visibility
- **Workspace config bar** at the top of every domain and connector pane: `📂 open vault` (spawns Finder/Explorer/xdg-open) · `⚖ Council ON/OFF` · `◆ Framework <name>`. All clickable. Three things users were doing via slash commands before.
- **Global toggles in the banner top-right**: `defaults  ⚖ ON/off  ⚙ configure  │  ◆ <framework>`. The `⚙ configure` link opens the full CouncilConfigPanel (pick engines, pick models, pin the chair). The `⚖` toggle writes a `councilDefaultOn` to config — per-chat overrides still win when set.
- **Panel health row in the banner**: `panel  ✓ Claude  ✓ Codex  ⚠ Gemini  ⠋ Ollama`. You see BEFORE firing council which panelists are healthy.
- **Per-domain prompt suggestions.** DomainChat empty-state reads `PROMPTS.md` from the domain folder and extracts question-shaped lines; falls back to generic prompts when the file is sparse.
- **Multi-select skills** in the domain Skills tab. Click a skill to select it (☑); click again to unselect. Selected skills are injected as `<selected_skills>` context into the next chat turn.

### Added — Defaults
- **Domains default to the chat tab.** Clicking a domain in the sidebar opens its chat with suggested prompts — `state` / `quickstart` / `prompts` / `skills` are still one click away.
- **Single version source of truth** at `src/version.ts`. Imported by `--version`, the banner, and the MCP `serverInfo`.

### Skills shipped per connector (carried from v0.6.0)
- github: `pr-queue`, `repo-stars-trend`
- plaid: `list-institutions`, `recent-transactions`
- youtube-analytics: `channel-metrics`
- linkedin: `profile-views` (stub — browser runner phase 6)
- google-calendar: `today-events` (stub — MCP runner phase 5)

---

## [0.6.0] — 2026-06-03 · connectors are workspaces, not manifests

Apps stop being passive manifest viewers and become **live workspaces**. Clicking any connector now lands you on a `Overview + Chat` page: connection status at the top, a working chat with the connector's data right below. No more "click Skills to find anything."

### Added — Tabbed connector workspace
Every app now has its own 5-tab workspace:
- **`Overview + Chat`** — compact connection card on top, live chat scoped to this connector below. Per-app starter prompts ("what was my biggest spend last month?" for Plaid, "which PR has been open longest?" for GitHub). Streaming responses.
- **`Auth`** — env vars / files with ☑/☐ live check marks + a plain-language explanation of what each integration type (`api`/`oauth`/`browser`/`mcp`/`a2a`/`manual`) actually means.
- **`Sync`** — scheduled skills with their cron expressions.
- **`Skills`** — runnable skills with `▶ Run` buttons + inline streaming results.
- **`Data`** — file tree under `<connector>/data/` with sizes + mtimes.

Connector workspace replaces the domain-style `state | loops | quickstart | prompts | skills` tabs when viewing an app — apps are connectors, not life domains, so the navigation now matches the mental model.

### Added — Skill execution layer (`src/connector-skills.ts`)
Each skill is one markdown file under `<connector>/skills/<id>.md` with YAML frontmatter declaring runner type, trigger, auth requirements, inputs, and outputs.

**LLM runner** (the leveraged 80% case): spawns a panelist CLI with the skill description + scoped env + inputs. Most flexible runner type — covers everything from "list institutions" to "monthly receipts" without writing imperative HTTP/browser/MCP code.

Security guards:
- Output paths confined to `<connector>/data/` (no `../` escape)
- `buildSkillEnv()` starts from `scrubbedEnv()`, adds back **only** the auth keys the skill explicitly declared
- `${input.x}` / `${env.X}` substitution is strict — unknown vars throw
- chmod 0600 on every written output
- Per-skill log under `<connector>/_log/`

### Added — Skills shipped per connector
| Connector | Skills | Runner |
|---|---|---|
| github | `pr-queue`, `repo-stars-trend` | ✅ llm (runnable today) |
| plaid | `list-institutions`, `recent-transactions` | ✅ llm (runnable today) |
| youtube-analytics | `channel-metrics` | ✅ llm (runnable after OAuth) |
| linkedin | `profile-views` | ⚠ stub — browser runner ships in v0.6.x |
| google-calendar | `today-events` | ⚠ stub — MCP runner ships in v0.6.x |

### Added — Connector CLI commands
```bash
prevail connectors skills <id>                   # list runnable skills
prevail connectors run <id> <skill> --input k=v  # execute a skill
```

### Added — Manifest scaffolding for vault apps
Vault apps (the ones authored before this redesign, no `manifest.json`) now show a yellow `⚠ No manifest yet` panel with a `⊕ Scaffold` button. One click writes a starter `manifest.json` + empty `skills/` dir into the app folder, idempotently.

### Added — Architecture doc
`docs/connector-architecture.md` lays out the full 7-phase plan: skill schema + LLM runner (this release), API runner, tabbed workspace (this release), connector-scoped chat (this release), sync orchestration, browser runner, A2A as MCP-over-network.

### Fixed
- **Wordmark spacing** — every row of PREV / AI / L is now padded to the widest row in its group, leading space added inside AI to compensate for V's tapered right edge, GROUP_GAP bumped to 3 spaces. AI no longer looks clumped against PREV.
- **Connector workspace was nested inside the Skills tab** — apps now own the entire pane; domain-style tabs (`state | loops | quickstart`) are no longer shown for apps.

---

## [0.5.0] — 2026-06-03 · calibration + distribution

Five-feature release. The product becomes smarter *about you* (calibration loop), reaches further (MCP), and reads faster (streaming) — without breaking the "everything is markdown" promise.

### Added — Streaming responses
Each panelist's text streams into its bubble as the model produces it. `runChatTurn` gains an `onChunk` callback; council runner exposes `onPanelistChunk(idx, delta)` so the UI updates the right bubble. Wired through claude/codex/gemini stdout + ollama SSE. Perceived latency drops 80% — same end-to-end time, but you see tokens land in real time instead of staring at a 30-second spinner.

### Added — MCP server mode
`prevail mcp` speaks JSON-RPC 2.0 over stdio — the standard MCP transport every host (Claude Desktop, Cursor, Continue, Goose, ChatGPT Desktop) speaks. No SDK dependency. Five tools exposed: `council` (full panel + verdict), `chat` (single-CLI), `list_domains`, `read_state`, `read_log`. Calls invoked via MCP write to the same vault log as TUI/Telegram. Every other agent ecosystem becomes a distribution channel.

### Added — Council vs. yourself (calibration loop)
- **`/gut <your take>`** before `/council` captures your gut answer in one line.
- Both gut + verdict + a 90-day `retro_due` date are written as an HTML-comment metadata line at the top of the log entry. Invisible in rendered markdown, greppable on disk.
- **`/calibration pending`** lists log entries past their retro_due where you haven't recorded an outcome.
- **`/calibration outcome <id> <text>`** records what actually happened.
- **`/calibration status`** shows the running scoreboard: "right when you agreed with council X%, right when you disagreed Y%". Stored as `<domain>/_calibration.md`, regenerable from the log entries.

### Added — Markdown-native vault memory
Embeddings live as a single inline comment line right under each log entry's time header — no DB, no separate index file, the vault stays portable. After every `writeTurnSummary`, the runner asks the Ollama-detected embedder (default `nomic-embed-text`) for a 384-dim vector and splices it in. At query time, linear scan + dot product across the vault → top-k most semantically similar prior decisions are prepended as `<context>` to every council fanout. Sub-100ms at personal-vault scale. Silent fallback when no embedder is available.

### Added — Public council benchmarks
- `bench/` ships with three example questions across `wealth/`, `career/`, and `health/`.
- **`prevail bench list`** shows the suite.
- **`prevail bench run [--domain X] [--question Y]`** fires `/council` on each question, writes per-question results + a top-level markdown summary table to `~/.prevail/bench-results/<date>/`.
- Methodology + scoring rubric pattern documented in `bench/README.md`. PR-able question contributions.

---

## [0.4.0] — 2026-06-02 · auth, locks, paths

Hardening + the OAuth runner that makes the YouTube-Analytics example actually work end-to-end. Two days after v0.3.0, all three deferred items from the audit close-out are now shipped:

### Added — OAuth 2.0 + PKCE runner
- **`prevail connectors oauth <id>`** (and `/connectors oauth <id>` in the TUI) walks the full authorization-code-with-PKCE flow:
  - Spins up a loopback HTTP server bound to `127.0.0.1` only (never `0.0.0.0`)
  - Opens the user's browser to the provider's consent screen
  - Catches the redirect with `state` parameter verification (CSRF protection)
  - Exchanges code for tokens with PKCE verifier
  - Saves the refresh token at `~/.prevail/connectors/<id>/auth/refresh.token` (chmod 0600)
  - 5-minute hard timeout so a stuck browser never wedges the daemon
- **`refreshAccessToken(connectorId)`** — exchange the saved refresh token for a fresh access token. Used by the probe layer + any connector skill that needs Bearer auth.
- Generic over provider: works for Google services (YouTube Analytics, Calendar, Drive, Gmail), GitHub Apps, Notion, Linear — anything that speaks OAuth 2.0 + PKCE. Provider specifics (auth/token URLs, scopes, extra query params like Google's `access_type=offline`) live in the manifest's `oauth` block.
- YouTube Analytics example manifest now has a full `oauth` block so the flow works the moment the user sets `PREVAIL_GOOGLE_CLIENT_ID` + `PREVAIL_GOOGLE_CLIENT_SECRET`.

### Added — Cross-process file lock for schedule + briefing ticks
- New `src/file-lock.ts` provides `tryAcquireLock()` / `withLock()` based on atomic `O_EXCL` file creation. Used by `schedule.tickAndRunDue` and `briefings.tickBriefings`. Without this, running `prevail daemon --telegram` alongside the TUI could double-fire any cron entry that hit during the same minute on both processes — closing audit finding #10.
- Stale-lock recovery via PID liveness check (`kill -0`) + a 5-minute mtime floor, so a crashed daemon recovers cleanly on restart.

### Added — Vault path validation
- New `src/path-safety.ts` enforces "we never read or write outside the vault" as an invariant, not an emergent property:
  - `validateVaultPath()` rejects empty/relative/system paths (`/`, `/etc`, `/var`, `/System`, `/dev`, ...) and null-byte paths
  - `isSafeEntryName()` rejects domain/app entry names with control chars, null bytes, `..`, leading dots, or excessive length
  - `resolveSafeChild()` rejects symlinks that escape the vault root after `realpath` resolution
- `scanVault()` now applies all three at scan time so a misconfigured vault (or a symlink farm dropped into one) can't trick prevAIl into walking system directories.

### Added — Connectors CLI subcommand
- `prevail connectors list` — every detected connector with auth type + id
- `prevail connectors test <id>` — run the manifest's `auth_check` probe (same probe the UI runs on Test Connection)
- `prevail connectors oauth <id>` — kick off the OAuth flow

---

## [Unreleased]

### Security — adversarial sweep
External review surfaced 10 findings. This batch ships the 8 actionable ones:
- **Vault-shell gate** — `prevail schedule` now refuses `sh -c` unless `PREVAIL_ALLOW_VAULT_SHELL=1`. Without the gate, a malicious entry in a synced vault could RCE the operator.
- **Council injection chain blocked** — panelist replies have their `## section` headers blockquoted before embedding in the chair synthesis; the verdict parser now matches the LAST `## Verdict` section so a panelist-quoted fake can't override the chair's real verdict.
- **Telegram `from.id` validated** — both sender AND chat now must be on the allowlist, and non-private chats (groups/supergroups/channels) are refused outright.
- **Subprocess env scrub** — `PREVAIL_TELEGRAM_*`, `ANTHROPIC_API_*`, `OPENAI_API_*`, `GOOGLE_API_*`, `AWS_*`, `GITHUB_TOKEN`, `OP_SERVICE_ACCOUNT_TOKEN`, and `*_SECRET/*_PRIVATE_KEY/*_PASSWORD` are stripped before spawning Claude/Codex/Gemini. A prompt-injected `env | grep TOKEN` can no longer exfiltrate them.
- **Daemon abort cancellation** — Ctrl-C now SIGTERMs every in-flight panelist + briefing instead of leaving subprocesses burning API budget for up to 120s.
- **Session DB / config chmod 0600** — sessions.db, prompt logs, JSONL session files, and config.json are no longer world-readable under default umask.
- **Defensive manifest coercion** — a malformed `manifest.json` no longer crashes `scanCommunityApps` or hides itself by neutering legit entries; every field is type-checked, length-capped, and char-class-restricted.
- **Auto-summary quote-shields LLM output** — verdicts written to `_log/YYYY-MM-DD.md` use markdown blockquotes so a prompt-injected verdict can't persist as instructions for tomorrow's Paperclip/OpenClaw morning brief.

### Added — TUI surfacing for every feature
Every shipping feature now has a visible UI surface, not just a CLI subcommand:
- **`/telegram`** in chat — status, setup, allow/remove chat IDs, launch hint. Same `~/.prevail/telegram.json` storage as `prevail telegram`.
- **`/briefing`** in chat — list, add (with quoted-string parser for cron + prompt), remove. Same `.briefings.json` storage as `prevail briefing`.
- **`/connectors`** in chat — quick auth-status snapshot for every app at a glance.
- **`/ollama`** — switch the chat's engine to your local Ollama instance.
- **Test Connection button** in every app detail view — runs the manifest's declared `auth_check` and shows the live result (status, what's missing, fix hint).

### Added — Per-app auth validation
Each connector manifest can now declare an `auth_check` block describing how to verify it works. The probe runner handles five auth kinds:
- **`env-keys`** — required env vars must be present + non-empty (e.g. Plaid: `PLAID_CLIENT_ID`, `PLAID_SECRET`)
- **`file-exists`** — required files must exist (e.g. YouTube Analytics OAuth refresh token at `~/.prevail/connectors/youtube-analytics/auth/refresh.token`)
- **`command`** — spawn a binary, check exit code + optional stdout match (e.g. LinkedIn: `playwright --version`)
- **`http`** — GET a URL with optional `auth_header_env` for API-key auth; 401/403 surfaces as `expired` (e.g. GitHub: `https://api.github.com/user` with `GH_TOKEN`)
- **`mcp`** — verify a stdio MCP binary is on PATH OR ping an HTTP MCP server (e.g. Google Calendar via `mcp-server-gcal`)
- **`manual`** — manual-step list + optional freshness check on a watched file
The app detail view auto-probes on open and shows live status/detail/fix-hint plus a clickable `⟳ Test Connection` button. SSRF-guarded against metadata endpoints (`169.254.169.254`, `metadata.google.internal`).

Example connectors shipping with auth_check blocks: Plaid (api), LinkedIn (browser), YouTube Analytics (oauth), GitHub (http+api), Google Calendar (mcp).

### Fixed
- **Model picker shows version numbers first.** `claude-opus-4-7` / `claude-sonnet-4-7` / etc. now lead the council model picker; naked aliases (`opus`, `sonnet`, `haiku`) fall to the end. Previously the picker visually read as "opus / sonnet / haiku ..." and users couldn't tell which version each alias resolved to.

---

## [0.3.0] — 2026-06-02 · cockpit reaches out

This release pulls prevAIl out of the terminal. Local models, Telegram bridge, scheduled briefings, a self-curating vault, and a council that finally shows you the disagreement.

The competitive-research thesis for this release: the closest comparables in the personal-AI space (Hermes, Khoj, Goose, Agent Zero) all have at least one of these features. prevAIl now has all four, plus the things they don't — single binary, domain-folder UX, council across the CLIs you already pay for.

### Added — Engines
- **Ollama / OpenAI-compatible 4th engine.** Any endpoint that speaks `/v1/chat/completions` (Ollama, LM Studio, llama.cpp server, vLLM) is now a first-class panelist alongside Claude / Codex / Gemini. Detected automatically by probing `GET /api/tags` (falls back to `/v1/models`); shows up in the CLI bar and in the council picker. Privacy-sensitive domains (health, wealth) can run a local-model-only council.
  - Default endpoint: `http://localhost:11434` (override with `PREVAIL_OLLAMA_URL`)
  - Default model: `llama3.1` (override with `PREVAIL_OLLAMA_MODEL`)
  - Friendly probe error when the configured model isn't pulled (`ollama pull <name>`)
  - Council bubble color: electric cyan (matches the AI in prevAIl)

### Added — Council surfaces disagreement
- The chair's four-section synthesis output (`What each panelist said` / `Consensus` / `Divergence` / `Verdict`) is now **parsed and rendered as distinct visual blocks**, not one wall of text. The whole point of running a council is the disagreement; burying it inside paragraph three defeated the purpose. Three changes ship together:
  - **TUI verdict bubble**: when divergence is substantive, it renders in its own electric-cyan accent panel under a `🔀 Where panelists disagreed` header. The Verdict line gets its own gold-edged hero block. Title bar shows `· 🔀 disagreement` when the panel split.
  - **Telegram delivery** ships Consensus / Divergence / Verdict as **separate messages** so each section arrives with its own header on the user's phone — disagreement no longer drowns mid-paragraph.
  - **Vault writeback** flags days with disagreements via a `🔀 disagreement` tag in the daily log header, and uses the structured Verdict line as the assistant snippet (not the chair's full breakdown). Scrolling the log, the user can spot which calls were contentious without re-reading the whole council session.
- Falls back gracefully to plain rendering when the chair model ignores the format request — never silently drops content.

### Added — Scheduled domain briefings
- **`prevail briefing add --cron "<cron>" --domain <name> --prompt "<text>" [--mode council] [--deliver log|telegram|both]`** — typed, domain-aware, council-aware scheduled prompts. Sits on top of the existing 5-field cron scheduler but adds structure (which domain, which mode, where to deliver) that ad-hoc shell schedules don't carry.
- The daemon now runs a 60-second tick loop: any due briefing fires, the verdict lands in `<domain>/_log/YYYY-MM-DD.md` (via the same auto-summary hook), and if `deliver=telegram|both` the chair's verdict is pushed to every allow-listed chat. So at 7am your wealth panel runs, at 7:01am your phone has the verdict.
- `prevail briefing run <id>` — manual fire for testing without waiting for cron. Log delivery still happens; telegram delivery is daemon-only.
- Storage: `<vault>/.briefings.json` (separate from `.schedule.json` so the two systems can evolve independently).

### Added — Self-curating vault
- **Per-domain auto-summarization writeback.** Every chat turn (and every council verdict) appends a one-paragraph snapshot to `<domain>/_log/YYYY-MM-DD.md` — the user prompt + the reply, timestamped, tagged with the CLI/chair that answered. Over time each domain becomes its own decision log without the user having to take notes. Hooks the TUI's `sendMessage` + council-verdict path AND the Telegram daemon's chat/council reply path through one shared `writeTurnSummary()` helper. Pure heuristic (no extra LLM call), silent failure mode (never blocks the user).

### Added — Telegram bridge
- **`prevail daemon --telegram`** — headless mode that exposes the cockpit over Telegram. Same engines, same council, same `/framework` setting; just from your phone instead of the terminal.
  - `prevail telegram setup <bot-token>` — bootstrap (token from @BotFather)
  - `prevail telegram add-user <chat_id>` — mandatory chat-ID allowlist (no open access)
  - Per-chat state: domain, CLI, model, council on/off — set via `/domain`, `/use`, `/council on`
  - Council fanout from Telegram: each panelist arrives as its own message, verdict gets a `⚖` header with the chair label
  - Long-poll mode (no webhook / tunnel needed) — works behind NAT and on any laptop
  - Token stored at `~/.prevail/telegram.json` (chmod 600), or `PREVAIL_TELEGRAM_TOKEN` env var
- Extracted `runCouncilOneShot()` from app.tsx into `src/council-runner.ts` so the TUI and the daemon share the same fanout + synthesis pipeline (single source of truth for what "the panel" and "the verdict" mean).

---

## [0.2.0] — 2026-06-02 · rebrand + council mode

The launch of **prevAIl** (formerly `aireadyu`). Repo, binary, and brand all moved. Headline feature is **council mode** — ask one question, get three AIs in parallel, and a synthesized verdict.

### Added — Council
- `/council <prompt>` (or toggle `▣ Council ON` in the tab strip) fans the question out to Claude, Codex, and Gemini in parallel; a chair model then synthesizes a single `⚖ council verdict` from the panel.
- Multi-model panels: run Opus 4.7 + 4.6 in the same council to compare versions head to head.
- Configurable chair: pin who synthesizes the verdict, or leave it on `auto`.
- Conversation context preserved across follow-up turns (each panelist sees prior verdicts + prior questions).
- Escape cancels the whole batch — SIGTERMs every panelist + the chair, drops a `(cancelled)` bubble, returns the chat to idle.
- Council config UI gained: verdict-synthesizer picker, codex auth-tier annotation (`*` on pinned models with a footer explaining `codex login --api-key`), bigger configure button (replaced the tiny ⚙ glyph).

### Added — Quality of life
- **↑/↓ in the chat input recalls prior prompts** — terminal-style. Walks the current session AND prior chat sessions for the same domain (persisted in the SQLite log). Adjacent duplicates collapsed. Per-chat, so wealth's stack and content's stack don't bleed.
- **Session usage meter** in the status line: `4 calls · 12k↑ 8k↓ tokens · ~$0.16`. Counts every CLI invocation (council = N+1 per turn), tokens from a 4:1 char rule, cost from a blended ~$3/$15 per-1M rate. Rendered with `~` so nobody confuses it for an invoice.
- `/distill` is now **council-aware** — when distilling a chat that includes council exchanges, the transcript preserves panelist + verdict attribution and the prompt asks the model to capture the decision *framework* the council used, not flatten to one voice.

### Added — Docs + distribution
- `landing/` static site scaffold ready for `prevail.ai` deploy (Vercel / Netlify / Cloudflare Pages).
- Council demo ASCII frame at the top of the README — real example, three panelists, synthesized verdict, with the new usage badge visible.
- "Why council beats a single model" section in the README explaining the triangulation pitch.
- GitHub repo description + topic tags (`ai-council`, `multi-model`, `claude-code`, `codex`, `gemini-cli`, `terminal-ui`, `opentui`, `bun`, `personal-cockpit`) for discoverability.

### Changed — Codex behavior
- Stops refusing non-coding questions in council with *"I'm a software engineer, I only do coding tasks"* — a short framing prefix on the prompt nudges Codex to engage directly.
- Envelope (`workdir / model / provider / approval / sandbox / session id` lines + the exit-code prefix) stripped from responses so the chat bubble shows only the model's answer.
- Operating manual no longer prepended for Codex (no system-prompt channel, used to get echoed back as noise).

### Changed — Gemini behavior
- 30-line Node.js stack traces collapsed to the actual error line on API failures (`TerminalQuotaError: You have exhausted your capacity...` instead of 30 lines of `at classifyGoogleError (file:///opt/homebrew/Cellar/gemini-cli/...)`).
- Operating manual no longer prepended for Gemini (same reasoning as Codex).

### Changed — Rebrand
- Repo: `fru-dev3/aireadyu` → `fru-dev3/prevail` (old URL redirects, stars/issues preserved).
- Binary name: `aireadyu` → `prevail`.
- Env vars: `AIREADYU_*` → `PREVAIL_*` (`PREVAIL_DATA_DIR`, `PREVAIL_VAULT`, `PREVAIL_REPO`, `PREVAIL_BIN_DIR`, `PREVAIL_VERSION`, `PREVAIL_SCHEDULE_ID`).
- Local config dir: `~/.aireadyu/` → `~/.prevail/`. Installer auto-migrates if it finds the old dir and the new one doesn't exist.
- Install path: `~/.local/bin/aireadyu` → `~/.local/bin/prevail`.
- Domain: `aireadyu.life` → `prevail.ai`.
- New `prevAIl` wordmark — `AI` in electric cyan (`#3CD8FF`) against gold (`#C4A35A`) `prev` and `l`. High contrast pairing so the AI is visually unmistakable as the heart of the brand.
- New `icon.svg` matching the wordmark treatment.
- First-run welcome wizard logo updated to match.

### Fixed
- Empty LIFE APPS sidebar when the first-run wizard happened to pick an incomplete `dist/vault-demo` (e.g. from a partial build). `bundledDemoVaultPath()` now requires the candidate to contain an `apps/` subdir before accepting it.
- Codex hang at probe time — `stdio: 'ignore'` for stdin so codex doesn't wait for input that will never come (carry-forward from v0.1.x diagnosis).
- 88 orphan `.bun-build` temp files (60 MB each) cleaned from the source tree.

### Added — Tests
- Regression coverage for `extractCodexReply` (success envelope, multi-line body, exit-prefix error path, no-reply fallback, empty input).
- Regression coverage for `extractGeminiReply` (stack-trace collapse on quota error, plain reply pass-through, empty input).
- Total suite: 19 tests pass.

---

## [0.1.2] — 2026-06-01 · last release before rebrand

Final tagged release under the `aireadyu` name. See <https://github.com/fru-dev3/prevail/releases/tag/v0.1.2>.

## [0.1.1] — 2026-06-01

## [0.1.0] — 2026-05-31 · initial public release
