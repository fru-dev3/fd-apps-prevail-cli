// Specialists: a method that works in any domain. Domain expertise stays in
// the domain's own files, so the roster never multiplies by domain.
//
// A specialist file (built in below, or the user's own in
// build/specialists/<id>.md, same shape) is frontmatter plus three sections:
//
//   ---
//   id: researcher
//   name: Researcher
//   icon: search
//   family: know            # know | decide | do | grow | deliver
//   returns: findings
//   ceiling: read           # read | write-vault | draft | act-ask | act
//   tools: [web, vault-read]
//   apps: []
//   runtime: deep
//   lens: off
//   budget: { minutes: 10, usd: 0.50, passes: 3 }
//   handoff: offer          # off | offer | auto
//   done_when:
//     - every claim has a source
//   ---
//   ## Mandate
//   ## Method
//   ## Never
//
// Per domain, the user's instructions live in
// data/domains/<d>/source/specialists/<id>.md (they may only TIGHTEN: a lower
// ceiling, fewer tools or apps, never more), and the specialist's notebook
// (what it learned there, AI-maintained, short) in
// data/domains/<d>/memory/specialists/<id>.md.
//
// Ceilings are enforced in code (jobs.ts): in this phase no specialist runs
// with tools that act; a write-vault result is written by code into the
// domain it was sent to, a draft is stored and never sent.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRoot, resolveDomainDir } from "./path-safety.ts";
import { vreadFile } from "./vault-session.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { parseModArgs } from "./cli-args.ts";

export type Family = "know" | "decide" | "do" | "grow" | "deliver";
export type Ceiling = "read" | "write-vault" | "draft" | "act-ask" | "act";
export type Handoff = "off" | "offer" | "auto";
export const CEILINGS: Ceiling[] = ["read", "write-vault", "draft", "act-ask", "act"];
const CEILING_RANK: Record<Ceiling, number> = { read: 0, "write-vault": 1, draft: 2, "act-ask": 3, act: 4 };

export interface Specialist {
  id: string;
  name: string;
  icon: string;
  family: Family;
  returns: string;
  ceiling: Ceiling;
  tools: string[];
  apps: string[];
  runtime: string;
  lens: string;
  budget: { minutes: number; usd: number; passes: number };
  handoff: Handoff;
  doneWhen: string[];
  mandate: string;
  method: string;
  never: string;
  on: boolean;
  builtIn: boolean;
  /** Which file overrode the built-in, if any (vault-relative). */
  source?: string;
}

// ── A tiny frontmatter reader for exactly the keys above ────────────────────

function parseValue(v: string): unknown {
  const t = v.trim();
  if (t.startsWith("[") && t.endsWith("]")) return t.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
  if (t.startsWith("{") && t.endsWith("}")) {
    const o: Record<string, number | string> = {};
    for (const part of t.slice(1, -1).split(",")) {
      const [k, x] = part.split(":").map((s) => s.trim());
      if (k && x !== undefined) o[k] = Number.isFinite(Number(x)) ? Number(x) : x;
    }
    return o;
  }
  return t.replace(/\s+#.*$/, "").replace(/^"(.*)"$/, "$1");
}

export function parseFrontmatter(text: string): { fm: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of m[1]!.split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) { (fm[listKey] as string[]).push(item[1]!.trim()); continue; }
    const kv = /^([a-z_][a-z0-9_-]*):\s*(.*)$/i.exec(line);
    if (!kv) continue;
    if (!kv[2]!.trim()) { listKey = kv[1]!; fm[listKey] = []; continue; }
    listKey = null;
    fm[kv[1]!] = parseValue(kv[2]!);
  }
  return { fm, body: text.slice(m[0].length) };
}

function sectionOf(body: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "im");
  const m = re.exec(body);
  if (!m) return "";
  const rest = body.slice(m.index + m[0].length);
  const next = /^##\s+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

const asCeiling = (v: unknown, d: Ceiling): Ceiling => (CEILINGS.includes(v as Ceiling) ? (v as Ceiling) : d);
const asHandoff = (v: unknown, d: Handoff): Handoff => (v === "off" || v === "offer" || v === "auto" ? v : d);
const asList = (v: unknown, d: string[]): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : d);

export function parseSpecialist(text: string, base?: Specialist): Specialist | null {
  const { fm, body } = parseFrontmatter(text);
  const id = String(fm.id ?? base?.id ?? "").trim();
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(id)) return null;
  const b = (fm.budget ?? {}) as Record<string, number>;
  const fam = String(fm.family ?? base?.family ?? "know") as Family;
  return {
    id,
    name: String(fm.name ?? base?.name ?? id),
    icon: String(fm.icon ?? base?.icon ?? "sparkles"),
    family: (["know", "decide", "do", "grow", "deliver"] as Family[]).includes(fam) ? fam : "know",
    returns: String(fm.returns ?? base?.returns ?? "findings"),
    ceiling: asCeiling(fm.ceiling, base?.ceiling ?? "read"),
    tools: asList(fm.tools, base?.tools ?? []),
    apps: asList(fm.apps, base?.apps ?? []),
    runtime: String(fm.runtime ?? base?.runtime ?? "standard"),
    lens: String(fm.lens ?? base?.lens ?? "off"),
    budget: {
      minutes: Number(b.minutes ?? base?.budget.minutes ?? 10),
      usd: Number(b.usd ?? base?.budget.usd ?? 0.5),
      passes: Math.max(1, Math.min(5, Number(b.passes ?? base?.budget.passes ?? 2))),
    },
    handoff: asHandoff(fm.handoff, base?.handoff ?? "offer"),
    doneWhen: asList(fm.done_when, base?.doneWhen ?? []),
    mandate: sectionOf(body, "Mandate") || base?.mandate || "",
    method: sectionOf(body, "Method") || base?.method || "",
    never: sectionOf(body, "Never") || base?.never || "",
    on: fm.on === undefined ? (base?.on ?? true) : String(fm.on) !== "false",
    builtIn: !!base?.builtIn,
  };
}

// ── The built-in roster (Phase 1 turns six on; the rest are listed, off) ────

const spec = (fm: string, mandate: string, method: string, never: string) => `---\n${fm.trim()}\n---\n## Mandate\n${mandate}\n## Method\n${method}\n## Never\n${never}\n`;

const BUILT_IN_TEXT: string[] = [
  spec(`id: researcher
name: Researcher
icon: search
family: know
returns: findings
ceiling: read
tools: [web, vault-read]
runtime: deep
budget: { minutes: 6, usd: 0.40, passes: 2 }
handoff: offer
done_when:
  - the answer is in the first line
  - every claim has a source (a link or a vault file)
  - options are compared on the same facts`,
  "A deep, sourced answer to one question.",
  "1. Read the domain context below first: what the user already has and decided.\n2. Search the web for current, primary sources.\n3. Compare options on the same facts; note prices, dates and ratings with where each came from.\n4. Lead with the answer.",
  "Guess a number or a source. Contact anyone. Buy or sign up for anything."),
  spec(`id: scout
name: Scout
icon: compass
family: know
returns: discoveries
ceiling: read
tools: [web, vault-read]
runtime: standard
budget: { minutes: 4, usd: 0.25, passes: 1 }
handoff: offer
done_when:
  - at least three things the user did not ask about but should know
  - each one says why it matters to them`,
  "Wanders around the question and brings back what the user did not know to ask.",
  "1. Look one step to the side of the question: adjacent options, risks, timing, rules, things people in this situation usually miss.\n2. Keep only what matters for this user's situation.\n3. Say why each one matters, in one line.",
  "Repeat what the Researcher already covers. Contact anyone."),
  spec(`id: planner
name: Planner
icon: list-ordered
family: decide
returns: plan
ceiling: read
tools: [vault-read]
runtime: deep
budget: { minutes: 4, usd: 0.30, passes: 2 }
handoff: offer
done_when:
  - numbered steps, each with who does it (the user or a specialist)
  - every step that spends money or contacts a person is marked ASK`,
  "Turns a goal into a plan the user can run, step by step.",
  "1. State the goal in one line.\n2. Break it into numbered steps; name the specialist for each step that a specialist can do.\n3. Mark ASK on any step that spends money, contacts a person, changes a location or an identity.\n4. Give a date for each step when one is implied.",
  "Do any step. Contact anyone."),
  spec(`id: steward
name: Steward
icon: scale
family: decide
returns: verdict
ceiling: read
tools: [vault-read]
runtime: deep
budget: { minutes: 3, usd: 0.20, passes: 1 }
handoff: offer
done_when:
  - a verdict in the first line: fits, fits with changes, or does not fit
  - names the value, goal or rule each point rests on`,
  "Checks a result against the user's Compass, ideal state and constitution.",
  "1. Read the Compass and the domain's ideal state below.\n2. Say whether the result fits, fits with changes, or does not fit.\n3. Name what it serves and what it costs, by the user's own value and goal names.\n4. Flag any non-negotiable at risk first.",
  "Flatter. Approve something that breaks a non-negotiable."),
  spec(`id: editor
name: Editor
icon: file-text
family: deliver
returns: page
ceiling: write-vault
tools: [vault-read]
runtime: standard
budget: { minutes: 3, usd: 0.20, passes: 1 }
handoff: offer
done_when:
  - the page opens with the answer and a recommendation
  - one comparison table when options are compared
  - every number keeps its source`,
  "Turns the team's results into one clear page the user can read in two minutes.",
  "1. Lead with the answer and the recommendation.\n2. One table when options are compared.\n3. Keep every source the team cited.\n4. End with the next step and its date.",
  "Add facts the team did not find. Drop a source."),
  spec(`id: writer
name: Writer
icon: pen-line
family: do
returns: draft
ceiling: draft
tools: [vault-read]
runtime: standard
budget: { minutes: 3, usd: 0.20, passes: 1 }
handoff: offer
done_when:
  - each draft has a recipient, a subject and a body
  - written in the user's voice, short`,
  "Writes outward text (emails, messages, requests) in the user's voice.",
  "1. One draft per recipient.\n2. Short, plain, specific; the ask in the first two lines.\n3. Leave placeholders for anything the team did not find.",
  "Send anything. Every draft waits for the user."),
];

// The rest of the roster, listed so the user can see what is coming. Off.
const LATER: [string, string, Family, string, Ceiling][] = [
  ["analyst", "Analyst", "know", "numbers", "read"], ["historian", "Historian", "know", "timeline", "read"],
  ["sentinel", "Sentinel", "know", "alerts", "read"], ["interviewer", "Interviewer", "know", "memory updates", "write-vault"],
  ["skeptic", "Skeptic", "decide", "risks", "read"], ["auditor", "Auditor", "decide", "verified", "read"],
  ["negotiator", "Negotiator", "decide", "strategy", "draft"], ["operator", "Operator", "do", "action", "act-ask"],
  ["builder", "Builder", "do", "build", "write-vault"], ["clerk", "Clerk", "do", "vault changes", "write-vault"],
  ["liaison", "Liaison", "do", "nudges", "draft"], ["mechanic", "Mechanic", "do", "repairs", "write-vault"],
  ["coach", "Coach", "grow", "goals", "write-vault"], ["tutor", "Tutor", "grow", "lessons", "write-vault"],
  ["confidant", "Confidant", "grow", "reflection", "read"],
];

export function builtInSpecialists(): Specialist[] {
  const on = BUILT_IN_TEXT.map((t) => ({ ...parseSpecialist(t)!, builtIn: true }));
  const off = LATER.map(([id, name, family, returns, ceiling]) => ({
    id, name, icon: "circle-dashed", family, returns, ceiling, tools: [], apps: [], runtime: "standard", lens: "off",
    budget: { minutes: 5, usd: 0.3, passes: 1 }, handoff: "off" as Handoff, doneWhen: [], mandate: "", method: "", never: "",
    on: false, builtIn: true,
  }));
  return [...on, ...off];
}

// ── Loading ─────────────────────────────────────────────────────────────────

function readText(p: string): string {
  if (!existsSync(p)) return "";
  try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } }
}

export function specialistsDir(vault: string): string { return join(buildRoot(vault), "specialists"); }

/** Built-ins, each overridden by build/specialists/<id>.md if present, plus the user's own. */
export function loadSpecialists(vault: string): Specialist[] {
  const all = new Map(builtInSpecialists().map((s) => [s.id, s]));
  const dir = specialistsDir(vault);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
      const base = all.get(f.replace(/\.md$/, ""));
      // An override of a built-in that is not built yet stays off: there is no method behind it.
      const s = parseSpecialist(readText(join(dir, f)), base);
      if (!s) continue;
      if (base && !base.mandate && !s.mandate) s.on = false;
      all.set(s.id, { ...s, builtIn: !!base?.builtIn, source: `build/specialists/${f}` });
    }
  }
  return [...all.values()];
}

export function getSpecialist(vault: string, id: string): Specialist | null {
  return loadSpecialists(vault).find((s) => s.id === id) ?? null;
}

/** The user's per-domain instructions and the tightened spec (lower ceiling, fewer tools/apps, never more). */
export function forDomain(vault: string, s: Specialist, domain: string): { spec: Specialist; notes: string } {
  const text = readText(join(resolveDomainDir(vault, domain), "source", "specialists", `${s.id}.md`));
  if (!text) return { spec: s, notes: "" };
  const { fm, body } = parseFrontmatter(text);
  const out = { ...s };
  const c = asCeiling(fm.ceiling, s.ceiling);
  if (CEILING_RANK[c] < CEILING_RANK[s.ceiling]) out.ceiling = c;
  if (Array.isArray(fm.tools)) out.tools = s.tools.filter((t) => (fm.tools as string[]).includes(t));
  if (Array.isArray(fm.apps)) out.apps = s.apps.filter((a) => (fm.apps as string[]).includes(a));
  if (fm.on !== undefined && String(fm.on) === "false") out.on = false;
  return { spec: out, notes: body.trim().slice(0, 2000) };
}

export function ceilingRank(c: Ceiling): number { return CEILING_RANK[c]; }

// ── Notebooks: what a specialist learned in one domain ──────────────────────

export const NOTEBOOK_MAX = 30;

export function notebookPath(vault: string, domain: string, id: string): string {
  return join(resolveDomainDir(vault, domain), "memory", "specialists", `${id}.md`);
}

export function readNotebook(vault: string, domain: string, id: string): string[] {
  return readText(notebookPath(vault, domain, id)).split("\n").map((l) => /^-\s+(.*\S)\s*$/.exec(l)?.[1] ?? "").filter(Boolean);
}

/**
 * Add what a run learned. Lines are short, deduped (case-insensitive) and the
 * notebook keeps the newest NOTEBOOK_MAX, so it stays something a person reads.
 */
export function appendNotebook(vault: string, domain: string, id: string, lines: string[], now = Date.now()): string[] {
  const clean = lines.map((l) => l.replace(/\s+/g, " ").replace(/\s*\u2014\s*/g, ", ").trim().slice(0, 200)).filter((l) => l.length >= 8);
  if (!clean.length) return [];
  const have = readNotebook(vault, domain, id);
  const seen = new Set(have.map((l) => l.replace(/^\d{4}-\d{2}-\d{2}:\s*/, "").toLowerCase()));
  const day = new Date(now).toISOString().slice(0, 10);
  const added: string[] = [];
  for (const l of clean) { if (seen.has(l.toLowerCase())) continue; seen.add(l.toLowerCase()); added.push(`${day}: ${l}`); }
  if (!added.length) return [];
  const all = [...have, ...added].slice(-NOTEBOOK_MAX);
  const p = notebookPath(vault, domain, id);
  mkdirSync(join(p, ".."), { recursive: true });
  const name = getName(id);
  writeFileSync(p, `# ${name} notebook\n\nWhat the ${name} learned working in this domain. Edit or delete any line.\n\n${all.map((l) => `- ${l}`).join("\n")}\n`);
  return added;
}

function getName(id: string): string {
  return builtInSpecialists().find((s) => s.id === id)?.name ?? id;
}

/** Every domain where a specialist keeps a notebook, with its line count. */
export function notebooks(vault: string, id: string): { domain: string; lines: number; notes: boolean }[] {
  const out: { domain: string; lines: number; notes: boolean }[] = [];
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    const lines = readNotebook(vault, d, id).length;
    const notes = existsSync(join(resolveDomainDir(vault, d), "source", "specialists", `${id}.md`));
    if (lines || notes) out.push({ domain: d, lines, notes });
  }
  return out;
}

// ── CLI: prevail specialists list|show <id> [--domain d] [--json] ──────────

export async function specialistsCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "list";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  if (sub === "list") {
    const all = loadSpecialists(vault);
    if (args.json) out(all.map(({ mandate, method, never, ...s }) => ({ ...s, mandate })));
    else for (const s of all) console.log(`${s.on ? "on " : "off"} ${s.family.padEnd(8)} ${s.name.padEnd(12)} returns ${s.returns}, ceiling ${s.ceiling}`);
    return 0;
  }
  if (sub === "show") {
    const s = getSpecialist(vault, args.pos[1] ?? "");
    if (!s) { console.error(`no specialist "${args.pos[1] ?? ""}"`); return 1; }
    const d = args.get("domain");
    const view = d ? { ...forDomain(vault, s, d), notebook: readNotebook(vault, d, s.id) } : { spec: s, notebooks: notebooks(vault, s.id) };
    if (args.json) out(view);
    else console.log(JSON.stringify(view, null, 2));
    return 0;
  }
  if (sub === "notebook") {
    const id = args.pos[1] ?? "";
    const d = args.get("domain") ?? "";
    if (!id || !d) { console.error("usage: prevail specialists notebook <id> --domain <d>"); return 1; }
    const lines = readNotebook(vault, d, id);
    if (args.json) out({ path: notebookPath(vault, d, id), lines }); else for (const l of lines) console.log(`- ${l}`);
    return 0;
  }
  console.error("usage: prevail specialists list | show <id> [--domain d] | notebook <id> --domain d [--json]");
  return 1;
}
