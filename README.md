# prevail

> prevAIl — a terminal cockpit for your life domains

A single-binary TUI that turns every part of your life — wealth, health, tax,
career, content, real estate, … — into a chat-driven cockpit. Each domain is
just a folder of markdown. Each chat talks to Claude Code, Codex, or Gemini.
All conversations run in parallel.

```
   ╲ │ ╱     █▀█ █▀█ █▀▀ █ █ ▄▀█ █                       │   SUNDAY · JUN 1 · 2026
   ─ ◈ ─     █▀▀ █▀▄ ██▄ ▀▄▀ █▀█ █▄▄                     │   15:47  ·  live since 2026
   ╱ │ ╲     prev·AI·l — your AI life cockpit            │
                                                         │   vault   ~/.ai/vault
  EST 2026   19 life domains · 41 life apps · 65 open    │   cli     claude · codex · gemini
                                                         │   chat    ●● 2 chats active
```

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/fru-dev3/prevail/main/scripts/install.sh | bash
```

or from source:

```bash
git clone https://github.com/fru-dev3/prevail
cd prevail
bun install
bun start
```

First launch shows a wizard. Pick the bundled demo (synthetic Alex Rivera vault,
safe to explore) or point at your own `~/.ai/vault` if you already have one.

## What's a vault?

A vault is a folder. Inside it, each subfolder is a life domain:

```
vault/
├── wealth/
│   ├── state.md          ← what you currently know about this domain
│   ├── open-loops.md     ← what's pending
│   ├── QUICKSTART.md     ← 60-second tour
│   ├── PROMPTS.md        ← curated prompts for the agent
│   └── skills/           ← agent skills (optional)
├── health/
├── tax/
└── ...
```

No database, no proprietary format. Edit any file in any editor. Sync with
git, Dropbox, Syncthing, whatever. Bring your own backups.

## What's the cockpit?

Arrow up/down through your domains. Each one auto-opens a chat. Above the chat
you see a live preview of that domain's `state.md` + the unchecked items in
`Open Items`. Below it, a clickable strip of every skill that domain ships.

Click `Claude Code · Codex · Gemini CLI` to swap the model. Type `/model opus`
or `/model gpt-5` to pass any model name straight through. Each domain
remembers its own CLI + model independently, so `wealth` can run on Opus while
`content` runs on Gemini 2.5 Pro — both at the same time, with live spinners
in the sidebar showing which ones are thinking.

## Commands

```bash
prevail                    boot the cockpit (uses your saved vault)
prevail init               run the first-run wizard
prevail demo               ignore config, always boot the synthetic vault
prevail doctor             check vault + installed AI CLIs
prevail --vault <path>     override vault path for this run
```

## Keys

| Key | Action |
|---|---|
| `↑` / `↓` | move between domains or apps |
| `s` | toggle focus between Life Domains / Life Apps |
| `n` | scaffold a new domain |
| `e` | inline-edit the active markdown tab |
| `r` | reload vault from disk |
| `q` / `ctrl-c` | quit |

Inside any chat:

| Slash command | Effect |
|---|---|
| `/claude [model]` | switch to Claude Code, optionally with a specific model |
| `/codex [model]` | switch to Codex |
| `/gemini [model]` | switch to Gemini CLI |
| `/model <name>` | set the model on the current CLI (any string the CLI accepts) |
| `/clear` | reset the conversation, keep the CLI/model config |
| `/help` | list slash commands |
| `/exit` | back to cockpit (same as esc) |

## Requirements

- At least one of: [Claude Code](https://claude.com/code), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli). The TUI works without any of them — you just can't chat.
- Terminal with UTF-8 + true-color support.
- macOS, Linux (Windows via WSL).

## Built with

[OpenTUI](https://opentui.com) (Zig core, TypeScript bindings, React reconciler) + [Bun](https://bun.sh).

## License

MIT — see [LICENSE](./LICENSE).

The bundled `vault-demo/` content (Alex Rivera persona) is synthetic and
included for illustrative purposes only. No real personal data.
