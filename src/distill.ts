import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMsg } from "./chat-pane.tsx";
import type { Domain } from "./vault.ts";

export function buildDistillPrompt(domain: Domain, messages: ChatMsg[]): string {
  // Council bubbles carry attribution (which CLI / model said what, whether
  // it was a panelist response or the synthesized verdict). Surface that in
  // the transcript so the distiller treats council exchanges differently
  // from single-CLI turns — the SKILL.md it produces should reflect the
  // multi-perspective decision framework, not just one voice.
  const sawCouncil = messages.some(
    (m) => m.kind === "council-response" || m.kind === "council-verdict",
  );
  const transcript = messages
    .filter((m) => m.role !== "system")
    // Drop in-flight placeholders that have no content yet.
    .filter((m) => m.kind !== "council-pending" && m.kind !== "council-synthesizing")
    // Drop empty / whitespace-only bubbles.
    .filter((m) => m.content && m.content.trim().length > 0)
    .map((m) => {
      const tag = labelMessage(m);
      return `[${tag}]\n${m.content}`;
    })
    .join("\n\n---\n\n");
  const today = new Date().toISOString().slice(0, 10);
  const councilNote = sawCouncil
    ? `

NOTE: this transcript includes a council exchange — the user asked one
question, three panelist CLIs (claude/codex/gemini) each answered, and a
chair synthesized a verdict. When distilling, capture *the decision
framework* the council used, not just one panelist's view. If the
panelists disagreed and the verdict resolved the trade-off, that
reasoning IS the skill. The resulting SKILL.md should help future
agents know when to convene a council and what dimensions to weigh.
`
    : "";
  return `The user wants to distill the conversation below into a reusable skill for the "${domain.name}" life domain. Read the transcript and produce a complete SKILL.md draft they can save under <vault>/${domain.name}/skills/<slug>/.${councilNote}

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

// Tag a chat message for the distill transcript. Council messages get
// rich attribution so the distiller can see which CLI / model produced
// which slice of the exchange.
function labelMessage(m: ChatMsg): string {
  if (m.kind === "council-response") {
    const who = m.model ? `${m.cli ?? "?"}·${m.model}` : (m.cli ?? "?");
    return `council panelist · ${who}`;
  }
  if (m.kind === "council-verdict") {
    const who = m.model ? `${m.cli ?? "?"}·${m.model}` : (m.cli ?? "?");
    return `council verdict · synthesized by ${who}`;
  }
  return m.role;
}
