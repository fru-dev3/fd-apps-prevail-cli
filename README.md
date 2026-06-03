<h1 align="center">prev<span style="color:#3CD8FF">AI</span>l</h1>

<p align="center">
  <b>A terminal cockpit for the rest of your life.</b><br/>
  Ask Claude, Codex, Gemini, and your local Ollama the same question in parallel. Let the council vote.
</p>

<p align="center">
  <a href="https://github.com/fru-dev3/prevail/releases"><img src="https://img.shields.io/github/v/release/fru-dev3/prevail?color=C4A35A&label=release" alt="release"/></a>
  <a href="#install"><img src="https://img.shields.io/badge/install-curl%20%7C%20bash-3CD8FF" alt="install"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-C4A35A" alt="MIT"/></a>
</p>

---

**One question. Four engines. One verdict.** Every part of your life — wealth, health, tax, career — is a folder of markdown. Open one, ask, and prevAIl fans the question out to your installed CLIs in parallel. A chair model reads all three replies and writes one decisive answer, surfacing the *disagreement* — which is the point. Works from your terminal or your phone (Telegram bridge). Single 95 MB binary. No daemon, no Docker, no API keys.

```
┌─ wealth ─────────────────────────────────────────────────────────────────┐
│ › /council should I prepay the mortgage or invest the cash?             │
│                                                                          │
│   ⚖ convening · claude · codex · gemini · ollama                       │
│                                                                          │
│   ◇ Claude   At your tax rate the effective mortgage cost is ~4.1%.    │
│             A diversified index has cleared 7% long-run. Math: invest.  │
│   ◇ Codex   Spread = (after-tax return − rate) × principal × years.   │
│             Positive → invest. Keep 6 months liquidity floor.           │
│   ◇ Gemini  Behavioral: guaranteed return on a known liability vs.    │
│             probabilistic return you must ride out. Pick what sticks.   │
│   ◇ Ollama  Local-only check: same conclusion as the cloud panel.     │
│                                                                          │
│  ┌─ 🔀 Where panelists disagreed ─────────────────────────────────┐    │
│  │ Liquidity floor: Codex says 6mo, Gemini says 12mo (risk-off). │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─ ⚖ Verdict · synthesized by Claude ───────────────────────────┐    │
│  │ Invest IF (a) ≥6mo liquidity, (b) you'll hold through −30%,  │    │
│  │ (c) spread > 2%. Else prepay. Liquidity is the binding test. │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ready · 4 calls · 3k↑ 1.4k↓ · ~$0.03            ◆ BLUF  ⚖ Council ON │
└──────────────────────────────────────────────────────────────────────────┘
```

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/fru-dev3/prevail/main/scripts/install.sh | bash
prevail
```

First launch runs a 30-second wizard. Pick the bundled demo vault (synthetic, safe to explore) or point at your own folder. macOS + Linux. Windows via WSL.

## Why prevAIl

| | |
|---|---|
| **🪶 Council, not a single voice** | Four models in parallel, one chair synthesizes. Disagreement gets its own panel — that's where the value is. |
| **📁 Domain = folder** | `wealth/`, `health/`, `tax/`. Plain markdown. Edit anywhere. Sync with git, iCloud, Tailscale. No database. |
| **🔌 Uses CLIs you already pay for** | Spawns `claude`, `codex`, `gemini` — inherits every login, MCP server, and skill. No API keys to manage. |
| **🏠 Local-private when it matters** | Ollama auto-detected at `localhost:11434`. Run health or wealth on a local-only council. |
| **📱 Off-the-keyboard** | `prevail daemon --telegram` exposes the cockpit on your phone. Same engines, same council. Chat-ID allowlist enforced. |
| **🔔 Scheduled briefings** | `prevail briefing add --cron "0 7 * * *" --domain wealth --prompt "what's new this week?"`. Verdict lands in your phone at 7am. |
| **🧠 Self-curating vault** | Every chat writes a one-line summary to `<domain>/_log/YYYY-MM-DD.md`. The vault writes its own decision log. |
| **🔐 Hardened by default** | Vault-shell off by default, env-scrubbed subprocess, file-locked schedules, OAuth refresh tokens chmod 0600. [Audit notes →](./CHANGELOG.md#security--adversarial-sweep) |

## 30 seconds in

```bash
# Boot the cockpit
prevail demo                    # safe synthetic vault — explore first
prevail                         # use your own vault

# Inside, type:
/council should I sell or rent? # fans to all engines, gives one verdict
/framework bluf                 # Bottom Line Up Front structure
/distill                        # turn this conversation into a reusable skill
```

## On your phone

```bash
prevail telegram setup <bot-token>     # token from @BotFather
prevail telegram add-user <chat-id>    # mandatory allowlist
prevail daemon --telegram              # poll Telegram + tick briefings
```

Now `/council`, `/domain wealth`, `/framework bluf` — from anywhere.

## Connectors

Every app declares how it authenticates: `api`, `oauth`, `browser`, `mcp`, or `manual`. Click a connector in the sidebar to see live auth status, what's missing, and **Test Connection**. The OAuth runner handles PKCE + loopback callback + token refresh:

```bash
prevail connectors list
prevail connectors test plaid
prevail connectors oauth youtube-analytics
```

Ships with examples for each auth type: Plaid (api), LinkedIn (browser), YouTube Analytics (oauth), GitHub (http+key), Google Calendar (mcp).

## Commands

```
prevail                          boot the cockpit
prevail init                     first-run wizard
prevail demo                     use the synthetic vault
prevail doctor                   check vault + CLIs
prevail council ...              council ops from the shell
prevail briefing ...             scheduled domain briefings
prevail telegram ...             configure the Telegram bridge
prevail connectors ...           list / test / oauth
prevail daemon --telegram        headless mode (bot + ticker)
```

Inside the TUI: `↑ ↓` between domains, `s` swap to apps, `e` edit the active markdown tab, `q` quit. `/help` lists every slash command.

## Requirements

- One or more of: [Claude Code](https://claude.com/code) · [Codex](https://github.com/openai/codex) · [Gemini CLI](https://github.com/google-gemini/gemini-cli) · [Ollama](https://ollama.com)
- Terminal with UTF-8 + true-color
- macOS / Linux (Windows via WSL)

## Built with

[OpenTUI](https://opentui.com) (Zig core + React reconciler) on [Bun](https://bun.sh). Single binary via `bun --compile`. No runtime dependencies.

## Docs · changelog · roadmap

- [**CHANGELOG**](./CHANGELOG.md) — what shipped in each tag
- [**Releases**](https://github.com/fru-dev3/prevail/releases) — pre-built binaries
- [**Demo vault**](./vault-demo) — synthetic "Alex Rivera" persona

## License

MIT. The bundled demo vault contains no real personal data.
