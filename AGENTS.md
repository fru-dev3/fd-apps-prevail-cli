# aireadyu — project map for humans

> A terminal cockpit for your life domains. Wealth, health, tax, career, real-estate, business — each one is a folder of markdown, each one talks to Claude Code, Codex, or Gemini, all running in parallel.

This file is the orientation map for **humans** working on the project (contributors, maintainers, curious readers). The companion file [`AGENTS-operating.md`](./AGENTS-operating.md) is written *to* AI agents that boot inside this repo or work with a vault produced by this project — keep them separate so neither audience steps on the other.

---

## What this is

aireadyu is a single-binary TUI written in Bun + TypeScript + [OpenTUI](https://opentui.com) (Zig core, React reconciler). At launch it shows two columns:

- **Left:** a sidebar with two scrollable sections — `LIFE DOMAINS` (one row per domain folder you've defined) and `LIFE APPS` (deduplicated app integrations across all domains). Each row shows an open-loops badge and a live status glyph (spinner while that chat is thinking, dot when idle).
- **Right:** an auto-opened chat for whatever domain or app you've focused. The chat has a clickable CLI picker (Claude · Codex · Gemini), a model quickpick row, a context card (state.md preview + open items + clickable folder path), a transcript with bordered user/assistant bubbles, a skills strip (clickable list of agent skills for that domain), and a bordered input box.

Everything is markdown. There's no database. You can sync via git, Dropbox, Syncthing — whatever. Vault = folder; domain = subfolder; agent skill = `SKILL.md` inside `<domain>/skills/<skill-id>/`.

## Repository layout

```
aireadyu/
├── src/                         TypeScript source (entry: src/index.tsx)
│   ├── index.tsx                arg parsing, wizard launch, cockpit launch
│   ├── app.tsx                  top-level layout, mode routing, chat state Map
│   ├── branding.tsx             header (mascot + AIREADYU + status panel)
│   ├── sidebar.tsx              LIFE DOMAINS + LIFE APPS sections
│   ├── chat-pane.tsx            chat pane, CLI/model picker, slash commands, skills strip
│   ├── domain-detail.tsx        legacy tabs (state/open-items/quickstart/prompts/skills) — used as fallback
│   ├── app-detail.tsx           detail view when a focused app has no chat
│   ├── editor-pane.tsx          inline textarea editor (ctrl-s to save)
│   ├── wizard.tsx               first-run wizard
│   ├── command-bar.tsx          bottom toolbar (clickable buttons)
│   ├── cli-bridge.ts            spawns claude/codex/gemini; model + flag handling
│   ├── vault.ts                 scanVault, scanApps, buildDomainContext, file readers
│   ├── domain-scaffold.ts       creates a new domain folder with default markdown
│   ├── config.ts                ~/.aireadyu/config.json + first-run candidate detection
│   ├── markdown-lite.tsx        line-by-line markdown styling (gold headings, ◯ checklists)
│   ├── system.ts                openInFinder (cross-platform folder open)
│   └── theme.ts                 colors (gold #C4A35A) + spinner chars
├── vault-demo/                  the bundled synthetic vault (Alex Rivera persona)
│   ├── benefits/                each domain has: state.md, open-loops.md, QUICKSTART.md,
│   ├── wealth/                  PROMPTS.md, config.md, 00_current/, 01_prior/, 02_briefs/,
│   ├── …                        and optionally skills/<skill-id>/SKILL.md per agent skill
│   └── profile.md
├── scripts/install.sh           curl-installer (lands binary + vault-demo)
├── .github/workflows/release.yml matrix build on v* tag → 4 binaries
├── package.json                 name=aireadyu, bin: aireadyu+aru, build scripts
├── tsconfig.json
├── README.md                    user-facing docs
├── AGENTS.md                    this file — orientation for human contributors
├── AGENTS-operating.md          orientation for AI agents working in a vault
├── TODO.md                      persistent work-in-progress checklist
└── LICENSE                      MIT
```

## How development works

```bash
# clone + install
git clone https://github.com/fru-dev3/aireadyu
cd aireadyu
bun install

# run from source
bun start             # boots wizard if no ~/.aireadyu/config.json
bun run demo          # ignore config, boot synthetic vault
bun run doctor        # check installed CLIs + vault path

# typecheck
bun node_modules/typescript/bin/tsc --noEmit

# compile single binary for current platform
bun build --compile --outfile=dist/aireadyu src/index.tsx
```

The TUI requires UTF-8 + true-color support and at least one of `claude`, `codex`, or `gemini` on `PATH` for the chat to actually do anything. The TUI itself works without them — you just can't talk to a model.

## Conventions

- **TypeScript first.** All new code goes in `src/*.ts(x)`. JSX intrinsics are from `@opentui/react` (`<box>`, `<text>`, `<input>`, `<scrollbox>`, etc.).
- **No comments unless the *why* is non-obvious.** Identifier names should carry intent.
- **State lives in `App`.** Most cross-pane state is hoisted to `src/app.tsx`. Child components are presentational; they take props + callbacks.
- **Chat sessions are persistent.** A `Map<string, ChatSession>` in `App` survives navigation. Each domain auto-opens a session on focus; the session keeps its message history, CLI, and model independently.
- **Mouse + keyboard parity.** Anything navigable by arrow keys should also be clickable. We use OpenTUI's `onMouseDown` on `<box>` for click targets.
- **Vault is sacred.** Never write to a user's vault outside of explicit user actions (`/distill`, `n` for new domain, `e` for edit). Reading is fine. The bundled `vault-demo/` is fair game.

## Distribution

`bun --compile` produces a ~72 MB single binary. Release matrix in `.github/workflows/release.yml` builds for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` on every `v*` tag push and attaches `.tar.gz` archives to the GitHub Release. The tarballs include both `aireadyu` and `vault-demo/`. The curl installer (`scripts/install.sh`) places the binary in `~/.local/bin/` and the demo vault in `~/.aireadyu/vault-demo/`.

## Contributing

1. Read `TODO.md` — the work plan is there with effort estimates and acceptance criteria.
2. Pick an unchecked item, open an issue describing your plan, then a PR.
3. Add `Co-Authored-By:` lines for any AI tools that helped (Claude, Codex, Cursor, etc.).
4. Don't include personal data in the demo vault — Alex Rivera is the synthetic persona.

For new life apps (e.g., MyChart, Plaid, Greenhouse): the v0.2 `LifeApp` plugin contract isn't finalized yet — see `TODO.md` P3.2. Until it lands, drop new apps directly into `vault-demo/<domain>/skills/<app-id>/SKILL.md`.

## License

MIT — see [LICENSE](./LICENSE). The bundled `vault-demo/` content is synthetic (Alex Rivera persona) and included for illustration only.
