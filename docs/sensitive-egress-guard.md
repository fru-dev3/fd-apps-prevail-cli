# Sensitive Egress Guard

The global guardrail that keeps the user's sensitive information from leaving
the system in ANY outbound communication unless the user explicitly approves
it. Internal use (vault files, briefings to the user themself) is unrestricted;
the boundary being defended is EGRESS to another party.

## Principles

1. **Enforced in code at execution choke points, never by prompt.** A guardrail
   that lives in a system prompt can be argued around; one that lives in the
   executor cannot. Every enforcement point below is deterministic TypeScript
   that runs regardless of which model, harness, surface, or CLI invocation
   initiated the action.
2. **Deterministic detection, zero model calls.** The scanner is regex +
   checksum + lexicon. A model-based classifier could fail open (model down),
   fail closed (misfire), or be prompt-injected; a pure function cannot. Bias
   is toward HOLDING: false positives cost one approval tap, false negatives
   leak the user's life.
3. **Audience, not channel, decides.** Mail to the user's own accounts, a
   Telegram push to the user's own configured chat, a Gmail DRAFT (which never
   leaves the account until the user presses Send) are all `self` audience and
   pass. Anything addressed to another person, a calendar invite with
   attendees, a document share, a post typed into an external website is
   `external`/`public` and gets scanned. Unknown audience is treated as
   external.
4. **Approval releases, settings govern.** The guard is ON by default
   (config `egressGuard`, beside `emailPolicy`). Holding is never silent: the
   caller is told which categories were found, and the user can release the
   exact action with an explicit second approval that names the sensitivity.

## What is detected (categories)

Pattern detectors (scrubbed precisely when a scrubbed variant is produced):

- `ssn` — 123-45-6789 shapes and "social security number" context
- `ein` — 12-3456789 shapes
- `card` — 13-19 digit runs passing Luhn
- `bank` — ABA routing numbers (checksum) and account-number/IBAN context
- `money` — currency amounts ($185,000 / 185k USD / €9.500) and standalone
  6+ digit figures (specific numbers may not go out unless approved)
- `phone` — E.164 and US formats
- `dob` — dates adjacent to born/DOB/birthday
- `secret` — API keys, tokens, private-key blocks

Lexicon detectors (mark the message as holding that category; cannot be
precisely scrubbed, so they hold the whole message for approval):

- `salary` — salary, compensation, bonus, equity, RSU, offer
- `wealth` — net worth, portfolio, holdings, brokerage, balances
- `health` — diagnosis, medication, therapy, surgery, mental health, ...
- `legal` — immigration/visa status, lawsuit, settlement, citizenship, ...
- `identity` — SSN/EIN/passport/driver's license mentioned by name
- `strategy` — confidential, internal only, strategy, roadmap, acquisition,
  term sheet, do not share (decisions/plans are internal by default)
- `quote` — verbatim quoted spans of 40+ characters (specific quotes may not
  go out unless approved)

## Enforcement points (the complete egress surface of the engine)

| # | Choke point | Audience computed from | On hold |
|---|-------------|------------------------|---------|
| 1 | `runGwsApproved` (gws-gateway.ts) — the ONLY executor for every Google write from every surface (chat, loops, agents, desktop approvals, `prevail gws run` CLI) | gmail send recipients vs the user's own connected addresses; `--draft` = self; calendar writes with attendees = external; drive permission/share writes = external (shared doc content is unscannable, so shares always hold) | gmail: forced to `--draft` with an honest note (composes with the email policy); everything else: refused with categories, pending record KEPT so the user can re-approve with `--allow-sensitive` |
| 2 | `browser-agent.ts` act dispatch — every character an agent types into a live page, and every URL it navigates to | external website = public | the single action is blocked in code; the agent is told the categories and to proceed without the sensitive value or ask the user |
| 3 | `gws-mcp.ts` queue-time — transparency, not enforcement | same as #1 | the "Queued for your approval" message states up front that the send will be held/drafted |
| 4 | Self-notification hooks (briefing email via `gwsSelfEmailHook`, Telegram to the user's configured chat) | self by construction (recipient = the user's own address/chat) | not held — the user's own net-worth briefing to themself is the product working as intended |

Out of scope, stated honestly: the raw `gws` binary run by the user outside
Prevail is the user acting directly and cannot be governed by the engine.
Recorded browser replays substitute values the user themself recorded or
supplied at setup, which is standing approval; net-new agent-typed text is
what #2 governs.

## The approval release valve

- Desktop: the Needs-you card shows the held categories and a second explicit
  button ("Approve including sensitive info") that re-authorizes and runs
  `gws run --id <id> --allow-sensitive`.
- CLI: `prevail --vault <v> gws run --id <id> --allow-sensitive`.
- Gmail specifically never needs the release valve to make progress: held mail
  lands in Drafts, and pressing Send in Gmail IS the user's approval.

## Settings

- Engine: `prevail egress-guard get|set on|off [--json]`; also
  `prevail egress-guard test <text>` prints what the scanner finds, so the
  user can verify the guard with their own examples.
- Desktop: Privacy > Sensitive Information — the fifth Privacy control beside
  Bunker Mode, Vault Lock, Incognito, and Outbound Contact. ON by default;
  turning it off requires the same deliberate act as other privacy controls.

## Composition with the outbound-email policy

The email policy (who may receive mail) runs first, then the egress guard
(what the content may contain). Third-party mail is already draft-only by
default; the egress guard adds that even under `emailPolicy: allow`, mail
carrying sensitive content still only drafts. Two independent dials, both
enforced in the same executor.
