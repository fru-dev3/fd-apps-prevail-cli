// The Compass chain (goals-plan.md "The Compass chain", phase G1b): purpose,
// values, mission statement, vision, objectives, goals, initiatives, missions
// and tasks, each referencing the one above, so any task can answer "why" by
// walking up and any purpose can show what it moves by walking down.
//
// Links live where the line lives: a mission statement's ~serves: values, a
// vision's ~statement:, an objective's ~vision:, a goal's ~objective: (life
// goals in build/compass.md, domain goals in source/goals.md), an initiative
// under its goal, a mission's `path:` (the initiative it carries out) or
// `goal:`, a task's ~initiative:, ~goal: or ~mission: (or living in a
// mission's own board). Two links are implicit: values serve the one purpose,
// and a vision (an objective) with no token links to the only mission
// statement (vision) there is. Links are never forced: what is not linked is
// shown and counted per level, never blocked.
//
// Proposed links (bootstrap, the Compass conversation, code) wait in
// build/_meta/compass/links.json with the quote that suggested them; nothing
// is linked until the user accepts it, and a link without a quote is refused.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  addItem, bootstrapSources, compassId, compassMetaDir, findById, isProposed, items, mission, quoteSource, readCompass, saveCompass, titleFromUserWords,
  type CompassItem, type Field, type Kind, type Source,
} from "./compass.ts";
import { buildRoot, dataRoot, resolveDomainDir } from "./path-safety.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { parseModArgs } from "./cli-args.ts";

export type Level = "purpose" | "value" | "statement" | "vision" | "objective" | "goal" | "initiative" | "mission" | "task";
export const LEVELS: { level: Level; label: string }[] = [
  { level: "purpose", label: "Purpose" }, { level: "value", label: "Values" }, { level: "statement", label: "Mission statement" },
  { level: "vision", label: "Vision" }, { level: "objective", label: "Objectives" }, { level: "goal", label: "Goals" },
  { level: "initiative", label: "Initiatives" }, { level: "mission", label: "Missions" }, { level: "task", label: "Tasks" },
];

export interface ChainNode {
  id: string;
  level: Level;
  title: string;
  status: string;
  parents: string[];
  children: string[];
  linked: boolean;
  implicit?: boolean;
  domain?: string;
  metric?: string;
  target?: string;
  due?: string;
  needs?: string[];             // e.g. "metric": an objective with no measure yet
  mission?: { slug: string; name: string; status: string };
  local?: boolean;
}
export interface ChainTree {
  schema: number;
  nodes: ChainNode[];
  levels: { level: Level; label: string; count: number; notLinked: number }[];
  domainGoals: { total: number; linked: number };
  tasks: { open: number; linked: number };
}

function readText(p: string): string {
  if (!existsSync(p)) return "";
  try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } }
}
const split = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const field = (x: { fields: Field[] }, k: string) => x.fields.find((f) => f.key === k)?.value?.replace(/^"(.*)"$/, "$1");
const LIVE_GOAL = (s: string) => !["achieved", "released", "done"].includes(s);

/** Every task board: domains' memory/tasks.md (or _tasks.md) and missions' memory/tasks.md. */
export function boards(vault: string): { owner: string; mission?: string; file: string }[] {
  const out: { owner: string; mission?: string; file: string }[] = [];
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    const dir = resolveDomainDir(vault, d);
    const f = [join(dir, "memory", "tasks.md"), join(dir, "_tasks.md")].find((x) => existsSync(x));
    if (f) out.push({ owner: d, file: f });
  }
  const mroot = join(dataRoot(vault), "missions");
  if (existsSync(mroot)) {
    try {
      for (const slug of readdirSync(mroot)) {
        const f = join(mroot, slug, "memory", "tasks.md");
        if (existsSync(f)) out.push({ owner: `mission/${slug}`, mission: slug, file: f });
      }
    } catch { /* none */ }
  }
  return out;
}

export interface BoardTask { owner: string; mission?: string; file: string; text: string; id?: string; done: boolean; initiative?: string; goal?: string; missionTok?: string }
export function openTasks(vault: string): BoardTask[] {
  const out: BoardTask[] = [];
  for (const b of boards(vault)) {
    for (const l of readText(b.file).split("\n")) {
      const m = /^\s*-\s+\[( |x|X)\]\s+(.+)$/.exec(l);
      if (!m || m[1] !== " ") continue;
      const body = m[2]!;
      const tok = (k: string) => new RegExp(`(?:^|\\s)~${k}:(\\S+)`).exec(body)?.[1];
      if (tok("trashed")) continue;
      out.push({
        owner: b.owner, ...(b.mission ? { mission: b.mission } : {}), file: b.file,
        text: body.replace(/\s+[~@+]\S+/g, "").trim(), done: false,
        ...(tok("id") ? { id: tok("id") } : {}), ...(tok("initiative") ? { initiative: tok("initiative") } : {}),
        ...(tok("goal") ? { goal: tok("goal") } : {}), ...(tok("mission") ? { missionTok: tok("mission") } : {}),
      });
    }
  }
  return out;
}

interface DGoal { id: string; title: string; status: string; domain: string; objective?: string; due?: string }
function domainGoals(vault: string): DGoal[] {
  const out: DGoal[] = [];
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    const body = readText(join(resolveDomainDir(vault, d), "source", "goals.md"));
    for (const l of body.split("\n")) {
      const m = /^\s*-\s+\[( |x|X)\]\s+(.+)$/.exec(l);
      if (!m) continue;
      const tokens: Record<string, string> = {};
      const title = m[2]!.replace(/(^|\s)~([a-z_]+):(\S+)/g, (_x, _s, k: string, v: string) => { tokens[k] = v; return ""; }).replace(/\s+/g, " ").trim();
      if (!tokens.id) continue;
      out.push({ id: tokens.id, title, status: tokens.status || (m[1] === " " ? "active" : "done"), domain: d, ...(tokens.objective ? { objective: tokens.objective } : {}), ...(tokens.due ? { due: tokens.due } : {}) });
    }
  }
  return out;
}

interface MissionLite { slug: string; name: string; status: string; goal?: string; path?: string }
function missionsLite(vault: string): MissionLite[] {
  const root = join(dataRoot(vault), "missions");
  if (!existsSync(root)) return [];
  const out: MissionLite[] = [];
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  for (const slug of names) {
    const t = readText(join(root, slug, "mission.md"));
    const fm = /^---\n([\s\S]*?)\n---/.exec(t)?.[1];
    if (!fm) continue;
    const get = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1]?.trim().replace(/^"(.*)"$/, "$1") || undefined;
    const status = get("status") ?? "active";
    if (status === "archived") continue;
    const path = get("path") || get("initiative");
    out.push({ slug, name: get("name") ?? slug, status, ...(get("goal") ? { goal: get("goal") } : {}), ...(path ? { path } : {}) });
  }
  return out;
}

/** The whole chain as a tree: every node with its parents and children, and what is not linked per level. */
export function compassTree(vault: string, o: { confirmedOnly?: boolean; tasks?: boolean } = {}): ChainTree {
  const doc = readCompass(vault);
  const keep = (x: { tokens: Record<string, string> }) => !o.confirmedOnly || !isProposed(x);
  const nodes = new Map<string, ChainNode>();
  const add = (n: Omit<ChainNode, "children" | "linked"> & { linked?: boolean }) => { const full: ChainNode = { children: [], linked: n.parents.length > 0, ...n }; nodes.set(n.id, full); return full; };
  const status = (x: { tokens: Record<string, string> }, kind: string) => x.tokens.status ?? (kind === "goal" ? "active" : "confirmed");

  const p = mission(doc);
  const hasPurpose = !!(p && p.text && keep(p));
  if (hasPurpose) add({ id: "purpose", level: "purpose", title: p!.text.replace(/^>\s*/gm, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim(), status: status(p!, "mission"), parents: [], linked: true });
  const of = (k: Kind) => items(doc, k).filter(keep);
  const values = of("value").sort((a, b) => Number(a.tokens.rank ?? 99) - Number(b.tokens.rank ?? 99));
  const local = (it: CompassItem) => (it.flags.includes("local") ? { local: true } : {});
  for (const v of values) add({ id: v.id, level: "value", title: v.title, status: status(v, "value"), parents: hasPurpose ? ["purpose"] : [], ...(hasPurpose ? { implicit: true } : {}), ...local(v) });
  const known = (ids: string[], lvl: Level) => ids.filter((id) => nodes.get(id)?.level === lvl);
  const statements = of("statement");
  for (const s of statements) add({ id: s.id, level: "statement", title: s.title, status: status(s, "statement"), parents: known(split(s.tokens.serves), "value"), ...local(s) });
  const visions = of("vision");
  for (const v of visions) {
    const explicit = known(split(v.tokens.statement), "statement");
    const implicit = !explicit.length && !v.tokens.statement && statements.length === 1;
    add({ id: v.id, level: "vision", title: v.title, status: status(v, "vision"), parents: implicit ? [statements[0]!.id] : explicit, ...(implicit ? { implicit: true } : {}), ...local(v) });
  }
  for (const ob of of("objective")) {
    const explicit = known(split(ob.tokens.vision), "vision");
    const implicit = !explicit.length && !ob.tokens.vision && visions.length === 1;
    add({
      id: ob.id, level: "objective", title: ob.title, status: status(ob, "objective"), parents: implicit ? [visions[0]!.id] : explicit,
      ...(implicit ? { implicit: true } : {}), ...(ob.tokens.metric ? { metric: ob.tokens.metric } : { needs: ["metric"] }),
      ...(ob.tokens.target ? { target: ob.tokens.target } : {}), ...(ob.tokens.due ? { due: ob.tokens.due } : {}), ...local(ob),
    });
  }
  const goals = of("goal");
  for (const g of goals) {
    add({ id: g.id, level: "goal", title: g.title, status: status(g, "goal"), parents: known(split(g.tokens.objective), "objective"), ...(g.tokens.domain ? { domain: g.tokens.domain } : {}), ...(g.tokens.due ? { due: g.tokens.due } : {}), ...local(g) });
    for (const pa of g.paths) {
      const st = pa.tokens.status ?? "proposed";
      if (o.confirmedOnly && (st === "proposed" || st === "rejected")) continue;
      add({ id: pa.id, level: "initiative", title: pa.title, status: st, parents: [g.id], ...(g.tokens.domain ? { domain: g.tokens.domain } : {}) });
    }
  }
  // Domain goals join when something links them: up to an objective, or a task or mission down to them.
  const tasks = o.tasks === false ? [] : openTasks(vault);
  const missions = missionsLite(vault);
  const wantedGoals = new Set([...tasks.map((t) => t.goal), ...missions.map((m) => m.goal)].filter(Boolean) as string[]);
  const dgs = domainGoals(vault);
  let dLinked = 0;
  for (const g of dgs) {
    if (!LIVE_GOAL(g.status)) continue;
    const up = known(split(g.objective), "objective");
    if (up.length) dLinked++;
    if ((up.length || wantedGoals.has(g.id)) && !nodes.has(g.id)) add({ id: g.id, level: "goal", title: g.title, status: g.status, parents: up, domain: g.domain, ...(g.due ? { due: g.due } : {}) });
  }
  // Missions under the initiative they carry out (the path line's mission: field, or the mission's own path:), else under their goal.
  const initiativeMission = new Map<string, string>();
  for (const g of goals) for (const pa of g.paths) { const m = field(pa, "mission"); if (m) initiativeMission.set(m, pa.id); }
  for (const m of missions) {
    const up = (m.path && nodes.get(m.path)?.level === "initiative" ? m.path : undefined) ?? initiativeMission.get(m.slug) ?? (m.goal && nodes.get(m.goal) ? m.goal : undefined);
    add({ id: `mission/${m.slug}`, level: "mission", title: m.name, status: m.status, parents: up ? [up] : [] });
    if (up && nodes.get(up)?.level === "initiative") {
      const ini = nodes.get(up)!;
      if (!ini.mission || m.status === "active") ini.mission = { slug: m.slug, name: m.name, status: m.status };
    }
  }
  // Tasks: only linked ones become nodes; the rest are counted.
  let tLinked = 0;
  tasks.forEach((t, i) => {
    const up = (t.initiative && nodes.has(t.initiative) ? t.initiative : undefined)
      ?? (t.goal && nodes.has(t.goal) ? t.goal : undefined)
      ?? (t.missionTok && nodes.has(`mission/${t.missionTok}`) ? `mission/${t.missionTok}` : undefined)
      ?? (t.mission && nodes.has(`mission/${t.mission}`) ? `mission/${t.mission}` : undefined);
    if (!up) return;
    tLinked++;
    add({ id: `task:${t.owner}:${t.id ?? createHash("sha1").update(`${t.text}\n${i}`).digest("hex").slice(0, 8)}`, level: "task", title: t.text, status: "open", parents: [up], ...(t.owner.startsWith("mission/") ? {} : { domain: t.owner }) });
  });
  for (const n of nodes.values()) for (const pid of n.parents) nodes.get(pid)?.children.push(n.id);
  const list = [...nodes.values()];
  const live = (n: ChainNode) => n.level !== "goal" || LIVE_GOAL(n.status);
  const levels = LEVELS.map(({ level, label }) => {
    const at = list.filter((n) => n.level === level);
    const notLinked = level === "task" ? tasks.length - tLinked
      : level === "mission" ? at.filter((n) => !n.linked && (n.status === "active" || n.status === "paused")).length
      : at.filter((n) => !n.linked && live(n) && n.status !== "rejected" && n.status !== "retired").length;
    return { level, label, count: level === "task" ? tLinked : at.length, notLinked: level === "purpose" ? 0 : notLinked };
  });
  return { schema: 2, nodes: list, levels, domainGoals: { total: dgs.filter((g) => LIVE_GOAL(g.status)).length, linked: dLinked }, tasks: { open: tasks.length, linked: tLinked } };
}

/** Walk up from a node to its vision (or as far as links go): initiative, goal, objective, vision. The first parent wins. */
export function walkUp(tree: ChainTree, id: string, stop: Level = "vision"): ChainNode[] {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const out: ChainNode[] = [];
  const seen = new Set<string>([id]);
  let cur = byId.get(id);
  while (cur && cur.parents.length) {
    const up = byId.get(cur.parents[0]!);
    if (!up || seen.has(up.id)) break;
    out.push(up);
    seen.add(up.id);
    if (up.level === stop || up.level === "purpose" || up.level === "value") break;
    cur = up;
  }
  return out;
}

/** The chain a mission serves (initiative, goal, objective, vision), confirmed lines only, as one line; "" when not linked. */
export function missionChainText(vault: string, slug: string): string {
  try { return chainText(walkUp(compassTree(vault, { confirmedOnly: true, tasks: false }), `mission/${slug}`)); } catch { return ""; }
}

/** "Initiative > Goal > Objective > Vision", for one line of context. */
export const chainText = (nodes: ChainNode[]) => nodes.map((n) => n.title).join(" > ");

// ── Proposed links ──────────────────────────────────────────────────────────

export type LinkKind = "goal-objective" | "task-initiative" | "task-goal";
export interface LinkProposal {
  id: string; kind: LinkKind; from: string; to: string; fromTitle: string; toTitle: string;
  quote: string; source: string; by: "bootstrap" | "conversation" | "code" | "user";
  status: "proposed" | "accepted" | "declined"; ts: number;
  domain?: string; file?: string;
}
const linksPath = (vault: string) => join(compassMetaDir(vault), "links.json");
export function readLinks(vault: string): LinkProposal[] {
  try { const j = JSON.parse(readFileSync(linksPath(vault), "utf8")); return Array.isArray(j) ? j as LinkProposal[] : []; } catch { return []; }
}
function writeLinks(vault: string, ls: LinkProposal[]): void {
  mkdirSync(compassMetaDir(vault), { recursive: true });
  writeFileSync(linksPath(vault), `${JSON.stringify(ls, null, 2)}\n`);
}

/**
 * Propose one link. Refused (null with the reason) without a quote, when an
 * end is unknown, when it is already linked, or when the same link was
 * already proposed or turned down. Nothing is linked here.
 */
export function proposeLink(vault: string, p: Omit<LinkProposal, "id" | "status" | "ts" | "fromTitle" | "toTitle"> & { fromTitle?: string; toTitle?: string }, now = Date.now(), tree = compassTree(vault)): { ok: true; link: LinkProposal } | { ok: false; why: string } {
  if (!p.quote || p.quote.replace(/["\s]/g, "").length < 3) return { ok: false, why: "a link needs the quote that suggests it" };
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const to = byId.get(p.to);
  const want: Level = p.kind === "goal-objective" ? "objective" : p.kind === "task-initiative" ? "initiative" : "goal";
  if (!to || to.level !== want) return { ok: false, why: `no ${want} ${p.to}` };
  let fromTitle = p.fromTitle;
  if (p.kind === "goal-objective") {
    const from = byId.get(p.from) ?? domainGoals(vault).filter((g) => g.id === p.from).map((g) => ({ id: g.id, title: g.title, parents: g.objective ? [g.objective] : [], domain: g.domain }))[0];
    if (!from) return { ok: false, why: `no goal ${p.from}` };
    if (from.parents.includes(p.to)) return { ok: false, why: "already linked" };
    fromTitle = from.title;
  } else if (!fromTitle) return { ok: false, why: "a task link needs the task's words" };
  const id = createHash("sha1").update(`${p.kind}\n${p.from}\n${p.to}`).digest("hex").slice(0, 10);
  const all = readLinks(vault);
  const had = all.find((l) => l.id === id);
  if (had) return { ok: false, why: had.status === "declined" ? "turned down before" : had.status === "accepted" ? "already linked" : "already proposed" };
  const link: LinkProposal = { ...p, id, fromTitle: fromTitle!, toTitle: to.title, quote: p.quote.trim().slice(0, 300), status: "proposed", ts: now };
  all.push(link);
  writeLinks(vault, all);
  return { ok: true, link };
}

/** Accept a proposed link: the token goes onto the line (versioned for the Compass), with a ledger line. */
export function acceptLink(vault: string, id: string, now = Date.now()): { ok: boolean; why?: string } {
  const all = readLinks(vault);
  const l = all.find((x) => x.id === id);
  if (!l) return { ok: false, why: "no such proposal" };
  if (l.status !== "proposed") return { ok: false, why: `already ${l.status}` };
  const ok = l.kind === "goal-objective" ? linkGoal(vault, l.from, l.to, now, l.quote) : linkTask(vault, l, now);
  if (!ok) return { ok: false, why: "the line was not found" };
  l.status = "accepted";
  writeLinks(vault, all);
  return { ok: true };
}
export function declineLink(vault: string, id: string): boolean {
  const all = readLinks(vault);
  const l = all.find((x) => x.id === id && x.status === "proposed");
  if (!l) return false;
  l.status = "declined";
  writeLinks(vault, all);
  return true;
}

/** Link a goal (life or domain) to an objective by writing ~objective: on its line. */
export function linkGoal(vault: string, goal: string, objective: string, now = Date.now(), quote = ""): boolean {
  const doc = readCompass(vault);
  const g = findById(doc, goal).item;
  if (g && g.kind === "goal") {
    if (split(g.tokens.objective).includes(objective)) return true;
    g.tokens.objective = [...split(g.tokens.objective), objective].join(",");
    g.dirty = true;
    saveCompass(vault, doc, [{ id: goal, from: "not linked", to: `objective ${objective}`, reason: "linked to an objective", ...(quote ? { evidence: [quote] } : {}), by: "user" }], now);
    return true;
  }
  for (const d of listDomainDirs(vault)) {
    const f = join(resolveDomainDir(vault, d), "source", "goals.md");
    const t = readText(f);
    if (!t.includes(`~id:${goal}`)) continue;
    const next = t.split("\n").map((l) => (new RegExp(`~id:${goal}(\\s|$)`).test(l) && !l.includes(`~objective:`) ? `${l.replace(/\s+$/, "")} ~objective:${objective}` : l)).join("\n");
    if (next !== t) vwriteFile(f, next);
    appendLedger(vault, { ts: now, id: goal, from: "not linked", to: `objective ${objective}`, reason: `domain goal in ${d} linked to an objective`, ...(quote ? { evidence: [quote] } : {}), by: "user" });
    return true;
  }
  return false;
}

function appendLedger(vault: string, row: Record<string, unknown>): void {
  mkdirSync(compassMetaDir(vault), { recursive: true });
  const p = join(compassMetaDir(vault), "ledger.jsonl");
  writeFileSync(p, `${readText(p)}${JSON.stringify(row)}\n`);
}

/** Put ~initiative:<id> (or ~goal:<id>) at the end of one task line, found by its ~id: or its words. */
function linkTask(vault: string, l: LinkProposal, now: number): boolean {
  if (!l.file || !existsSync(l.file)) return false;
  const tok = l.kind === "task-initiative" ? "initiative" : "goal";
  const lines = readText(l.file).split("\n");
  let hit = false;
  const next = lines.map((line) => {
    if (hit || !/^\s*- \[ \]/.test(line) || new RegExp(`~${tok}:`).test(line)) return line;
    const id = /~id:(\S+)/.exec(line)?.[1];
    const words = line.replace(/^\s*- \[ \]\s+/, "").replace(/\s+[~@+]\S+/g, "").trim();
    const want = l.from.split(":").pop();
    if (!(id && id === want) && words !== l.fromTitle) return line;
    hit = true;
    return `${line.replace(/\s+$/, "")} ~${tok}:${l.to}`;
  });
  if (!hit) return false;
  vwriteFile(l.file, next.join("\n"));
  appendLedger(vault, { ts: now, id: l.from, from: "not linked", to: `${tok} ${l.to}`, reason: "task linked", evidence: [l.quote], by: "user" });
  return true;
}

// ── Code proposals: shared words, the user's own text as the quote ─────────

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "your", "you", "are", "was", "will", "into", "over", "more", "less", "than", "have", "has", "not", "but", "all", "one", "own", "its", "who", "what", "when", "get", "make", "new", "every", "each", "per", "year", "years", "month", "months", "week", "weeks", "first", "start", "keep", "able", "plan", "goal", "goals"]);
const stem = (w: string) => w.replace(/(ings|ing|ed)$/, "").replace(/(ies)$/, "y").replace(/s$/, "");
export const contentWords = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9$%]+/g, " ").split(" ").filter((w) => w.length >= 3 && !STOP.has(w)).map(stem));
const shared = (a: Set<string>, b: Set<string>) => [...a].filter((w) => b.has(w)).length;

/** Propose goal-to-objective and task-to-initiative links where the words overlap. The quote is the line's own text. */
export function proposeCodeLinks(vault: string, now = Date.now()): LinkProposal[] {
  const tree = compassTree(vault);
  const doc = readCompass(vault);
  const objectives = tree.nodes.filter((n) => n.level === "objective");
  const out: LinkProposal[] = [];
  if (objectives.length) {
    const cands: { id: string; title: string; words: string; domain?: string; parents: string[] }[] = [
      ...items(doc, "goal").filter((g) => LIVE_GOAL(g.tokens.status ?? "active")).map((g) => ({ id: g.id, title: g.title, words: `${g.title} ${field(g, "words") ?? ""} ${field(g, "why") ?? ""}`, ...(g.tokens.domain ? { domain: g.tokens.domain } : {}), parents: split(g.tokens.objective) })),
      ...domainGoals(vault).filter((g) => LIVE_GOAL(g.status)).map((g) => ({ id: g.id, title: g.title, words: g.title, domain: g.domain, parents: split(g.objective) })),
    ];
    for (const g of cands) {
      if (g.parents.length) continue;
      const gw = contentWords(g.words);
      const best = objectives.map((o) => ({ o, n: shared(gw, contentWords(o.title)) })).filter((x) => x.n >= 2 || (x.n >= 1 && !!g.domain && x.o.domain === g.domain)).sort((a, b) => b.n - a.n)[0];
      if (!best) continue;
      const r = proposeLink(vault, { kind: "goal-objective", from: g.id, to: best.o.id, quote: g.title, source: g.domain ? `${g.domain} goals` : "Compass", by: "code", ...(g.domain ? { domain: g.domain } : {}) }, now, tree);
      if (r.ok) out.push(r.link);
    }
  }
  const inits = tree.nodes.filter((n) => n.level === "initiative" && (n.status === "chosen" || n.status === "trial"));
  if (inits.length) {
    // Each open task goes to at most one initiative: the one whose title it
    // shares the most of (at least two words and more than half the title), in the same
    // domain or a mission's board. A task filed by another initiative never.
    const words = new Map(inits.map((i) => [i.id, contentWords(i.title)]));
    const per = new Map<string, number>();
    for (const t of openTasks(vault).filter((x) => !x.initiative && !x.goal)) {
      const tw = contentWords(t.text);
      const best = inits
        .filter((i) => !i.domain || t.owner === i.domain || t.owner.startsWith("mission/"))
        .map((i) => { const n = shared(tw, words.get(i.id)!); return { i, n, r: n / Math.max(1, words.get(i.id)!.size) }; })
        .filter((x) => x.n >= 2 && x.r > 0.5)
        .sort((a, b) => b.r - a.r || b.n - a.n)[0];
      if (!best || (per.get(best.i.id) ?? 0) >= 5) continue;
      const src = /~src:path:(\S+)/.exec(readText(t.file).split("\n").find((l) => t.id && l.includes(`~id:${t.id}`)) ?? "")?.[1];
      if (src && src !== best.i.id) continue;
      const r = proposeLink(vault, { kind: "task-initiative", from: `task:${t.owner}:${t.id ?? ""}`, fromTitle: t.text, to: best.i.id, quote: t.text, source: `${t.owner} tasks`, by: "code", domain: t.owner, file: t.file }, now, tree);
      if (r.ok) { out.push(r.link); per.set(best.i.id, (per.get(best.i.id) ?? 0) + 1); }
    }
  }
  return out;
}

// ── Bootstrap: mission statement, vision and objectives, quoted ─────────────

export interface ChainDraft {
  statements?: { title: string; quote: string; serves?: string[] }[];
  visions?: { title: string; quote: string; statement?: string }[];
  objectives?: { title: string; quote: string; metric?: string; target?: string; due?: string; vision?: string }[];
  links?: { goal: string; objective: string; quote: string }[];
}

/** What the chain is drafted from: the Compass bootstrap's notes, plus each domain's ideal state and Omega, capped. */
export function chainSources(vault: string): Source[] {
  const out = bootstrapSources(vault);
  const add = (p: string, label: string, cap: number) => { const t = readText(p).trim(); if (t) out.push({ path: label, text: t.slice(0, cap) }); };
  add(join(buildRoot(vault), "omega.md"), "build/omega.md", 3000);
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_") || d === "general") continue;
    add(join(resolveDomainDir(vault, d), "ideal-state.md"), `data/domains/${d}/ideal-state.md`, 1200);
  }
  return out;
}

export function chainPrompt(sources: Source[], ctx: { values: { id: string; title: string }[]; goals: { id: string; title: string }[]; metrics: string[] }): string {
  return [
    "You are drafting three levels of a person's Compass from their own notes. You never invent: every line carries a QUOTE copied word for word from the notes below, and its title reuses words from that quote. Skip a level rather than invent it.",
    "Levels: a MISSION STATEMENT says what they do, for whom, and the contribution they make (one; a second only if the notes clearly hold two). A VISION says what they aspire to become or create in the long term (one; a second only if clearly separate). OBJECTIVES are the few measurable outcomes that would show the vision is happening (3 to 6), best from dated, measured lines in the notes (money targets, counts, dates). Each vision names the statement it grows from and each objective the vision it shows, by the titles you wrote.",
    `Their values (ids): ${ctx.values.map((v) => `${v.id} = ${v.title}`).join("; ") || "none yet"}.`,
    `Their goals (ids): ${ctx.goals.map((g) => `${g.id} = ${g.title}`).join("; ") || "none yet"}.`,
    `Metric ids you may name for an objective (only these): ${ctx.metrics.slice(0, 60).join(", ") || "none"}.`,
    "Return JSON only:",
    '{ "statements": [{ "title": "<from the quote>", "quote": "<exact words>", "serves": ["<value ids>"] }],',
    '  "visions": [{ "title": "<from the quote>", "quote": "<exact words>", "statement": "<the statement title it grows from>" }],',
    '  "objectives": [{ "title": "<measurable, from the quote>", "quote": "<exact words>", "vision": "<the vision title it shows>", "metric": "<metric id or omit>", "target": "<number or omit>", "due": "YYYY-MM-DD or omit" }],',
    '  "links": [{ "goal": "<goal id>", "objective": "<objective title as you wrote it>", "quote": "<exact words from the notes that tie them>" }] }',
    "",
    ...sources.map((s) => `=== ${s.path} ===\n${s.text}`),
  ].join("\n");
}

function parseJson<T>(raw: string): T | null {
  const a = raw.indexOf("{"); const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(raw.slice(a, b + 1)) as T; } catch { return null; }
}

export interface ChainBootstrapResult { added: { kind: Kind; id: string; title: string; from: string }[]; rejected: { kind: string; title: string; why: string }[]; links: LinkProposal[]; method: "model" | "code" }

/**
 * Add a chain draft as proposed lines (the ownership rule as for the Compass
 * bootstrap: the quote must be in the notes and the title in the user's words),
 * and propose the goal-to-objective links it names (each with its quote).
 */
export function applyChainDraft(vault: string, draft: ChainDraft, sources: Source[], method: ChainBootstrapResult["method"], o: { metrics?: string[]; now?: number } = {}): ChainBootstrapResult {
  const now = o.now ?? Date.now();
  const doc = readCompass(vault);
  const res: ChainBootstrapResult = { added: [], rejected: [], links: [], method };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const have = new Set(items(doc).map((i) => `${i.kind}:${norm(i.title)}`));
  const valueIds = new Set(items(doc, "value").map((v) => v.id));
  const metricOk = new Set(o.metrics ?? []);
  const put = (kind: Kind, title: string, quote: string, tokens: Record<string, string>): CompassItem | null => {
    if (!title?.trim() || !quote?.trim()) { res.rejected.push({ kind, title: title ?? "", why: "no quote" }); return null; }
    const src = quoteSource(quote, sources);
    if (!src) { res.rejected.push({ kind, title, why: "quote not found in the user's notes" }); return null; }
    if (!titleFromUserWords(title, sources)) { res.rejected.push({ kind, title, why: "title uses words the user never wrote" }); return null; }
    if (have.has(`${kind}:${norm(title)}`)) return null;
    have.add(`${kind}:${norm(title)}`);
    const it: CompassItem = { kind, id: compassId(kind, title), title: title.replace(/\s*\u2014\s*/g, ", ").replace(/\s+\u2013\s+/g, ", ").replace(/\s+/g, " ").trim(), done: null, tokens: { ...tokens, status: "proposed" }, flags: [], fields: [{ key: "words", value: JSON.stringify(quote.replace(/\s+/g, " ").trim()) }, { key: "from", value: src.path }], paths: [], raw: [] };
    addItem(doc, it);
    res.added.push({ kind, id: it.id, title: it.title, from: src.path });
    return it;
  };
  for (const s of (draft.statements ?? []).slice(0, 2)) put("statement", s.title, s.quote, (s.serves ?? []).filter((v) => valueIds.has(v)).length ? { serves: (s.serves ?? []).filter((v) => valueIds.has(v)).join(",") } : {});
  // A drafted line may name the line above it by title; with only one above, that one. The line is proposed, so the user confirms the link with it.
  const pick = (list: CompassItem[], title?: string) => list.find((x) => title && norm(x.title) === norm(title)) ?? (list.length === 1 ? list[0] : undefined);
  const allStatements = () => items(doc, "statement");
  const vis = (draft.visions ?? []).slice(0, 2).map((v) => { const up = pick(allStatements(), v.statement); return put("vision", v.title, v.quote, up ? { statement: up.id } : {}); }).filter(Boolean) as CompassItem[];
  const objByTitle = new Map<string, string>();
  for (const ob of items(doc, "objective")) objByTitle.set(norm(ob.title), ob.id);
  for (const ob of (draft.objectives ?? []).slice(0, 6)) {
    const up = pick(items(doc, "vision"), ob.vision);
    const it = put("objective", ob.title, ob.quote, {
      ...(up ? { vision: up.id } : {}),
      ...(ob.metric && metricOk.has(ob.metric) ? { metric: ob.metric } : {}),
      ...(ob.target && /^[0-9.$%kKmM,]+$/.test(ob.target) ? { target: ob.target.replace(/,/g, "") } : {}),
      ...(ob.due && /^\d{4}-\d{2}-\d{2}$/.test(ob.due) ? { due: ob.due } : {}),
    });
    if (it) objByTitle.set(norm(it.title), it.id);
  }
  if (res.added.length) saveCompass(vault, doc, res.added.map((a) => ({ id: a.id, from: "none", to: "proposed", reason: `chain bootstrap (${method})`, evidence: [a.from], by: "bootstrap" as const })), now);
  for (const l of draft.links ?? []) {
    const to = objByTitle.get(norm(l.objective ?? ""));
    if (!to) { res.rejected.push({ kind: "link", title: `${l.goal} to ${l.objective}`, why: "no such objective" }); continue; }
    const src = l.quote ? quoteSource(l.quote, sources) : null;
    if (!src) { res.rejected.push({ kind: "link", title: `${l.goal} to ${l.objective}`, why: "quote not found in the user's notes" }); continue; }
    const r = proposeLink(vault, { kind: "goal-objective", from: l.goal, to, quote: l.quote, source: src.path, by: "bootstrap" }, now);
    if (r.ok) res.links.push(r.link); else res.rejected.push({ kind: "link", title: `${l.goal} to ${l.objective}`, why: r.why });
  }
  return res;
}

export async function bootstrapChain(vault: string, run?: (prompt: string) => Promise<string>, now = Date.now()): Promise<ChainBootstrapResult> {
  const sources = chainSources(vault);
  const doc = readCompass(vault);
  let metrics: string[] = [];
  try { metrics = (await import("./metrics.ts")).allDefs(vault).map((d) => d.id); } catch { /* none */ }
  try { metrics.push(...(await import("./compass-align.ts")).STATE_VARS.map((v) => v.id)); } catch { /* none */ }
  let draft: ChainDraft | null = null;
  if (run && sources.length) {
    try {
      draft = parseJson<ChainDraft>(await run(chainPrompt(sources, {
        values: items(doc, "value").map((v) => ({ id: v.id, title: v.title })),
        goals: items(doc, "goal").map((g) => ({ id: g.id, title: g.title })),
        metrics,
      })));
    } catch { draft = null; }
  }
  const r = applyChainDraft(vault, draft ?? {}, sources, draft ? "model" : "code", { metrics, now });
  r.links.push(...proposeCodeLinks(vault, now));
  return r;
}

// ── For the conversation: a goal said in it may tie to an objective said in it ─

export function proposeFromConversation(vault: string, goal: string, objective: string, quote: string, now = Date.now()) {
  return proposeLink(vault, { kind: "goal-objective", from: goal, to: objective, quote, source: "Compass conversation", by: "conversation" }, now);
}

// ── CLI: prevail compass tree|links|link ────────────────────────────────────

export async function chainCommand(sub: string, argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  if (sub === "tree") {
    const t = compassTree(vault, { confirmedOnly: args.has("confirmed") });
    if (args.json) { out(t); return 0; }
    const byId = new Map(t.nodes.map((n) => [n.id, n]));
    const print = (n: ChainNode, depth: number, seen: Set<string>) => {
      if (seen.has(n.id) || depth > 9) return;
      seen.add(n.id);
      console.log(`${"  ".repeat(depth)}${n.title}${n.status === "proposed" ? " (proposed)" : ""}`);
      for (const c of n.children) { const x = byId.get(c); if (x) print(x, depth + 1, seen); }
    };
    const seen = new Set<string>();
    for (const n of t.nodes.filter((x) => !x.parents.length)) print(n, 0, seen);
    console.log("");
    for (const l of t.levels) if (l.notLinked) console.log(`${l.label}: ${l.notLinked} not linked`);
    return 0;
  }
  if (sub === "links") {
    if (args.has("propose")) { const r = proposeCodeLinks(vault); if (args.json) out(r); else console.log(`Proposed ${r.length}.`); return 0; }
    const ls = readLinks(vault).filter((l) => args.has("all") || l.status === "proposed");
    if (args.json) out(ls); else for (const l of ls) console.log(`${l.id}  ${l.fromTitle} > ${l.toTitle}  "${l.quote}" (${l.by}, ${l.status})`);
    return 0;
  }
  if (sub === "link") {
    const act = args.pos[1] ?? "";
    if (act === "accept" || act === "decline") {
      const id = args.pos[2] ?? "";
      const r = act === "accept" ? acceptLink(vault, id) : { ok: declineLink(vault, id) };
      if (args.json) out(r); else console.log(r.ok ? (act === "accept" ? "Linked." : "Turned down.") : `Not done: ${(r as { why?: string }).why ?? "no such proposal"}`);
      return r.ok ? 0 : 1;
    }
    // prevail compass link <goal-id> <objective-id>: the user links it directly.
    const [from, to] = [args.pos[1] ?? "", args.pos[2] ?? ""];
    const tree = compassTree(vault);
    const target = tree.nodes.find((n) => n.id === to);
    if (!from || !target || target.level !== "objective") { const msg = "usage: prevail compass link <goal-id> <objective-id> | link accept|decline <proposal-id>"; if (args.json) out({ ok: false, error: msg }); else console.error(msg); return 1; }
    const ok = linkGoal(vault, from, to, Date.now(), args.get("quote") ?? "");
    if (args.json) out({ ok }); else console.log(ok ? "Linked." : "No such goal.");
    return ok ? 0 : 1;
  }
  console.error("usage: prevail compass tree [--confirmed] | links [--propose|--all] | link <goal> <objective> | link accept|decline <id> [--json]");
  return 1;
}

