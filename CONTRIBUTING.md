# Contributing to prevAIl

## Welcome

prevAIl is a single-user terminal cockpit for hard personal decisions — a
council-of-AIs you spawn against your own markdown vault. It is not a
platform, not a SaaS, and not multi-tenant. Contributions that improve it as
a personal tool are welcome. The scope is documented in
[`docs/scope-discussion.md`](docs/scope-discussion.md) and pinned as a
GitHub Discussion; read it before opening a non-trivial PR.

## Before you start

Read these in order so you don't propose something out of scope:

1. [`docs/scope-discussion.md`](docs/scope-discussion.md) — the pinned scope
   discussion (what prevAIl is, and what it isn't).
2. [`SECURITY.md`](SECURITY.md) — how to report security findings privately.
3. [`docs/threat-model.md`](docs/threat-model.md) — the assumptions the
   codebase is allowed to make.

If your proposal contradicts any of the three, it will be closed.

## Dev setup

```bash
git clone https://github.com/<owner>/prevail.git
cd prevail
# bun ≥ 1.3.0 required
bun install
bun run dev          # hot-reload TUI for local development
bun run build        # produce the single binary at ./dist/prevail
bun test src/        # run the test suite
bunx tsc --noEmit    # typecheck (no emit)
```

The TUI talks to whatever AI CLIs are already logged in on your machine
(Claude Code, Codex, Gemini CLI, Ollama). It does not bundle credentials.

## Code style

- **TypeScript strict.** No implicit `any`, no unchecked nullables.
- **Never `shell: true` in spawn calls.** Pass argv arrays. Shell expansion
  inside subprocess invocations is a recurring source of injection bugs and
  is banned.
- **OpenTUI rendering gotchas:**
  - Trailing whitespace is stripped inside `<text>` cells. When a value must
    visibly start with a space, prepend a non-breaking space (NBSP, U+00A0).
  - Mixed literal + interpolation inside a single `<text>` node clips at
    render time. Split into two adjacent `<text>` nodes — one for the
    literal, one for the interpolated value.
- **No emojis in UI output.** Use geometric Unicode only (◆ ◇ ● ○ ✓ ✗ ▸ from
  the Geometric Shapes block). See `CHANGELOG.md` for the rule and its
  history.
- **No `console.log` in TUI paths.** Logs corrupt the rendered frame. Route
  diagnostics to `debug.log` via the existing logger.

## Commit message convention

Follow the existing pattern:

```
<type>(<scope>): <imperative subject>

<body explaining WHY, not what>
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `refactor`. Scope is the
subsystem (`vault`, `council`, `tui`, `connector`, etc.). The body explains
the motivation — the diff already shows the what.

When a commit was AI-paired, co-author the assistant exactly as existing
commits do. Look at recent history with `git log -n 20 --format=fuller` for
the precise trailer format before adding one.

## Pull request flow

1. Open a PR against `main`.
2. Fill in every checkbox in `.github/PULL_REQUEST_TEMPLATE.md`. Unchecked
   items will block review.
3. Before requesting review, confirm all three of these pass locally:

   ```bash
   bunx tsc --noEmit
   bun run build
   bun test src/
   ```

4. CI runs the same three. Failing CI blocks merge.

## Reporting bugs / requesting features

Use the templates under `.github/ISSUE_TEMPLATE/`. The templates exist to
make sure you include the reproduction steps and environment that triage
actually needs. Free-form issues without the template will be asked to
refile.

## Security

Never open a public issue for a security finding. See
[`SECURITY.md`](SECURITY.md) for the private reporting flow (GitHub Security
Advisories). Public disclosure of an unpatched issue will get the report
ignored.

---

## LifeApp plugin protocol

The rest of this document covers the LifeApp plugin protocol — drop-in
adapters that let a domain chat talk to a real-world service (Plaid for
banking, Greenhouse for hiring, MyChart for labs, etc.).

### 1. The LifeApp plugin protocol

A LifeApp plugin is a directory with two required files:

```
apps/community/<plugin-id>/
├── manifest.json     # required
└── SKILL.md          # required
```

Optional additions a future plugin may want:

```
apps/community/<plugin-id>/
├── icon.svg          # optional, displayed in cockpit (planned)
├── skills/           # optional, additional sub-skills
│   └── <sub-id>/SKILL.md
└── scripts/          # optional, anything the SKILL.md tells the agent to call
```

#### `manifest.json` schema

```json
{
  "id": "plaid",
  "name": "Plaid",
  "version": "0.1.0",
  "description": "One-paragraph description of what the plugin does.",
  "domains": ["wealth", "tax", "business"],
  "auth": "api-key",
  "auth_env_vars": ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ACCESS_TOKEN"],
  "homepage": "https://plaid.com",
  "license": "MIT",
  "author": { "name": "your-handle", "url": "https://github.com/your-handle" }
}
```

| field | required | meaning |
|-------|----------|---------|
| `id` | yes | Short, lowercase, kebab-case. Must match the directory name. Used for deduping. |
| `name` | no | Display name shown in the LIFE APPS sidebar (defaults to `id`). |
| `version` | yes | SemVer. Bump when you change the SKILL.md contract. |
| `description` | yes | Free-form. First 240 chars surface in the cockpit. |
| `domains` | yes | Array of vault-domain slugs this plugin is relevant to. The cockpit shows the `×N` badge when there are multiple. |
| `auth` | no | One of `none`, `oauth`, `api-key`, `cookie`, `manual`. Informational for now — no enforcement. |
| `auth_env_vars` | no | Env vars the SKILL.md expects to find in the spawned subprocess. |
| `homepage` | no | URL for the service. |
| `license` | no | License under which you ship the plugin. |
| `author` | no | `{ name, url }`. |

#### `SKILL.md` shape

The cockpit treats SKILL.md as a prompt fragment the agent reads when the user
focuses the plugin. It is plain markdown with YAML frontmatter:

```markdown
---
name: <plugin-id>
type: app
description: |
  One-paragraph summary. Multi-line OK with `|`.
---

# <Plugin Name>

**Auth:** how the plugin authenticates
**Environment:** which env vars must be present
**URL:** homepage
**Domains using this app:** wealth, tax, business

## Data Available
…tables, bullets, anything the agent should know…

## When to invoke
…specific triggers…

## Inputs
…what the agent needs at chat time…

## Output
…what the agent should produce…
```

Keep it under ~400 lines. Long SKILL.md files dilute the system prompt and
cost more tokens per chat turn.

### 2. Where to put your plugin

In the monorepo, drop your directory under:

```
apps/community/<your-plugin-id>/
```

Open a PR adding the directory. CI just checks that `manifest.json` parses and
that `SKILL.md` exists.

Users who don't want to vendor your plugin upstream can drop the same
directory at `~/.prevail/apps/<plugin-id>/` on their machine and the cockpit
will pick it up on next launch.

### 3. How the cockpit discovers plugins

`scanCommunityApps()` (in `src/vault.ts`) scans these locations, in order, and
dedups by `manifest.id`:

1. `~/.prevail/apps/` — user-installed plugins
2. `<binary>/apps/community/` — plugins bundled with a release tarball
3. `<repo>/apps/community/` — dev-mode (running `bun run dev` from a clone)

Each directory entry must contain both `manifest.json` and `SKILL.md` to be
counted. Manifests that fail to parse are silently skipped.

The cockpit merges community apps into the same list as vault-derived apps
and renders a `★` prefix in the LIFE APPS sidebar so you can tell them apart.

### 4. Quick start: clone the reference `plaid` plugin

The repo ships one reference plugin under `apps/community/plaid/`. It models a
Plaid integration without making real HTTP calls — useful as a structural
template.

To bootstrap your own:

```bash
cp -r apps/community/plaid apps/community/<your-plugin-id>
# edit manifest.json: change id, name, version, description, domains, auth
# rewrite SKILL.md to describe your service
```

Open a PR and we'll review. Plugins that bring a real, useful service to one
of the existing domains (wealth, tax, health, career, business, insurance,
real-estate, vision, content, brand, benefits, calendar) are the most
valuable.
