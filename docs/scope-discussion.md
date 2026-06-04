# What prevAIl is, and what it isn't

## What it is
- A single-user terminal cockpit for hard personal decisions
- Spawns the AI CLIs you already have logged in (Claude Code, Codex, Gemini CLI, Ollama) in parallel, gets a verdict
- Runs on your machine, against a folder of your own markdown
- Designed for the engineer / operator / founder who already lives in a terminal and trusts AI enough to delegate but wants to keep their reasoning on disk in plain markdown

## What it isn't
- **Not a SaaS.** There is no hosted prevAIl. You run it.
- **Not multi-tenant.** One install, one user, one vault. There is no permission system.
- **Not enterprise-grade.** No SAML, no RBAC, no SLA, no managed deployment.
- **Not a replacement for your task manager / notes app.** The vault is markdown; if you want a database-backed task manager, use one of the dozen good ones.
- **Not a code editor.** prevAIl can edit your vault markdown, but for serious editing it spawns `$EDITOR` (vim, hx, vscode, whatever you've set).

## Why these constraints
A general-purpose council tool tries to be everything for everyone and ends up being a Swiss Army Knife with a tendency to lose its blade. prevAIl's scope is narrow on purpose:
- Council-as-a-decision-protocol stays clean if the surface stays single-user.
- The vault stays grep-able and portable because it's markdown, not a database.
- The CI stays small because the threat model is small.
- The codebase stays maintainable by one person because we don't pretend to be a platform.

## What we want contributions for
- Better defaults (frameworks, lenses, prompt-engineering)
- New CLI bridges as new AI tools ship (whatever follows opus/claude/codex)
- Better vault tooling (prune, backup, verify, dedupe)
- Better journal / decision-log distillation
- Documentation, docs/, examples
- Bugs (especially security bugs — see SECURITY.md for the private reporting flow)

## What we don't want contributions for
- Multi-user / hosted mode
- Cloud-hosted vault
- A web UI (the TUI is the product)
- Replacing OpenTUI or Bun
- Bolted-on observability (Datadog, etc.) — debug.log is the canonical local debug surface

## Where to discuss
- Use cases, vault patterns, lens design: GitHub Discussions
- Bugs and feature requests: GitHub Issues with the templates
- Security: GitHub Security Advisories ONLY
