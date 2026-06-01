import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMsg } from "./chat-pane.tsx";
import type { Domain } from "./vault.ts";

export function buildDistillPrompt(domain: Domain, messages: ChatMsg[]): string {
  const transcript = messages
    .filter((m) => m.role !== "system")
    .map((m) => `[${m.role}]\n${m.content}`)
    .join("\n\n---\n\n");
  const today = new Date().toISOString().slice(0, 10);
  return `The user wants to distill the conversation below into a reusable skill for the "${domain.name}" life domain. Read the transcript and produce a complete SKILL.md draft they can save under <vault>/${domain.name}/skills/<slug>/.

REQUIRED OUTPUT FORMAT — return ONLY a single fenced markdown code block (no preamble, no explanation, no closing remarks). The block must contain frontmatter and the sections below, in this order:

\`\`\`markdown
---
name: ${domain.name}-distilled-<short-action>
type: distilled
description: |
  <1-3 sentences: what this skill does and when to use it>
created_from: chat distillation
created_at: ${today}
---

# <Human-Readable Title>

## What this skill does

<one-paragraph summary of the workflow this skill encodes>

## When to invoke

- <trigger 1>
- <trigger 2>

## Inputs

- <input the skill needs from the user, or "none">

## Steps

1. <step one>
2. <step two>
3. <step three>

## Output

<what the skill produces (a file written, a brief, a decision, etc.)>
\`\`\`

The frontmatter \`name\` MUST be lowercase, kebab-case, and start with "${domain.name}-distilled-". Replace <short-action> with 2-4 words describing the skill's core action (e.g., "pay-quarterly-tax", "summarize-month", "flag-late-rent"). No spaces, no underscores — kebab-case only.

Transcript to distill:

${transcript}`;
}

export interface ParseResult {
  ok: boolean;
  skill?: string;
  error?: string;
}

export function parseDistillResponse(text: string): ParseResult {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/);
  const body = (fence ? fence[1] : trimmed).trim();
  if (!body.startsWith("---")) {
    return { ok: false, error: "no frontmatter found — the model didn't follow the SKILL.md format" };
  }
  return { ok: true, skill: body };
}

export function extractSlug(skillBody: string, fallback: string): string {
  const m = skillBody.match(/^name:\s*(.+?)\s*$/m);
  if (m) return slugify(m[1]);
  return slugify(fallback);
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export interface WriteResult {
  ok: boolean;
  path: string;
  slug: string;
  message: string;
}

export function writeDistilledSkill(domain: Domain, skillBody: string): WriteResult {
  const slug = extractSlug(skillBody, "distilled");
  const skillDir = join(domain.path, "skills", slug);
  const skillFile = join(skillDir, "SKILL.md");
  if (existsSync(skillFile)) {
    return {
      ok: false,
      path: skillFile,
      slug,
      message: `skill "${slug}" already exists — discard and rename in the frontmatter`,
    };
  }
  try {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, skillBody);
    return {
      ok: true,
      path: skillFile,
      slug,
      message: `wrote ${slug} to skills/${slug}/SKILL.md`,
    };
  } catch (err) {
    return { ok: false, path: skillFile, slug, message: (err as Error).message };
  }
}
