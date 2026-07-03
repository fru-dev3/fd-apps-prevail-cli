import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import { vwriteFile } from "./vault-session.ts";
import { join } from "node:path";
import { appsContainer, newDomainDir, resolveDomainDir } from "./path-safety.ts";
import { seedSkillPack } from "./vault.ts";
import { V4_MARKER, v4ContentPath } from "./vault-layout-v4.ts";

export interface ScaffoldResult {
  ok: boolean;
  message: string;
  path?: string;
}

export function scaffoldDomain(vaultPath: string, rawName: string): ScaffoldResult {
  const name = rawName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!name) return { ok: false, message: "name is empty" };
  const dir = newDomainDir(vaultPath, name);
  if (existsSync(dir)) return { ok: false, message: `${name} already exists` };

  try {
    mkdirSync(dir, { recursive: true });
    // Create the domain directly in the clean v4 layout. Write the marker FIRST
    // so v4ContentPath routes every file into source/ (your material), memory/
    // (AI-derived), and .system/ (plumbing), creating parents on demand. This is
    // the SAME resolver the readers use, so a new domain round-trips correctly
    // and never ships the old flat layout (loose state.md, 00_current/, etc.).
    writeFileSync(join(dir, V4_MARKER), "v4\n");
    mkdirSync(join(dir, "memory", "briefs"), { recursive: true });
    vwriteFile(v4ContentPath(dir, "memory/state.md", "state.md"), defaultState(name));
    vwriteFile(v4ContentPath(dir, "memory/open-loops.md", "open-loops.md"), defaultOpenLoops(name));
    vwriteFile(v4ContentPath(dir, "source/config.md", "config.md"), defaultConfig(name));
    vwriteFile(v4ContentPath(dir, "source/quickstart.md", "QUICKSTART.md"), defaultQuickstart(name));
    vwriteFile(v4ContentPath(dir, "source/starters.md", "PROMPTS.md"), defaultPrompts(name));
    // Seed the bundled default skills for this domain (when a pack exists) into
    // the v4 memory/skills home so a new domain arrives with quality skills.
    try { seedSkillPack(`domains/${name}/_skills`, v4ContentPath(dir, "memory/skills", "_skills")); } catch { /* best effort */ }
    return { ok: true, message: `created ${name}`, path: dir };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

// Scaffold a new skill under <vault>/<domain>/skills/<skill-id>/SKILL.md.
// Mirrors scaffoldDomain in shape — takes a raw user-typed name, slugs it,
// guards against collisions, returns a ScaffoldResult so callers can show
// a friendly setMessage on failure. The default SKILL.md is intentionally
// short — placeholders the user can replace fast in $EDITOR.
export function scaffoldSkill(
  vaultPath: string,
  domainName: string,
  rawName: string,
): ScaffoldResult {
  const name = rawName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!name) return { ok: false, message: "name is empty" };
  const domainDir = resolveDomainDir(vaultPath, domainName);
  if (!existsSync(domainDir)) return { ok: false, message: `domain ${domainName} not found` };
  const skillsRoot = join(domainDir, "skills");
  const dir = join(skillsRoot, name);
  if (existsSync(dir)) return { ok: false, message: `skill ${name} already exists` };
  try {
    mkdirSync(dir, { recursive: true });
    vwriteFile(join(dir, "SKILL.md"), defaultSkill(name, domainName));
    return { ok: true, message: `created skill ${name}`, path: dir };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

function defaultSkill(name: string, domainName: string): string {
  return `---
name: ${name}
type: task
domain: ${domainName}
---

# ${title(name)}

## When to use

Describe the trigger or context where this skill applies.

## Steps

1. First step
2. Second step
3. Third step

## Inputs

- key: description

## Outputs

- What this skill produces, where it gets written, etc.

## Notes

Any constraints, gotchas, or links to related skills.
`;
}

export function scaffoldApp(vaultPath: string, rawName: string): ScaffoldResult {
  const name = rawName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!name) return { ok: false, message: "name is empty" };
  const appsRoot = appsContainer(vaultPath);
  const dir = join(appsRoot, name);
  if (existsSync(dir)) return { ok: false, message: `app ${name} already exists` };

  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "skills"), { recursive: true });
    vwriteFile(join(dir, "state.md"), defaultAppState(name));
    vwriteFile(join(dir, "open-loops.md"), defaultOpenLoops(name));
    vwriteFile(join(dir, "QUICKSTART.md"), defaultQuickstart(name));
    vwriteFile(join(dir, "PROMPTS.md"), defaultPrompts(name));
    return { ok: true, message: `created app ${name}`, path: dir };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultAppState(name: string): string {
  return `# ${title(name)}

> Synthetic placeholder. Fill this in as you connect the app.

**Used by domains:** (list here)
**Last refresh:** (not yet)
**Auth:** (not set)

## Coverage

What data this app exposes; which institutions, accounts, or scopes it connects to.

## When to Use This App

- When …
- When …

## Open Items

- [ ] First setup task for ${name}
`;
}

function defaultState(name: string): string {
  return `# ${title(name)} State

> Synthetic placeholder. Fill this in as you learn what to track.

**Last updated:** ${today()}

## Overview

A short paragraph describing what this domain covers and why it matters.

## Open Items

- [ ] First thing to track in ${name}
- [ ] Second thing to track in ${name}
`;
}

function defaultOpenLoops(name: string): string {
  return `# ${title(name)} Open Loops

> Auto-updated by skills. Do not edit manually.

## Open
<!-- items added here automatically -->

## Resolved
<!-- resolved items moved here -->
`;
}

function defaultConfig(name: string): string {
  return `# ${title(name)} Config

> Settings, accounts, and identifiers: the durable facts an agent needs to act on ${name}.

| Key | Value |
|---|---|
|  |  |
`;
}

function defaultQuickstart(name: string): string {
  return `# ${title(name)} Quickstart

A 60-second tour of the ${name} domain.

1. What lives here
2. How to read \`memory/state.md\`
3. Where the briefs land (\`memory/briefs/\`)
4. The skills available
`;
}

function defaultPrompts(name: string): string {
  return `# ${title(name)} Prompts

Curated prompts for an agent working on ${name}.

## Status check
> Read state.md and tell me what's changed and what I should act on first.

## Open-loop triage
> Look at the unchecked items in state.md's "Open Items" section. Sort by impact × urgency and recommend the next single action.

## Add your own below.
`;
}

function title(name: string): string {
  return name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}
