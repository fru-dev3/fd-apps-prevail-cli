# Usage & Cost Tracking — design plan

Status: **backlog / not started.** Captured 2026-06-07.

## What Fru wants

See what the AI is actually costing — even though we run on CLI *subscriptions*
(Claude Code, Codex, Antigravity) that don't bill per token. The point is a
**shadow cost**: "if this were API-priced, what would I be spending, and where is
it going?" Sliceable by:

- **day** — cost over time, trended nicely.
- **session** — the live/temporary tally for the current run.
- **model** — cost per model + which models I lean on most.
- **domain** — what each life-domain is costing me.

Not a popup — a real dashboard surface. Lives in the **CLI** so every front-end
(desktop, Telegram, cron) gets it for free.

## Why the CLI owns it

Usage is produced everywhere turns happen: the TS `runChatTurn` (council, chat-
json, score audit, benchmark) AND the desktop's native Rust `chat_send`. If each
front-end tracked its own, the numbers would never reconcile. So: **one
append-only ledger + one query command in the CLI**, and every front-end either
appends to the ledger or shells out to record. The desktop dashboard just reads
`prevail usage --json`.

## The ledger

Append-only JSONL at **`<vault>/_meta/usage.jsonl`** (vault-level so cross-domain
roll-ups are a single read; `domain` is a field, not a path). One line per turn:

```json
{
  "ts": 1780800000000,
  "session": "chat-abc123",          // groups a conversation / run
  "domain": "wealth",                 // or null for General / out-of-domain
  "surface": "chat|council|benchmark|score|telegram",
  "cli": "claude",
  "model": "claude-opus-4-8",
  "input_tokens": 4210,
  "output_tokens": 880,
  "token_source": "reported|estimated", // did the CLI give real counts?
  "est_cost_usd": 0.0721,             // input*in_rate + output*out_rate
  "billed": false                     // true only if a metered API key was used
}
```

`billed:false` is the honest flag — on a subscription this is a *shadow* number.

## Getting token counts

1. **Reported (preferred).** Some CLIs emit usage in JSON mode:
   - `claude -p --output-format json` → `usage.input_tokens` / `output_tokens`.
   - `codex exec --json` → token usage events.
   Parse it when present → `token_source: "reported"`.
2. **Estimated (fallback).** When a CLI gives nothing (Ollama, plain text),
   estimate `tokens ≈ chars / 4` over the full prompt (incl. injected context)
   and the reply → `token_source: "estimated"`. Flag it so the UI can show a
   `~` and not over-claim precision.

## Pricing table

Generalize `src/council-cost.ts` (today a flat per-CLI per-call guess) into a
real per-model **`PRICING: Record<model, {inUsdPerMtok, outUsdPerMtok}>`** with a
sane default per vendor and a documented "rates as of <date>" note. `est_cost =
input/1e6*inRate + output/1e6*outRate`. Keep it data-only and easy to update.

## CLI surface

```
prevail usage record <json>      # append one line (used by front-ends)
prevail usage --json             # full ledger, normalized
prevail usage --by day [--since 30d]
prevail usage --by domain
prevail usage --by model
prevail usage --by session       # current/recent sessions
```

`--by X` returns pre-aggregated buckets `{ key, calls, input, output, est_usd }`
so the dashboard does zero math. All honor `--since` / `--vault`.

## Capture points (instrument once each)

- **TS `runChatTurn`** (`cli-bridge.ts`) — wrap the call: parse reported usage or
  estimate, append a ledger line. Covers council / chat-json / score / benchmark.
- **Desktop native `chat_send`** (Rust `lib.rs`) — after the stream closes, write
  the same ledger line (or call `prevail usage record`). The session id already
  exists; thread the `domain` through.

Tag each with its `surface` so benchmark/score runs can be excluded from "what my
daily *use* costs" when desired.

## Dashboard (desktop) — a tab, never a popup

New top-level **"Usage"** tab (sibling of Conversation/Council/Benchmark, or in
the bottom-left next to Life Readiness):

- **Headline** — total shadow cost for the period (Today / 7d / 30d / All toggle),
  with a `~` when any bucket is estimated.
- **Over time** — a small bar/area chart of `est_usd` by day.
- **By domain** — horizontal bars (Wealth $x, Health $y …), click → that domain's
  breakdown. Ties cost back to the life-OS framing.
- **By model** — table: model · calls · tokens · est $ · share %. Surfaces "which
  models I lean on most."
- **This session** — a live ticker of the current session's running tally
  (ephemeral, resets per session).

Reuses the existing chart/bar primitives (`ScoreBar`, the matrix table styling).

## Phasing

1. **Ledger + pricing + `usage record`/`--json`** (CLI). Instrument `runChatTurn`.
   Nothing visible yet, but data starts accruing.
2. **Aggregations** `--by day|domain|model|session` (CLI) + tests.
3. **Desktop capture** in native `chat_send` (so chat, the common path, counts).
4. **Usage dashboard tab** (desktop) reading `usage --by …`.
5. Polish: period toggle, estimated-vs-reported badge, export.

## Open questions

- Show shadow $ vs. raw token counts as the default headline? (Lean: tokens are
  honest on a subscription; cost is the intuitive hook — show cost, `~`, with a
  "what this would cost on API pricing" tooltip.)
- Retention of `_meta/usage.jsonl` — rotate/compact after N months?
- Should benchmark/score usage be excluded from the headline by default (it's
  tooling, not daily life use)? Lean yes, with a toggle.
