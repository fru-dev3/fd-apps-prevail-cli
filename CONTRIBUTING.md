# Contributing to prevail

Thanks for considering a contribution. prevail is a single-binary terminal
cockpit for life domains (wealth, health, tax, career, …). The most valuable
contributions today are **LifeApp plugins** — drop-in adapters that let a
domain chat talk to a real-world service (Plaid for banking, Greenhouse for
hiring, MyChart for labs, etc.).

This doc covers:

1. The LifeApp plugin protocol
2. Where to put your plugin in the repo
3. How the cockpit discovers and loads plugins
4. Quick-start: copying the reference `plaid` plugin

---

## 1. The LifeApp plugin protocol

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

### `manifest.json` schema

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

### `SKILL.md` shape

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

---

## 2. Where to put your plugin

In the monorepo, drop your directory under:

```
apps/community/<your-plugin-id>/
```

Open a PR adding the directory. CI just checks that `manifest.json` parses and
that `SKILL.md` exists.

Users who don't want to vendor your plugin upstream can drop the same
directory at `~/.prevail/apps/<plugin-id>/` on their machine and the cockpit
will pick it up on next launch.

---

## 3. How the cockpit discovers plugins

`scanCommunityApps()` (in `src/vault.ts`) scans these locations, in order, and
dedups by `manifest.id`:

1. `~/.prevail/apps/` — user-installed plugins
2. `<binary>/apps/community/` — plugins bundled with a release tarball
3. `<repo>/apps/community/` — dev-mode (running `bun run dev` from a clone)

Each directory entry must contain both `manifest.json` and `SKILL.md` to be
counted. Manifests that fail to parse are silently skipped.

The cockpit merges community apps into the same list as vault-derived apps
and renders a `★` prefix in the LIFE APPS sidebar so you can tell them apart.

---

## 4. Quick start: clone the reference `plaid` plugin

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

---

## Other contributions

Bug reports and feature ideas are welcome via GitHub issues. For code changes
outside the plugin protocol, please open an issue first to discuss scope.
The Hermes-inspired v0.2 feature pack (`/distill`, `/search`, scheduler,
plugins) is the current focus; see `TODO.md` for what's live and what's next.
