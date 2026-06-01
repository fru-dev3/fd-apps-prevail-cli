# aireadyu — work-in-progress checklist

> **For future Claude (or any agent picking this up cold):** This file is the source of truth across sessions. Update STATUS each work session. Tick boxes and add `(done: yyyy-mm-dd)`. If you finish all items, write a v0.2.0 release note and archive this file to `docs/archive/TODO-v0.1.x.md`.

## STATUS

- **last touched:** 2026-06-01
- **current version on main:** v0.1.2 (P1.1 + P1.2 staged for v0.1.3)
- **next milestone:** v0.2.0 — "the agent that grows with you" (Hermes-inspired feature pack)
- **active item:** P3.1 — embedded scheduler (`aireadyu schedule`)
- **just finished:** P2.2 — session persistence + FTS5 /search. Every user + assistant message is appended to `~/.aireadyu/sessions/<domain>-<sessionId>.jsonl` and mirrored into `~/.aireadyu/sessions.db` (SQLite FTS5 virtual table). `/search <query>` returns top 5 matches with rank-ordered snippets. ContextCard now shows "▸ N past chat messages · last 3d ago" chip when the domain has history. Whole module in `src/session.ts`.

## BACKGROUND (read this if you have no context)

aireadyu is a single-binary terminal cockpit for life domains (wealth, health, tax, career, …) built in Bun + TypeScript + OpenTUI. Each domain gets its own auto-opened chat that runs on a user-selected CLI (Claude Code, Codex, or Gemini), against a markdown vault. The bundled vault-demo persona is Alex Rivera (synthetic). Repo is MIT, public, single-maintainer.

Key files:
- `src/app.tsx` — top-level UI state and routing
- `src/chat-pane.tsx` — chat right pane, CLI/model picker, context card, skills strip, slash commands
- `src/cli-bridge.ts` — `runChatTurn()` spawns `claude -p` / `codex exec` / `gemini -p`
- `src/vault.ts` — `scanVault()`, `scanApps()`, `buildDomainContext()`
- `src/config.ts` — `~/.aireadyu/config.json`, `bundledDemoVaultPath()`, first-run candidate detection
- `src/wizard.tsx` — first-run wizard
- `scripts/install.sh` — `curl | bash` installer (lands binary at `~/.local/bin/aireadyu` + vault-demo at `~/.aireadyu/vault-demo`)
- `.github/workflows/release.yml` — matrix build on `v*` tag

These items derive from a strategic comparison against Nous Research's Hermes Agent (`github.com/nousresearch/hermes-agent`). The full analysis is in the 2026-06-01 conversation thread; the headline pulls are the loop-closer (`/distill`), session search (FTS5), embedded scheduler, plugin contract, and a properly split AGENTS.md.

## CHECKLIST

### P1 — TODAY (foundation; everything else depends on these)

- [x] **P1.1 — Create `AGENTS.md` (project map) and `AGENTS-operating.md` (agent operating manual)** (done: 2026-06-01, commit 21eb13a)
  - **why:** Hermes treats `AGENTS.md` as *the* contract for any agent that boots into the repo. We don't have one. Two files keeps human contributors and AI runtimes from stepping on each other.
  - **acceptance:**
    - `AGENTS.md` at repo root — describes the project for humans (what is aireadyu, layout, conventions, how to contribute). Linked from `README.md`.
    - `AGENTS-operating.md` at repo root — written *to* the agent: vault path conventions, slash commands, how to invoke skills, what files are off-limits, do/don't behaviors during a chat. ~300-500 lines.
  - **files:** `AGENTS.md` (new), `AGENTS-operating.md` (new), `README.md` (add link)
  - **effort:** 2 hours

- [x] **P1.2 — Prepend `AGENTS-operating.md` content to every CLI launch** (done: 2026-06-01)
  - **why:** so the operating manual reaches Claude/Codex/Gemini on the first `-p` call. Tiny code change with outsized effect on chat quality.
  - **acceptance:** in `src/cli-bridge.ts` `runChatTurn()`, read `AGENTS-operating.md` from a known location (`<vault>/AGENTS-operating.md` if present, fall back to the binary's bundled copy) and prepend its content as a `--append-system-prompt` argument (Claude) or system message (Codex/Gemini). Cached at process start; reread on `r` (refresh).
  - **files:** `src/cli-bridge.ts`, `src/vault.ts` (helper to find the manual), `vault-demo/AGENTS-operating.md` (copy in)
  - **effort:** 2 hours

- [x] **P1.3 — Investigate + fix recurring linux-x64 build failure** (done: 2026-06-01)
  - **disposition:** rescoped after verification. linux-x64 builds and uploads fine on v0.1.2. The actually-lagging target is `darwin-x64` (Intel Mac) sitting in GitHub's free macos-13 runner queue for hours. That's runner availability, not a code defect.
  - **action taken:** none required. The `fail-fast: false` matrix already keeps the other 3 jobs landing predictably. Intel Mac users either wait for the macos-13 queue to clear or build from source.
  - **future:** if darwin-x64 demand emerges, options are (a) drop it from the matrix and document source-build, or (b) move to a paid macos-13 runner. Bookmark.

### P2 — THIS WEEK (the v0.2 narrative: "the agent that grows with you")

- [x] **P2.1 — `/distill` slash command — close the learning loop** (done: 2026-06-01)
  - **why:** turn a successful chat into a new SKILL.md proposal for the focused domain. This is THE feature that differentiates aireadyu from "yet another chat launcher." Cite: Hermes `agent/curator.py`, `memory_manager.py`, `insights.py`, `background_review.py`.
  - **acceptance:**
    - typing `/distill` in any chat triggers an agent call (use the chat's current CLI) that synthesizes the conversation into a SKILL.md draft
    - draft shown in a diff-preview overlay (or inline in chat as fenced markdown)
    - user can edit, accept, or discard
    - on accept, write to `<vault>/<domain>/skills/<slug>/SKILL.md` and refresh sidebar so the new skill appears in the strip
    - SKILL.md must include frontmatter: `name`, `description`, `type: distilled`, `source_session_id`, `created_at`
  - **files:** `src/chat-pane.tsx` (slash command parser), `src/app.tsx` (state for overlay), `src/distill.ts` (new — prompt + writer), `src/vault.ts` (slug helper)
  - **prompt design:** read SKILL.md examples in `vault-demo/wealth/skills/` for style guidance. The synthesizer prompt should output frontmatter + ## How to use + ## Inputs + ## Steps + ## Outputs sections.
  - **effort:** 3-5 days

- [x] **P2.2 — Session persistence + FTS5 search + `/search`** (done: 2026-06-01)
  - **why:** chats currently die when the pane closes. For life domains, "what did I decide about Roth conversion in March?" is the killer query. Cite: Hermes session search.
  - **acceptance:**
    - every chat message is appended to `~/.aireadyu/sessions/<domain>-<session_id>.jsonl` (one JSON object per line: `{ts, role, content, model, cli}`)
    - SQLite FTS5 index at `~/.aireadyu/sessions.db` mirrors the .jsonl content for full-text search
    - `/search <query>` slash command returns top 5 matches with date, domain, and a 200-char excerpt; click result → loads that historical message into the current chat as a context line
    - on domain auto-open, if there are 3+ historical messages in that domain, show a "▸ 4 past chats · last on May 12 · click to browse" chip above the input
  - **files:** `src/session.ts` (new — append, search), `src/chat-pane.tsx` (search overlay + history chip), `src/app.tsx` (wire session writes into `sendMessage()`)
  - **deps:** Bun has built-in `bun:sqlite` with FTS5 — no new npm dep needed
  - **effort:** 2-3 days

### P3 — NEXT SPRINT (unlocks live demo + community contributions)

- [ ] **P3.1 — Embedded scheduler (`aireadyu schedule`)**
  - **why:** so the Alex Rivera demo can show *live* recurring activity, and so `fru-*-monthly-sync`-style routines work without macOS launchd. Cite: Hermes `cron/scheduler.py` (87KB).
  - **acceptance:**
    - new subcommand `aireadyu schedule list/add/remove/run`
    - persistent state at `<vault>/.schedule.json`: `[{id, cron, command, last_run, enabled}]`
    - background tick runs every minute when the cockpit is open; surfaces "next run" times in the chat header for the focused domain
    - vault-demo ships seed schedules (e.g., "monthly wealth sync on the 1st") so the demo feels alive
  - **files:** `src/schedule.ts` (new), `src/index.tsx` (subcommand dispatch), `src/app.tsx` (background tick + header surface)
  - **deps:** small cron parser (`cronstrue` or roll our own — keep it small)
  - **effort:** 2-3 days

- [ ] **P3.2 — LifeApp plugin contract + 1 reference plugin**
  - **why:** community wants to contribute new life apps (Plaid, Greenhouse, MyChart…). Need a clean drop-in path. Cite: Hermes `plugins/`, `optional-mcps/`.
  - **acceptance:**
    - `apps/community/<app-id>/` accepts contributions with: `manifest.json` (name, version, domains-it-belongs-to, auth-method), optional `icon.svg`, `SKILL.md`, `skills/` directory with sub-skills
    - cockpit loads community apps on boot and merges them into the LIFE APPS sidebar with a small badge (★ community)
    - one reference plugin shipped: `apps/community/plaid/` covering bank transaction sync (synthetic skill, no real Plaid API call required)
    - `CONTRIBUTING.md` describes the plugin protocol
  - **files:** `src/vault.ts` (`scanCommunityApps()`), `apps/community/plaid/*` (new), `CONTRIBUTING.md` (new)
  - **effort:** 3-4 days

### P4 — BOOKMARKED (revisit on user feedback)

- [ ] **P4.1 — Windows PowerShell installer (`install.ps1`)** — 3× distribution reach. Drop binary to `%LOCALAPPDATA%\aireadyu`, add to user PATH, no UAC. Effort: 1 day.
- [ ] **P4.2 — Signal messenger gateway (`aireadyu serve` → Signal)** — defer until v0.3. Hermes pattern: `gateway/platforms/signal.py`. Effort: ~1 week.
- [ ] **P4.3 — Execution-target abstraction (run skills via SSH on remote host)** — defer until v0.4. Lets `ssh mini` execute a skill remotely. Effort: ~1 week.
- [ ] **P4.4 — i18n key extraction** — no translation yet, just refactor `theme.ts` strings into a keyed lookup so future translation is cheap. Effort: 2 hours.
- [ ] **P4.5 — VHS demo recording for README hero** — `brew install vhs`, write `demo.tape`, ship `demo.gif`. Use the Charm tool even before any framework migration. Effort: half a day.
- [ ] **P4.6 — Replace `markdown-lite.tsx` with `glow` shell-out** — better rendering for free until proper `glamour` port. Effort: half a day.

### P5 — RELEASE & MARKETING (do after P1 + P2 ship)

- [ ] **P5.1 — Cut v0.2.0** — tag `v0.2.0`, release notes call out the loop closer + session search as the headline ("the agent that grows with you").
- [ ] **P5.2 — Show HN post** — title: *"aireadyu — a terminal cockpit for life domains, now with a learning loop"*. Lead with the VHS GIF.
- [ ] **P5.3 — Update README hero** — replace static ASCII layout block with the VHS-recorded GIF.

### P6 — STRATEGIC CHECK-IN (already scheduled — do not duplicate)

- [x] **P6.1 — 90-day Bubble Tea migration re-evaluation** — scheduled remote agent fires Sun Aug 30 2026 at 10am CT, routine `aireadyu-90day-review` (id `trig_017S2Q5e4JipZbp2Ti5BZA8Q`), opens a draft PR with the recommendation. (scheduled: 2026-06-01)

---

## Working notes (append things future-you will want)

- v0.1.2 release page: https://github.com/fru-dev3/aireadyu/releases/tag/v0.1.2
- Routine console: https://claude.ai/code/routines/trig_017S2Q5e4JipZbp2Ti5BZA8Q
- Hermes source for inspiration: https://github.com/nousresearch/hermes-agent (Python — only borrow patterns, not code)
- Vault-demo path on dev machine: `~/Documents/aireadyu/vault-demo/`
- Mac install location (per install.sh): `~/.local/bin/aireadyu` + `~/.aireadyu/vault-demo/`
