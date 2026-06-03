# Changelog

All notable changes to prevAIl are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project tracks [Semantic Versioning](https://semver.org/) on the `vX.Y.Z` tag scheme.

The release page on GitHub mirrors the same notes for each tag:
<https://github.com/fru-dev3/prevail/releases>

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
