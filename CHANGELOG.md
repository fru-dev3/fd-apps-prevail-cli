# Changelog

All notable changes to prevAIl are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project tracks [Semantic Versioning](https://semver.org/) on the `vX.Y.Z` tag scheme.

The release page on GitHub mirrors the same notes for each tag:
<https://github.com/fru-dev3/prevail/releases>

---

## [Unreleased]

### Added — Engines
- **Ollama / OpenAI-compatible 4th engine.** Any endpoint that speaks `/v1/chat/completions` (Ollama, LM Studio, llama.cpp server, vLLM) is now a first-class panelist alongside Claude / Codex / Gemini. Detected automatically by probing `GET /api/tags` (falls back to `/v1/models`); shows up in the CLI bar and in the council picker. Privacy-sensitive domains (health, wealth) can run a local-model-only council.
  - Default endpoint: `http://localhost:11434` (override with `PREVAIL_OLLAMA_URL`)
  - Default model: `llama3.1` (override with `PREVAIL_OLLAMA_MODEL`)
  - Friendly probe error when the configured model isn't pulled (`ollama pull <name>`)
  - Council bubble color: electric cyan (matches the AI in prevAIl)

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
