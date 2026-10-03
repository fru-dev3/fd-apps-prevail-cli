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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildRoot, resolveDomainDir, runtimePath } from "./path-safety.ts";
import { appendLedger } from "./ledger.ts";
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
  /** A preset: the built-in it is built on (its ceiling, tools and checks are the ceiling here). */
  base?: string;
  /**
   * An outside agent (a remote MCP tool over HTTPS). It gets only the brief,
   * never the vault; every call waits for the user's yes; at most perDay calls
   * a day; its ceiling is draft at most. Enforced in jobs.ts and outside-agents.ts.
   */
  outside?: { endpoint: string; tool: string; perDay: number };
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
    ...(typeof fm.base === "string" && fm.base ? { base: fm.base } : base?.base ? { base: base.base } : {}),
    ...(typeof fm.endpoint === "string" && fm.endpoint
      ? { outside: { endpoint: fm.endpoint, tool: String(fm.tool ?? "ask"), perDay: Math.max(1, Math.min(50, Number(fm.calls_per_day ?? 5) || 5)) } }
      : {}),
  };
}

// ── The built-in roster (Phase 1 turned six on, Phase 2 six more, Phase 3 five more, Phase 4 the last four) ────

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
  spec(`id: analyst
name: Analyst
icon: chart-column
family: know
returns: numbers
ceiling: read
tools: [vault-read]
runtime: deep
budget: { minutes: 6, usd: 0.40, passes: 2 }
handoff: offer
done_when:
  - the answer is a number (or a few) in the first line
  - every number names the file or record it came from
  - assumptions are listed, never hidden`,
  "Numbers on the user's own data: spending, metrics, scenarios.",
  "1. Find the records in the vault that hold the numbers (ledgers, statements, metrics, task boards).\n2. Compute, do not estimate; show the arithmetic in one line per figure.\n3. When a scenario needs an assumption, state it and give the range.\n4. Lead with the figure that answers the question.",
  "Invent a number. Round away a difference that matters. Contact anyone."),
  spec(`id: historian
name: Historian
icon: history
family: know
returns: timeline
ceiling: read
tools: [vault-read]
runtime: standard
budget: { minutes: 5, usd: 0.30, passes: 2 }
handoff: offer
done_when:
  - dated lines, oldest first
  - each line names the file it came from
  - says what was decided and how it turned out, when that is known`,
  "What happened, what the user decided, and how it turned out.",
  "1. Read the decisions, decision records, logs and threads below and in the vault.\n2. Write a dated timeline, one line per event, oldest first.\n3. For each decision, add how it turned out when the record says so (the retro).\n4. End with one lesson the timeline shows.",
  "Fill a gap with a guess. Change any record."),
  spec(`id: sentinel
name: Sentinel
icon: radar
family: know
returns: alerts
ceiling: read
tools: [vault-read]
runtime: standard
budget: { minutes: 6, usd: 0.25, passes: 1 }
handoff: offer
done_when:
  - each alert says what is slipping, by when, and the evidence
  - nothing on the list is already done
  - says "nothing slipping" when that is true`,
  "Deadlines, risk, neglect and change: what is falling behind before it becomes a regret.",
  "1. Start from the radar below (computed by code).\n2. Add what the files show that the radar cannot: a renewal in a document, a promise in a note.\n3. One line per alert: what, by when, the evidence, the smallest next step.\n4. Most urgent first.",
  "Raise an alarm without evidence. Nag about what the user chose to let go."),
  spec(`id: auditor
name: Auditor
icon: badge-check
family: decide
returns: verified
ceiling: read
tools: [web, vault-read]
runtime: deep
budget: { minutes: 6, usd: 0.40, passes: 1 }
handoff: offer
done_when:
  - a verdict in the first line: verified, or flagged
  - each flag names the claim, what is wrong and the source that shows it`,
  "Checks the other specialists' claims, numbers and sources before anything is filed.",
  "1. Re-check every number against its source (open the file or the link).\n2. Re-check that each source says what the claim says.\n3. Verified only when nothing material is wrong; otherwise flagged, with each problem.\n4. Never fix the work yourself; say what is wrong.",
  "Pass a number you could not check. Add new claims."),
  spec(`id: builder
name: Builder
icon: hammer
family: do
returns: build
ceiling: write-vault
tools: [web, vault-read]
runtime: deep
budget: { minutes: 8, usd: 0.60, passes: 2 }
handoff: offer
done_when:
  - every file is a fenced block whose first line is "path: <relative file name>"
  - says how to run it and how to undo it`,
  "Code, sites, tools and automations, built as files the user reviews before anything runs.",
  "1. Plan the smallest thing that does the job.\n2. Write each file in full as a fenced block starting with its path line.\n3. Say how to run it, what it touches, and how to remove it.\n4. Nothing runs and nothing is installed: the files wait in the job folder.",
  "Run, install or deploy anything. Touch files outside the job folder."),
  spec(`id: clerk
name: Clerk
icon: folder-input
family: do
returns: vault changes
ceiling: write-vault
tools: [vault-read]
runtime: standard
budget: { minutes: 3, usd: 0.15, passes: 1 }
handoff: offer
done_when:
  - each change is a task for the owner, or a one-line note for a domain the job tells
  - nothing is filed twice (check the boards first)`,
  "Files and organizes: renewals, inbox items and loose notes go to the domain they belong to.",
  "1. Read what the team found.\n2. Turn each thing that needs doing into one task with a date, for the owner.\n3. Turn each fact another domain should know into one line for that domain.\n4. Skip anything already on a board.",
  "Delete or move a file. File anything to a domain the job does not tell."),
  // Phase 3: standing work. The Operator only proposes; each action it names
  // goes through the broker (the autonomy policy) and most wait for a yes.
  spec(`id: operator
name: Operator
icon: hand
family: do
returns: action
ceiling: act-ask
tools: [vault-read]
runtime: standard
budget: { minutes: 4, usd: 0.25, passes: 1 }
handoff: offer
done_when:
  - each action is one concrete step: the verb, what, where, and the amount when money moves
  - each action says how it can be undone, or that it cannot
  - at most five actions`,
  "Turns a decided plan into concrete actions (forms, bookings, purchases, account changes). It never acts itself: every action goes through the user's autonomy policy, and anything touching money, people, location or identity waits for a yes.",
  "1. Read the plan and the results of earlier steps.\n2. Write one action per line: the verb, what, where, and the amount when money moves.\n3. Say how each can be undone.\n4. Leave out anything the plan did not decide.",
  "Act, send, buy or sign anything yourself. Invent an amount, an account or a recipient."),
  spec(`id: coach
name: Coach
icon: sprout
family: grow
returns: goals
ceiling: write-vault
tools: [vault-read]
runtime: deep
budget: { minutes: 5, usd: 0.30, passes: 2 }
handoff: offer
done_when:
  - every goal or value it proposes quotes the user's own words from the notes
  - each active goal gets one if-then plan (if a cue, then a small step)
  - says what to let go of when something has stalled`,
  "Draws goals out in the user's own words, turns them into if-then plans and reviews how they are going. Never writes a goal for the user: it proposes, quoting them, and the user confirms.",
  "1. Read the Compass, the goals and what the user said in the notes below.\n2. For each active goal, one if-then plan: if a cue that happens anyway, then one small step.\n3. When the user's words name a goal, value or rule that is not in the Compass, propose it with their exact words.\n4. Name a stalled goal plainly and offer to release it with a replacement.",
  "Write goal text of your own. Cheer. Propose a line without the user's exact words."),
  spec(`id: skeptic
name: Skeptic
icon: shield-question
family: decide
returns: risks
ceiling: read
tools: [vault-read, web]
runtime: deep
budget: { minutes: 4, usd: 0.30, passes: 1 }
handoff: offer
done_when:
  - a pre-mortem: at least three ways it fails, most likely first
  - each risk names the early sign to watch for
  - one change that removes the biggest risk`,
  "A pre-mortem: imagines the plan has failed and says why, before anything is spent.",
  "1. Assume it is a year later and the plan failed.\n2. List the reasons, most likely first, each with how likely and the early sign.\n3. End with the one change that removes the biggest risk.",
  "Soften a risk to be agreeable. Raise a risk with nothing behind it."),
  spec(`id: interviewer
name: Interviewer
icon: messages-square
family: know
returns: memory updates
ceiling: write-vault
tools: [vault-read]
runtime: standard
budget: { minutes: 3, usd: 0.15, passes: 1 }
handoff: offer
done_when:
  - at most five questions, one gap each
  - each question is answerable in one line
  - nothing the notes already answer`,
  "Finds what a domain's notes are missing and asks the user, one short question at a time. The questions are kept in the domain's memory until answered.",
  "1. Read the domain's ideal state, memory and goals below.\n2. Find the gaps that matter most: a goal with no date, a number nobody wrote down, a person with no role.\n3. Ask one short question per gap, most useful first.",
  "Ask what the notes already say. Ask more than five. Guess the answers."),
  spec(`id: mechanic
name: Mechanic
icon: wrench
family: do
returns: repairs
ceiling: write-vault
tools: [vault-read]
runtime: standard
budget: { minutes: 4, usd: 0.20, passes: 1 }
handoff: offer
done_when:
  - each repair names what is broken, the evidence and the fix
  - each fix is a task for the user or a step Prevail can take
  - says "nothing to repair" when that is true`,
  "Keeps Prevail itself healthy: connections, failing loops, capture gaps, duplicates.",
  "1. Start from the health report below (computed by code).\n2. One repair per problem: what is broken, since when, the fix.\n3. File each fix as a task for the user; never change a connection or a credential yourself.",
  "Touch a credential, a token or a connection. Delete anything."),
  // Phase 4: the last four. Drafts are stored and never sent; the Tutor files
  // lessons into the domain by code; the Confidant only reads and reflects.
  spec(`id: negotiator
name: Negotiator
icon: scale
family: decide
returns: strategy
ceiling: draft
tools: [vault-read, web]
runtime: deep
budget: { minutes: 5, usd: 0.35, passes: 2 }
handoff: offer
done_when:
  - names the user's leverage and the other side's, each with where it comes from
  - a walk-away point and a first ask, both as numbers or plain terms
  - at least one script or counteroffer as a draft, never sent`,
  "Prepares the user to negotiate: leverage on both sides, a first ask, a walk-away point, and the words to say.",
  "1. Read what the user has (offers, quotes, prices, dates) in the notes below and the team's results.\n2. Name the user's leverage and the other side's, each with its source.\n3. Set a first ask and a walk-away point; say why each is reasonable.\n4. Write the opening message or a counteroffer as a draft, in the user's voice.",
  "Send, sign or accept anything. Invent a competing offer. Bluff on the user's behalf."),
  spec(`id: liaison
name: Liaison
icon: heart-handshake
family: do
returns: nudges
ceiling: draft
tools: [vault-read]
runtime: standard
budget: { minutes: 3, usd: 0.15, passes: 1 }
handoff: offer
done_when:
  - at most five people, each with why now (the days since you were in touch, a date, a promise)
  - a short check-in draft for each, in the user's voice, never sent
  - nobody the notes do not know`,
  "Keeps relationships warm: who is due a call or a note, and a check-in drafted for each.",
  "1. Start from the people code found below (days since last in touch against their normal).\n2. Add anyone the job names, if the notes know them.\n3. One line each on why now, and one short check-in draft each.",
  "Contact anyone. Add a person the notes do not know. Write anything a person would find creepy (where they were, what they bought)."),
  spec(`id: tutor
name: Tutor
icon: graduation-cap
family: grow
returns: lessons
ceiling: write-vault
tools: [vault-read, web]
runtime: deep
budget: { minutes: 5, usd: 0.30, passes: 2 }
handoff: offer
done_when:
  - a short curriculum: three to seven lessons, each one sitting long
  - a quiz of at least three questions, each with its answer
  - a review date for what is easy to forget`,
  "Teaches: a curriculum for what the user wants to learn, quizzes, and spaced review. The lesson plan is filed into the domain by code.",
  "1. Read what the user already knows and wants (notes, goals, the project if there is one).\n2. Break it into three to seven lessons, smallest useful step first.\n3. Write a quiz with answers on the first lesson.\n4. Set a review date a few days out for what fades fastest.",
  "Pad the curriculum. Pretend to certify anything. Quiz on what was not taught."),
  spec(`id: confidant
name: Confidant
icon: moon-star
family: grow
returns: reflection
ceiling: read
tools: [vault-read]
runtime: deep
budget: { minutes: 4, usd: 0.25, passes: 1 }
handoff: offer
done_when:
  - every pattern quotes the user's own words as its evidence
  - ends with one question for the user to sit with, not advice
  - nothing is written anywhere`,
  "A thinking partner: reads the user's journals and notes for patterns, reflects them back with the user's own words, and asks one good question.",
  "1. Read the journal and notes below.\n2. Name at most three patterns, each with the user's exact words as evidence.\n3. Reflect, do not prescribe; end with one open question.",
  "Diagnose, label or give medical or legal advice. Write to the vault. Read a domain the user keeps out of reach."),
];

export function builtInSpecialists(): Specialist[] {
  return BUILT_IN_TEXT.map((t) => ({ ...parseSpecialist(t)!, builtIn: true }));
}

// ── Loading ─────────────────────────────────────────────────────────────────

function readText(p: string): string {
  if (!existsSync(p)) return "";
  try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } }
}

export function specialistsDir(vault: string): string { return join(buildRoot(vault), "specialists"); }

/** Built-ins, each overridden by build/specialists/<id>.md if present, plus the user's own. */
export function loadSpecialists(vault: string): Specialist[] {
  const builtIns = new Map(builtInSpecialists().map((s) => [s.id, s]));
  const all = new Map(builtIns);
  const dir = specialistsDir(vault);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
      const text = readText(join(dir, f));
      const own = all.get(f.replace(/\.md$/, ""));
      // A preset names the built-in it is built on and inherits what it leaves out.
      const fmBase = String(parseFrontmatter(text).fm.base ?? "");
      const preset = !own?.builtIn && fmBase ? builtIns.get(fmBase) : undefined;
      const s = parseSpecialist(text, own ?? preset);
      if (!s) continue;
      if (own && !own.mandate && !s.mandate) s.on = false;
      all.set(s.id, clampCustom({ ...s, builtIn: !!own?.builtIn, source: `build/specialists/${f}` }, preset));
    }
  }
  return [...all.values()];
}

/**
 * The limits on a specialist the user made, in code: a preset
 * never goes past the built-in it is built on (ceiling, tools); a custom one
 * never acts on its own; an outside agent reads nothing from the vault and
 * stops at draft.
 */
export function clampCustom(s: Specialist, base?: Specialist): Specialist {
  if (s.builtIn) return s;
  const out = { ...s };
  if (base) {
    if (CEILING_RANK[out.ceiling] > CEILING_RANK[base.ceiling]) out.ceiling = base.ceiling;
    out.tools = out.tools.filter((t) => base.tools.includes(t));
  }
  if (CEILING_RANK[out.ceiling] > CEILING_RANK["act-ask"]) out.ceiling = "act-ask";
  if (out.outside) {
    // Quoted text back, nothing filed by it: findings, discoveries or a draft.
    if (!["findings", "discoveries", "draft"].includes(out.returns)) out.returns = "findings";
    // It reads nothing and writes nothing here: read, or draft (text the user may send).
    if (out.ceiling !== "read" && out.ceiling !== "draft") out.ceiling = "read";
    out.tools = [];
    out.apps = [];
  }
  return out;
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

// ── Editing: the app's Edit saves an override, Reset moves it aside ─────────
//
// Save writes build/specialists/<id>.md (the same shape as the built-ins); the
// file it replaces is kept as build/specialists/.versions/<id>.<ISO>.md and a
// line goes to build/_meta/specialists/ledger.jsonl. Reset moves the override
// into .versions too, so nothing is ever deleted. A ceiling above the
// built-in's is refused unless the caller says the user confirmed it.

export const SPECIALIST_TOOLS = ["web", "vault-read"];
export const SPECIALIST_RUNTIMES = ["fast", "standard", "deep"];

export interface SpecialistEdit {
  name?: string; returns?: string; ceiling?: Ceiling; tools?: string[]; apps?: string[]; runtime?: string;
  budget?: { minutes?: number; usd?: number; passes?: number }; handoff?: Handoff; doneWhen?: string[];
  mandate?: string; method?: string; never?: string;
}
export type SaveResult = { ok: true; spec: Specialist; path: string; version: string | null } | { ok: false; error: string; needsConfirm?: boolean };

const oneLine = (x: string, n: number) => x.replace(/\s+/g, " ").trim().slice(0, n);
const block = (x: string) => x.replace(/\r/g, "").replace(/^##\s/gm, "### ").trim().slice(0, 4000);
const idOk = (x: string) => /^[a-z][a-z0-9-]{0,40}$/.test(x);

/** The file text for a specialist, in the shape parseSpecialist reads back. */
export function serializeSpecialist(s: Specialist): string {
  const fm = [
    `id: ${s.id}`, `name: ${s.name}`, `icon: ${s.icon}`, `family: ${s.family}`, `returns: ${s.returns}`, `ceiling: ${s.ceiling}`,
    `tools: [${s.tools.join(", ")}]`, `apps: [${s.apps.join(", ")}]`, `runtime: ${s.runtime}`, `lens: ${s.lens}`,
    `budget: { minutes: ${s.budget.minutes}, usd: ${s.budget.usd}, passes: ${s.budget.passes} }`, `handoff: ${s.handoff}`,
    ...(s.doneWhen.length ? ["done_when:", ...s.doneWhen.map((d) => `  - ${d}`)] : []),
    ...(s.on ? [] : ["on: false"]),
    ...(s.base ? [`base: ${s.base}`] : []),
    ...(s.outside ? [`endpoint: ${s.outside.endpoint}`, `tool: ${s.outside.tool}`, `calls_per_day: ${s.outside.perDay}`] : []),
  ];
  return `---\n${fm.join("\n")}\n---\n## Mandate\n${s.mandate}\n## Method\n${s.method}\n## Never\n${s.never}\n`;
}

function isoStamp(now: number): string { return new Date(now).toISOString().replace(/[:.]/g, "-"); }

/** Move (or copy) a file into a sibling .versions/<id>.<ISO>.md; returns the new path. */
function keepVersion(file: string, id: string, now: number, move: boolean): string | null {
  if (!existsSync(file)) return null;
  const dir = join(file, "..", ".versions");
  mkdirSync(dir, { recursive: true });
  let to = join(dir, `${id}.${isoStamp(now)}.md`);
  for (let i = 2; existsSync(to); i++) to = join(dir, `${id}.${isoStamp(now)}-${i}.md`);
  if (move) renameSync(file, to); else writeFileSync(to, readText(file));
  return to;
}

function ledger(vault: string, row: Record<string, unknown>, now: number): void {
  appendLedger(join(runtimePath(vault, "_meta"), "specialists", "ledger.jsonl"), JSON.stringify({ ts: now, ...row }), now);
}

/** Apply an edit to a specialist and validate it. Pure: nothing is written. */
export function applyEdit(base: Specialist, e: SpecialistEdit): Specialist | string {
  const out: Specialist = { ...base, budget: { ...base.budget }, tools: [...base.tools], apps: [...base.apps], doneWhen: [...base.doneWhen] };
  if (e.name !== undefined) { out.name = oneLine(e.name, 40); if (!out.name) return "a specialist needs a name"; }
  if (e.returns !== undefined) out.returns = oneLine(e.returns, 40) || base.returns;
  if (e.ceiling !== undefined) { if (!CEILINGS.includes(e.ceiling)) return `unknown ceiling: ${e.ceiling}`; out.ceiling = e.ceiling; }
  if (e.tools !== undefined) {
    const bad = e.tools.filter((t) => !SPECIALIST_TOOLS.includes(t));
    if (bad.length) return `unknown tool: ${bad.join(", ")}`;
    out.tools = [...new Set(e.tools)];
  }
  if (e.apps !== undefined) {
    const bad = e.apps.filter((a) => !idOk(a));
    if (bad.length) return `not an app id: ${bad.join(", ")}`;
    out.apps = [...new Set(e.apps)];
  }
  if (e.runtime !== undefined) { if (!SPECIALIST_RUNTIMES.includes(e.runtime)) return `unknown runtime: ${e.runtime}`; out.runtime = e.runtime; }
  if (e.handoff !== undefined) { if (!["off", "offer", "auto"].includes(e.handoff)) return `unknown handoff: ${e.handoff}`; out.handoff = e.handoff; }
  if (e.budget) {
    const m = e.budget.minutes ?? out.budget.minutes, u = e.budget.usd ?? out.budget.usd, p = e.budget.passes ?? out.budget.passes;
    if (!(m > 0 && m <= 120)) return "minutes must be between 1 and 120";
    if (!(u >= 0 && u <= 50)) return "dollars must be between 0 and 50";
    if (!(Number.isInteger(p) && p >= 1 && p <= 5)) return "passes must be 1 to 5";
    out.budget = { minutes: m, usd: Math.round(u * 100) / 100, passes: p };
  }
  if (e.doneWhen !== undefined) out.doneWhen = e.doneWhen.map((d) => oneLine(d, 200)).filter(Boolean).slice(0, 12);
  if (e.mandate !== undefined) out.mandate = block(e.mandate);
  if (e.method !== undefined) out.method = block(e.method);
  if (e.never !== undefined) out.never = block(e.never);
  if (!out.mandate) return "a specialist needs a mandate";
  return out;
}

/** Save the user's version of a specialist. A ceiling above the built-in's needs confirmRaise. */
export function saveSpecialist(vault: string, id: string, e: SpecialistEdit, o: { confirmRaise?: boolean; now?: number } = {}): SaveResult {
  const now = o.now ?? Date.now();
  if (!idOk(id)) return { ok: false, error: `not a specialist id: ${id}` };
  const builtIn = builtInSpecialists().find((s) => s.id === id);
  const cur = getSpecialist(vault, id);
  if (!cur) return { ok: false, error: `no specialist "${id}"` };
  if (builtIn && !builtIn.mandate) return { ok: false, error: `${cur.name} is not built yet` };
  const next = applyEdit(cur, e);
  if (typeof next === "string") return { ok: false, error: next };
  const ceilingOf = builtIn?.ceiling ?? cur.ceiling;
  if (CEILING_RANK[next.ceiling] > CEILING_RANK[ceilingOf] && !o.confirmRaise) {
    return { ok: false, needsConfirm: true, error: `This raises ${cur.name}'s ceiling above ${ceilingOf}. Confirm to save.` };
  }
  const file = join(specialistsDir(vault), `${id}.md`);
  const version = keepVersion(file, id, now, false);
  mkdirSync(specialistsDir(vault), { recursive: true });
  writeFileSync(file, serializeSpecialist(next));
  ledger(vault, { action: "save", id, from: cur.ceiling, to: next.ceiling, version: version ? relative(vault, version) : null }, now);
  return { ok: true, spec: getSpecialist(vault, id)!, path: `build/specialists/${id}.md`, version: version ? relative(vault, version) : null };
}

/** Back to the built-in: the override moves to .versions, never deleted. */
export function resetSpecialist(vault: string, id: string, now = Date.now()): { ok: boolean; moved: string | null; error?: string } {
  if (!idOk(id)) return { ok: false, moved: null, error: `not a specialist id: ${id}` };
  if (!builtInSpecialists().some((s) => s.id === id)) return { ok: false, moved: null, error: `${id} has no built-in to go back to` };
  const moved = keepVersion(join(specialistsDir(vault), `${id}.md`), id, now, true);
  if (moved) ledger(vault, { action: "reset", id, version: relative(vault, moved) }, now);
  return { ok: true, moved: moved ? relative(vault, moved) : null };
}

export interface DomainEdit { ceiling?: Ceiling; tools?: string[]; apps?: string[]; on?: boolean; notes?: string }

/**
 * The user's per-domain instructions. They may only TIGHTEN the specialist:
 * a ceiling at or below its own, tools and apps from its own list. Anything
 * looser is refused here, in code, before a file is written.
 */
export function saveDomainInstructions(vault: string, id: string, domain: string, e: DomainEdit, now = Date.now()): { ok: true; path: string } | { ok: false; error: string } {
  const s = getSpecialist(vault, id);
  if (!s) return { ok: false, error: `no specialist "${id}"` };
  if (!/^[a-z0-9][a-z0-9_-]{0,60}$/i.test(domain) || !listDomainDirs(vault).includes(domain)) return { ok: false, error: `no domain "${domain}"` };
  const dir = join(resolveDomainDir(vault, domain), "source", "specialists");
  if (e.ceiling !== undefined && (!CEILINGS.includes(e.ceiling) || CEILING_RANK[e.ceiling] > CEILING_RANK[s.ceiling])) {
    return { ok: false, error: `In a domain, ${s.name} can only be tightened: its ceiling here must be ${s.ceiling} or lower.` };
  }
  const looser = [...(e.tools ?? []).filter((t) => !s.tools.includes(t)), ...(e.apps ?? []).filter((a) => !s.apps.includes(a))];
  if (looser.length) return { ok: false, error: `In a domain, ${s.name} can only be tightened: ${looser.join(", ")} is not one of its own.` };
  const fm = [
    ...(e.ceiling !== undefined && e.ceiling !== s.ceiling ? [`ceiling: ${e.ceiling}`] : []),
    ...(e.tools !== undefined && e.tools.length < s.tools.length ? [`tools: [${e.tools.join(", ")}]`] : []),
    ...(e.apps !== undefined && e.apps.length < s.apps.length ? [`apps: [${e.apps.join(", ")}]`] : []),
    ...(e.on === false ? ["on: false"] : []),
  ];
  const notes = (e.notes ?? "").replace(/\r/g, "").trim().slice(0, 2000);
  const file = join(dir, `${id}.md`);
  keepVersion(file, id, now, false);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${fm.length ? `---\n${fm.join("\n")}\n---\n` : ""}${notes}\n`);
  ledger(vault, { action: "domain", id, domain, tighten: fm }, now);
  return { ok: true, path: `data/domains/${domain}/source/specialists/${id}.md` };
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
  if (sub === "save" || sub === "domain-save") {
    // The edit is JSON, from --file <path> or --file - (stdin).
    const id = args.pos[1] ?? "";
    const file = args.get("file") ?? "-";
    let edit: Record<string, unknown>;
    try { edit = JSON.parse(file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8")) as Record<string, unknown>; }
    catch (e) { out({ ok: false, error: `not JSON: ${(e as Error).message}` }); return 1; }
    const r = sub === "save"
      ? saveSpecialist(vault, id, edit as SpecialistEdit, { confirmRaise: args.has("confirm-raise") })
      : saveDomainInstructions(vault, id, args.get("domain") ?? "", edit as DomainEdit);
    // With --json a refusal is an answer ({ ok: false, needsConfirm }), not a crash.
    if (args.json) { out(r); return 0; }
    console.log(r.ok ? "Saved." : r.error);
    return r.ok ? 0 : 1;
  }
  if (sub === "reset") {
    const r = resetSpecialist(vault, args.pos[1] ?? "");
    if (args.json) { out(r); return 0; }
    console.log(r.ok ? (r.moved ? `Back to the built-in. Your version is in ${r.moved}.` : "Already the built-in.") : r.error);
    return r.ok ? 0 : 1;
  }
  if (sub === "draft" || sub === "create") {
    // Made by talking: draft takes { turns, draft } as JSON; create takes the draft.
    const file = args.get("file") ?? "-";
    let body: Record<string, unknown>;
    try { body = JSON.parse(file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8")) as Record<string, unknown>; }
    catch (e) { out({ ok: false, error: `not JSON: ${(e as Error).message}` }); return 1; }
    const c = await import("./specialists-custom.ts");
    try {
      if (sub === "draft") { out(await c.draftSpecialist(vault, { turns: (body.turns ?? []) as never, draft: (body.draft ?? {}) as never })); return 0; }
      const r = await c.createSpecialist(vault, body, { confirmRaise: args.has("confirm-raise") });
      if (args.json) out({ ok: true, ...r }); else console.log(`Added ${r.spec.name} (${r.path}).`);
      return 0;
    } catch (e) { if (args.json) { out({ ok: false, error: (e as Error).message }); return 0; } console.error((e as Error).message); return 1; }
  }
  console.error("usage: prevail specialists list | show <id> [--domain d] | notebook <id> --domain d | save <id> [--file f|-] [--confirm-raise] | domain-save <id> --domain d [--file f|-] | reset <id> | draft [--file f|-] | create [--file f|-] [--confirm-raise] [--json]");
  return 1;
}
