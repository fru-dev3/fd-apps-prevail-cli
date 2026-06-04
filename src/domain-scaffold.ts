import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ScaffoldResult {
  ok: boolean;
  message: string;
  path?: string;
}

export function scaffoldDomain(vaultPath: string, rawName: string): ScaffoldResult {
  const name = rawName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!name) return { ok: false, message: "name is empty" };
  const dir = join(vaultPath, name);
  if (existsSync(dir)) return { ok: false, message: `${name} already exists` };

  try {
    mkdirSync(dir, { recursive: true });
    for (const sub of ["00_current", "01_prior", "02_briefs"]) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    writeFileSync(join(dir, "state.md"), defaultState(name));
    writeFileSync(join(dir, "open-loops.md"), defaultOpenLoops(name));
    writeFileSync(join(dir, "config.md"), defaultConfig(name));
    writeFileSync(join(dir, "QUICKSTART.md"), defaultQuickstart(name));
    writeFileSync(join(dir, "PROMPTS.md"), defaultPrompts(name));
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
  const domainDir = join(vaultPath, domainName);
  if (!existsSync(domainDir)) return { ok: false, message: `domain ${domainName} not found` };
  const skillsRoot = join(domainDir, "skills");
  const dir = join(skillsRoot, name);
  if (existsSync(dir)) return { ok: false, message: `skill ${name} already exists` };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), defaultSkill(name, domainName));
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
  const appsRoot = join(vaultPath, "apps");
  const dir = join(appsRoot, name);
  if (existsSync(dir)) return { ok: false, message: `app ${name} already exists` };

  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(join(dir, "state.md"), defaultAppState(name));
    writeFileSync(join(dir, "open-loops.md"), defaultOpenLoops(name));
    writeFileSync(join(dir, "QUICKSTART.md"), defaultQuickstart(name));
    writeFileSync(join(dir, "PROMPTS.md"), defaultPrompts(name));
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

> Synthetic / placeholder — fill this in as you connect the app.

**Used by domains:** (list here)
**Last refresh:** —
**Auth:** —

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

> Synthetic / placeholder — fill this in as you learn what to track.

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

> Settings, accounts, identifiers — the durable facts an agent needs to act on ${name}.

| Key | Value |
|---|---|
|  |  |
`;
}

function defaultQuickstart(name: string): string {
  return `# ${title(name)} Quickstart

A 60-second tour of the ${name} domain.

1. What lives here
2. How to read \`state.md\`
3. Where the briefs land (\`02_briefs/\`)
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
