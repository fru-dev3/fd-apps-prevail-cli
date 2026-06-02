# prevail

> prevAIl — a terminal cockpit for your life domains

### Council mode in action

```
┌─ chief ──────────────────────────────────────────────────────────────────┐
│ › /council should I prepay the mortgage or invest the cash?              │
│                                                                          │
│   ⚖ convening council: claude · codex · gemini                          │
│                                                                          │
│   ◇ claude · opus-4-7                                                   │
│   At your effective tax rate, the deductible interest cuts your real    │
│   mortgage cost to ~4.1%. A diversified index portfolio has cleared 7%  │
│   long-run after tax. Math says invest. But if losing the cash flow if  │
│   markets crash would force you to sell, prepay buys you peace.         │
│                                                                          │
│   ◇ codex · gpt-5.4                                                     │
│   Run the spread: (expected_after_tax_return - effective_mortgage_rate) │
│   × principal × years remaining. Positive → invest. Add a liquidity     │
│   floor of 6 months expenses before either move.                         │
│                                                                          │
│   ◇ gemini · 2.5-pro                                                    │
│   Behavioral factor: prepaying is a guaranteed return on a known        │
│   liability; investing is a probabilistic return on volatility you      │
│   have to ride out. Pick the one you'll actually stick with under       │
│   stress. For most people that's the guarantee.                          │
│                                                                          │
│   ⚖ council verdict · synthesized by claude                            │
│   Invest if (a) you have 6+ months liquidity, (b) you can stomach a    │
│   30% drawdown without selling, and (c) the rate spread is > 2%. Else  │
│   prepay. Run the spread calc with your actual numbers and check (b)   │
│   honestly — that's the binding constraint, not the math.              │
│                                                                          │
│ ready · type your next question              4 calls · 3k↑ 1.4k↓ · ~$0.03│
└──────────────────────────────────────────────────────────────────────────┘
```

A single-binary TUI that turns every part of your life — wealth, health, tax,
career, content, real estate, … — into a chat-driven cockpit. Each domain is
just a folder of markdown. Each chat talks to Claude Code, Codex, or Gemini.
All conversations run in parallel.

```
   ╲ │ ╱     █▀█ █▀▄ █▀▀ █ █ ▄▀█ █ █              │   SUNDAY · JUN 1 · 2026
   ─ ◈ ─     █▀▀ █▀▄ ██▄  █  █▀█ █ █▄▄            │   15:47  ·  live since 2026
   ╱ │ ╲     prev · AI · l  —  your AI cockpit    │
                                                  │   vault   ~/.ai/vault
  EST 2026   19 domains · 41 apps · 65 open       │   cli     claude · codex · gemini
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

## Council mode — why ask one AI when you can convene three

Single-model output is fine for routine questions. For **high-stakes decisions**
— "should I prepay this mortgage or invest the cash?", "is this contract clause
a deal-breaker?", "rewrite my resume for a Principal SA at Anthropic" —
one model's answer is a single point of view shaped by one company's training
data, one RLHF bias, and one set of blind spots. You don't actually know what
you're missing.

Council fixes that. Type `/council <your question>` (or toggle `▣ Council ON`
in the tab strip) and prevAIl **fans the question out to Claude, Codex, and
Gemini in parallel**, collects their answers, then has a **synthesizer** (the
chair) read all three and produce a single verdict. You see three panelist
bubbles, then a `⚖ council verdict` bubble distilling them.

Why this beats just asking one model:

- **Triangulation, not averaging.** When Claude, Codex, and Gemini agree, your
  confidence in the call goes up — three different models trained on different
  data corpora converging is real signal. When they *disagree*, that's even
  more valuable: the disagreement itself surfaces the trade-off you needed to
  think about, which a single model would have just papered over.
- **Cancels per-model quirks.** Claude tends to hedge, Codex is conservative
  on non-coding questions, Gemini is verbose. The synthesizer reads all three
  and writes one direct answer — you get the substance without inheriting any
  single model's stylistic baggage.
- **Compare model versions side-by-side.** Council can run multiple variants
  of the *same* CLI in the same panel. Want to see if Opus 4.7 still beats 4.6
  on financial reasoning? Add both to the claude row in the config and they
  show up as two separate panelists. The chair synthesizes across all of them.
- **Pick your chair.** The chair is the model that writes the verdict from
  the panel responses. Pin Claude if you trust its synthesis voice, pin Codex
  if you want a terse engineer-style summary, pin Gemini if you want it
  exhaustive. Set it once in the council config; or leave it `auto` and the
  first panelist to reply takes the chair role.
- **Follow-up context is preserved.** Council remembers the prior turns of
  the conversation. Ask a follow-up and all three panelists see the previous
  question + the prior verdict, so they're answering the next move, not
  starting fresh.
- **Escape cancels everything.** A council fan-out is three concurrent CLI
  child processes. Hit Escape and prevAIl SIGTERMs all of them in one shot,
  drops a `(cancelled)` bubble, and the chat goes idle. No waiting for slow
  models to finish a turn you don't care about anymore.

You can also run a degraded council — `claude` + `codex` only, no `gemini`
(or any subset) — if you're out of quota on one provider or you want to save
tokens on a less critical question. Configure who participates in the
`⚙ configure` panel.

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
