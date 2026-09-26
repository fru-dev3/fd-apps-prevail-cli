// Intent (module name mirror.ts): what a person's own prompts say about them. The same corpus the
// Projects feature groups by project (prompt-corpus.ts, prompt-projects.ts),
// read back as a few plain findings, one intent line per week and a short
// weekly letter.
//
// Everything here reads the vault. The only writes are:
//   build/_meta/mirror/*            findings, verdicts, model caches, letters
//   build/ideal-state.md            a standing rule the person confirmed
//   build/_meta/projects.json       a project the person let go (status done)
//
// Findings (validated on real data; aggregate logic only):
//   goals_drift     domains with an ideal state that never came up in prompts
//   tooling_share   last 7 days of sittings: building tools vs building things
//   repeated_rules  instructions restated across separate sessions and days
//   open_loops      projects that burst for a week and went quiet
//   late_night      correction rate late at night vs daytime
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sanitizeEmDashes } from "./cli-bridge.ts";
import { runtimePath } from "./path-safety.ts";
import type { PromptRec } from "./prompt-corpus.ts";
import {
  assignedPrompts, displayLine, parseJsonAnswer, periodOf, readProjectsIndex, runModelOnce, SYNTH_DEFAULTS,
  type ModelChoice, type ModelRunner, type ProjectDef, type ProjectsIndex,
} from "./prompt-projects.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { newSittings, refreshEntities, tagSittings, TAG_DEFAULT } from "./entities.ts";

// ---------------------------------------------------------------------------
// contract types

export type FindingKind = "goals_drift" | "tooling_share" | "repeated_rules" | "open_loops" | "late_night";
export type FindingAction = "rule" | "replay" | "resume" | "let_go" | "none";
export type FindingStatus = "new" | "true" | "not_really" | "later";

export interface Receipt { ts: number; tool: string; project: string; project_title: string; text: string }

export interface FindingItem {
  id: string;
  label: string;
  count?: number;
  project?: string;
  rule_text?: string;
  domain?: string;
  detail?: string; // optional extra line (a silent domain's ideal state)
  status?: FindingStatus;
  snoozed_until?: number;
}

export interface Finding {
  id: string;
  kind: FindingKind;
  headline: string;
  detail: string;
  metric: { value: number; unit: string };
  visual: { type: "dots" | "bar" | "split" | "list"; data: unknown };
  receipts: Receipt[];
  items: FindingItem[];
  actions: FindingAction[];
  cadence: "weekly" | "quarterly";
  status: FindingStatus;
  snoozed_until?: number;
}

export interface Letter { week: string; title: string; markdown: string }

export interface FindingsDoc { generated_ts: number; letter: Letter | null; findings: Finding[] }

export interface Sitting {
  id: string;
  tool: string;
  session: string;
  project: string;
  project_title: string;
  start_ts: number;
  end_ts: number;
  // `exact` is the captured text when it differs from `text` only by the
  // surrounding whitespace the corpus trims; History shows it as typed.
  prompts: { ts: number; text: string; exact?: string }[];
}

export interface HistoryWeek {
  week: string;
  label: string;
  intent_line: string | null;
  sittings: Omit<Sitting, "session">[];
}

export interface HistoryDoc { total: number; tools: string[]; weeks: HistoryWeek[] }

// ---------------------------------------------------------------------------
// storage

interface VerdictRec { status: FindingStatus; ts: number; snoozed_until?: number; action?: string }
interface Verdicts { findings: Record<string, VerdictRec>; items: Record<string, VerdictRec> }
interface WeekLine { line: string; hash: string; model: string; ts: number }
// clusters: item id -> the candidate clusters (by index) the rule came from,
// so a period can tell which rules were restated inside it.
interface RulesCache { hash: string; model: string; items: FindingItem[]; receipts: Receipt[]; clusters?: Record<string, number[]> }
interface KindsCache { version?: number; model: string; kinds: Record<string, "tooling" | "outcome"> }
const KINDS_VERSION = 2; // bump when the classification prompt changes

const DAY = 864e5;
const WEEK = 7 * DAY;

const mpath = (vault: string, name: string) => runtimePath(vault, join("_meta", "mirror", name));

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(vreadFile(path)) as T; } catch { return fallback; }
}

function writeJson(path: string, v: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  vwriteFile(path, `${JSON.stringify(v, null, 2)}\n`);
}

export function readVerdicts(vault: string): Verdicts {
  const v = readJson<Partial<Verdicts>>(mpath(vault, "verdicts.json"), {});
  return { findings: v.findings ?? {}, items: v.items ?? {} };
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const itemKey = (findingId: string, itemId: string) => `${findingId}::${itemId}`;

// ---------------------------------------------------------------------------
// sittings: one tool session, split where the person stepped away for 3h+

const GAP = 3 * 3600e3;

export function weekOf(ts: number, tz: number): string { return periodOf(ts, "week", tz).key.slice(0, 10) }

function sessionKey(p: PromptRec): string {
  return p.session && p.session !== "unknown" ? `${p.tool}:${p.session}` : `${p.tool}:${new Date(p.ts).toISOString().slice(0, 10)}`;
}

// What the person typed, exactly. The corpus trims the capture and peels a
// desktop chat's context wrapper; only the trim is undone here, since the
// wrapper was never typed.
export function exactOf(p: PromptRec): string {
  return p.raw !== undefined && p.raw.trim() === p.text ? p.raw : p.text;
}

export function buildSittings(prompts: PromptRec[], slugOf: (p: PromptRec) => string, titleOf: (slug: string) => string): Sitting[] {
  const bySession = new Map<string, PromptRec[]>();
  for (const p of prompts) {
    const k = sessionKey(p);
    (bySession.get(k) ?? bySession.set(k, []).get(k)!).push(p);
  }
  const out: Sitting[] = [];
  for (const [key, ps] of bySession) {
    ps.sort((a, b) => a.ts - b.ts);
    let cur: PromptRec[] = [];
    const flush = () => {
      if (!cur.length) return;
      const votes = new Map<string, number>();
      for (const p of cur) { const s = slugOf(p); votes.set(s, (votes.get(s) ?? 0) + 1); }
      const ranked = [...votes.entries()].sort((a, b) => (b[0] ? 1 : 0) - (a[0] ? 1 : 0) || b[1] - a[1]);
      const slug = ranked[0]?.[0] ?? "";
      out.push({
        id: hash(`${key}@${cur[0].ts}`), tool: cur[0].tool, session: key, project: slug, project_title: slug ? titleOf(slug) : "Other",
        start_ts: cur[0].ts, end_ts: cur[cur.length - 1].ts, prompts: cur.map((p) => ({ ts: p.ts, text: p.text, ...(exactOf(p) !== p.text ? { exact: exactOf(p) } : {}) })),
      });
      cur = [];
    };
    for (const p of ps) {
      if (cur.length && p.ts - cur[cur.length - 1].ts > GAP) flush();
      cur.push(p);
    }
    flush();
  }
  return out.sort((a, b) => a.start_ts - b.start_ts);
}

// ---------------------------------------------------------------------------
// shared context

export interface MirrorContext {
  vault: string;
  now: number;
  tz: number; // Date.getTimezoneOffset() of the viewer
  prompts: PromptRec[];
  slugOf: (p: PromptRec) => string;
  catalog: ProjectDef[];
  index: ProjectsIndex | null;
  sittings: Sitting[];
  titleOf: (slug: string) => string;
  domainOf: (slug: string) => string;
}

export function loadContext(vault: string, opts: { now?: number; tz?: number; home?: string } = {}): MirrorContext {
  const { prompts, slugOf, catalog } = assignedPrompts(vault, opts.home);
  const index = readProjectsIndex(vault);
  const titles = new Map<string, string>();
  const domains = new Map<string, string>();
  for (const c of catalog) { titles.set(c.slug, c.title); domains.set(c.slug, c.domain); }
  for (const p of index?.projects ?? []) { titles.set(p.slug, p.title); domains.set(p.slug, p.domain); }
  const titleOf = (s: string) => titles.get(s) ?? s;
  const domainOf = (s: string) => domains.get(s) ?? "";
  return {
    vault, now: opts.now ?? Date.now(), tz: opts.tz ?? new Date().getTimezoneOffset(),
    prompts, slugOf, catalog, index, sittings: buildSittings(prompts, slugOf, titleOf), titleOf, domainOf,
  };
}

function receipt(ctx: MirrorContext, s: { tool: string; project: string }, p: { ts: number; text: string }): Receipt {
  return { ts: p.ts, tool: s.tool, project: s.project, project_title: s.project ? ctx.titleOf(s.project) : "Other", text: displayLine(p.text, 240) };
}

// A span of time findings are scoped to. Without one, "this week" means the
// last seven days, as it always has.
export interface Window { start: number; end: number; word: string }
const inWin = (ts: number, w: Window) => ts >= w.start && ts < w.end;
const lastWeek = (ctx: MirrorContext): Window => ({ start: ctx.now - WEEK, end: ctx.now + 1, word: "this week" });

const localHour = (ts: number, tz: number) => new Date(ts - tz * 60_000).getUTCHours();
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// 1. goals_drift

function domainsRoot(vault: string): string {
  const v4 = join(vault, "data", "domains");
  return existsSync(v4) ? v4 : vault;
}

// The first line of prose; a heading only when there is nothing else.
function idealFirstLine(text: string): string {
  let heading = "";
  for (const raw of text.split("\n")) {
    const isHeading = /^\s*#/.test(raw);
    const l = raw.replace(/^[#>\s*_-]+/, "").replace(/[*_`]+/g, "").trim();
    if (!l || /^<!--/.test(l)) continue;
    if (!isHeading) return displayLine(l, 160);
    heading ||= l;
  }
  return displayLine(heading, 160);
}

export function goalsDrift(ctx: MirrorContext, win?: Window): Finding | null {
  const root = domainsRoot(ctx.vault);
  let names: string[] = [];
  try { names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_")).map((d) => d.name); } catch { return null; }
  const withIdeal = names.filter((d) => existsSync(join(root, d, "ideal-state.md"))).sort();
  const prompts = win ? ctx.prompts.filter((p) => inWin(p.ts, win)) : ctx.prompts;
  if (!withIdeal.length || !prompts.length) return null;
  const counts = new Map<string, number>();
  for (const p of prompts) {
    const slug = ctx.slugOf(p);
    const d = (slug ? ctx.domainOf(slug) : "") || p.domain;
    if (d) counts.set(d.toLowerCase(), (counts.get(d.toLowerCase()) ?? 0) + 1);
  }
  const silent = withIdeal.filter((d) => !counts.get(d.toLowerCase()));
  if (!silent.length) return null;
  const first = prompts[0].ts;
  const months = Math.max(1, Math.round((ctx.now - first) / (30.44 * DAY)));
  const total = prompts.length;
  return {
    id: "goals_drift", kind: "goals_drift",
    headline: win
      ? `${silent.length} of ${withIdeal.length} parts of your life did not come up ${win.word}`
      : `${silent.length} of ${withIdeal.length} parts of your life never came up in ${plural(months, "month")}`,
    detail: win
      ? `You wrote an ideal state for ${plural(withIdeal.length, "area")}; ${silent.length} of them had no prompts ${win.word}.`
      : `You wrote an ideal state for ${plural(withIdeal.length, "area")}; ${silent.length} of them never came up in your prompts since ${new Date(first).toISOString().slice(0, 10)}.`,
    metric: { value: silent.length, unit: "domains" },
    visual: {
      type: "dots",
      data: withIdeal.map((d) => ({ domain: d, prompts: counts.get(d.toLowerCase()) ?? 0, share: pct(counts.get(d.toLowerCase()) ?? 0, total) })),
    },
    receipts: [],
    items: silent.map((d) => {
      let line = "";
      try { line = idealFirstLine(vreadFile(join(root, d, "ideal-state.md"))); } catch { /* */ }
      return { id: d, label: d, domain: d, count: 0, ...(line ? { detail: line } : {}) };
    }),
    actions: ["none"], cadence: win ? "weekly" : "quarterly", status: "new",
  };
}

// ---------------------------------------------------------------------------
// 2. tooling_share

export function buildKindsPrompt(projects: { slug: string; title: string; kind: string; summary: string }[]): string {
  return `Classify each project one person worked on with AI tools as either:
- "tooling": the project's purpose is tools, agents or config: AI harnesses and agents, agent orchestration, CLIs and dev tooling, dev environment and machine setup, prompt and model configuration, automation plumbing, dashboards about their own workflow. This holds even when the tool is published or sold.
- "outcome": the project's purpose is the end result itself: a website with content, a consumer product that is not about AI tooling, a video or channel, property, money, health, travel, a purchase, a claim, a job search, a life decision.

Return ONLY a JSON object mapping slug to "tooling" or "outcome". No prose.

${projects.map((p) => `- ${p.slug}: ${p.title} (${p.kind}). ${p.summary}`).join("\n")}
`;
}

async function projectKinds(ctx: MirrorContext, slugs: string[], m: ModelOpts): Promise<Record<string, "tooling" | "outcome">> {
  const path = mpath(ctx.vault, "project_kinds.json");
  let cache = readJson<KindsCache>(path, { version: KINDS_VERSION, model: "", kinds: {} });
  if (cache.version !== KINDS_VERSION) cache = { version: KINDS_VERSION, model: "", kinds: {} };
  const missing = slugs.filter((s) => s && !(s in cache.kinds));
  if (missing.length && m.run) {
    const info = missing.map((slug) => {
      const e = ctx.index?.projects.find((p) => p.slug === slug);
      const c = ctx.catalog.find((p) => p.slug === slug);
      return { slug, title: ctx.titleOf(slug), kind: e?.kind ?? c?.kind ?? "other", summary: e?.summary ?? c?.summary ?? "" };
    });
    try {
      const ans = parseJsonAnswer<Record<string, string>>(await m.run(buildKindsPrompt(info), m.model));
      for (const s of missing) if (ans[s] === "tooling" || ans[s] === "outcome") cache.kinds[s] = ans[s] as "tooling" | "outcome";
      cache.model = m.model.model;
      writeJson(path, cache);
    } catch (e) { m.log(`project kinds failed (${(e as Error).message}); retry next refresh`); }
  }
  return cache.kinds;
}

export async function toolingShare(ctx: MirrorContext, m: ModelOpts, win: Window = lastWeek(ctx)): Promise<Finding | null> {
  const recent = ctx.sittings.filter((s) => inWin(s.start_ts, win) && s.project);
  if (recent.length < 3) return null;
  const kinds = await projectKinds(ctx, [...new Set(recent.map((s) => s.project))], m);
  const known = recent.filter((s) => kinds[s.project]);
  if (known.length < 3) return null;
  const tooling = known.filter((s) => kinds[s.project] === "tooling");
  const outcome = known.filter((s) => kinds[s.project] === "outcome");
  const share = pct(tooling.length, known.length);
  const tally = (ss: Sitting[]) => {
    const m2 = new Map<string, number>();
    for (const s of ss) m2.set(s.project, (m2.get(s.project) ?? 0) + 1);
    return [...m2.entries()].sort((a, b) => b[1] - a[1]).map(([slug, sittings]) => ({ slug, title: ctx.titleOf(slug), sittings }));
  };
  const tp = tally(tooling);
  const op = tally(outcome);
  const top = [...tooling].sort((a, b) => b.prompts.length - a.prompts.length).slice(0, 5);
  return {
    id: "tooling_share", kind: "tooling_share",
    headline: `${share}% of ${win.word === "this week" ? "this week's" : win.word === "that day" ? "that day's" : "that week's"} sittings went into tools and setup`,
    detail: `${plural(tooling.length, "sitting")} built tools, agents or config; ${plural(outcome.length, "sitting")} built things for their own sake.`,
    metric: { value: share, unit: "%" },
    visual: { type: "split", data: { tooling: tooling.length, outcome: outcome.length, tooling_projects: tp, outcome_projects: op } },
    receipts: top.map((s) => receipt(ctx, s, s.prompts[0])),
    items: [
      ...tp.map((p) => ({ id: p.slug, label: p.title, count: p.sittings, project: p.slug, detail: "tooling" })),
      ...op.map((p) => ({ id: p.slug, label: p.title, count: p.sittings, project: p.slug, detail: "outcome" })),
    ],
    actions: ["none"], cadence: "weekly", status: "new",
  };
}

// ---------------------------------------------------------------------------
// 3. repeated_rules

const STOP = new Set(("the and for you that this with are was were but not have has had its it's can could would will just also then than there their they them what when where which who how why into from your our out about all any some been being did does doing get got make made one only over same should very more most much such these those too use used using want need like here now well way yes okay ok please "
  + "a an i me my we us to of in on at by or is it be do so if as up no").split(" ").filter((w) => !["not", "no", "never", "always", "use", "make", "should"].includes(w)));

export function ruleTokens(text: string): Set<string> {
  const words = text.toLowerCase().replace(/https?:\/\/\S+/g, " ").match(/[a-z0-9#][a-z0-9#'.-]*[a-z0-9]|[a-z0-9]/g) ?? [];
  return new Set(words.filter((w) => w.length > 1 && !STOP.has(w)));
}

const DIRECTIVE = /\b(never|always|don'?t|do not|stop|must|make sure|remember|avoid|instead|no more|keep|should|shouldn'?t|every time|again)\b|^\s*(no|use|only)\b/i;

export interface RuleCluster { members: PromptRec[]; samples: string[]; sessions: number; days: number }

// A rule is usually one sentence inside a longer prompt ("...and no em
// dashes."), so candidates are directive sentences, not whole prompts.
export function directiveSentences(text: string): string[] {
  if (text.length > 6000) return [];
  return text
    .replace(/<\/?pasted_content[^>]*>/g, " ")
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter((x) => x.length >= 8 && x.length <= 300 && DIRECTIVE.test(x) && !/[\/~][\w.-]+\/[\w.-]+\//.test(x));
}

// Cheap candidate search: token-set overlap between directive sentences typed
// in different sessions on different days, joined into clusters.
export function findRepeatedCandidates(prompts: PromptRec[], opts: { minJaccard?: number; minShared?: number; maxClusters?: number } = {}): RuleCluster[] {
  const minJ = opts.minJaccard ?? 0.5;
  const minShared = opts.minShared ?? 3;
  const units: { p: PromptRec; text: string }[] = [];
  for (const p of prompts) for (const text of directiveSentences(p.text)) units.push({ p, text });
  const toks = units.map((u) => ruleTokens(u.text));
  const keep = toks.map((t) => t.size >= 2 && t.size <= 25);
  const df = new Map<string, number>();
  toks.forEach((t, i) => { if (keep[i]) for (const w of t) df.set(w, (df.get(w) ?? 0) + 1); });
  const maxDf = Math.max(40, Math.ceil(units.length * 0.04));
  const inv = new Map<string, number[]>();
  toks.forEach((t, i) => { if (keep[i]) for (const w of t) if ((df.get(w) ?? 0) <= maxDf) (inv.get(w) ?? inv.set(w, []).get(w)!).push(i); });
  const parent = units.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const dayOf = (p: PromptRec) => new Date(p.ts).toISOString().slice(0, 10);
  for (let i = 0; i < units.length; i++) {
    if (!keep[i]) continue;
    const shared = new Map<number, number>();
    for (const w of toks[i]) for (const j of inv.get(w) ?? []) if (j > i) shared.set(j, (shared.get(j) ?? 0) + 1);
    for (const [j, n] of shared) {
      // Short rules ("no em dashes") share few words; long ones must share more.
      const need = Math.min(toks[i].size, toks[j].size) <= 4 ? Math.min(2, minShared) : minShared;
      if (n < need) continue;
      if (n / (toks[i].size + toks[j].size - n) < minJ) continue;
      if (sessionKey(units[i].p) === sessionKey(units[j].p) || dayOf(units[i].p) === dayOf(units[j].p)) continue;
      parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  units.forEach((_, i) => { if (keep[i]) { const r = find(i); (groups.get(r) ?? groups.set(r, []).get(r)!).push(i); } });
  const out: RuleCluster[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const members = [...new Set(idxs.map((i) => units[i].p))].sort((a, b) => a.ts - b.ts);
    const sessions = new Set(members.map(sessionKey)).size;
    const days = new Set(members.map(dayOf)).size;
    if (sessions < 2 || days < 2) continue;
    const samples = [...new Set(idxs.map((i) => units[i].text))];
    out.push({ members, samples, sessions, days });
  }
  // One long prompt pasted into several sessions matches sentence by sentence;
  // those clusters share the same prompts and are one candidate.
  const bySet = new Map<string, RuleCluster>();
  for (const c of out) {
    const k = c.members.map((p) => `${p.ts}:${sessionKey(p)}`).join("|");
    const hit = bySet.get(k);
    if (hit) hit.samples = [...new Set([...hit.samples, ...c.samples])];
    else bySet.set(k, c);
  }
  return [...bySet.values()].sort((a, b) => b.sessions - a.sessions || b.days - a.days).slice(0, opts.maxClusters ?? 40);
}

export function buildRulesPrompt(groups: { label: string; sessions: number; samples: string[] }[]): string {
  return `Below are groups of messages one person typed to AI tools. Each group is the same thing said again in separate sessions on different days.

Find the RULES: standing instructions the person keeps having to restate (preferences, taste, constraints, "never do X", "always do Y"). For each rule:
- merge groups that express the same rule,
- write it as ONE short imperative line in plain words, in the person's voice ("Never use gold; the brand color is #008000."),
- list the group labels it came from.
Drop groups that are not a standing rule: status questions, "continue", one-off task requests, pasted errors.

Return ONLY a JSON array: [{"rule": "...", "groups": ["G1", "G4"]}], most repeated first. No prose, no em dashes.

${groups.map((g) => `### ${g.label} (${g.sessions} sessions)\n${g.samples.map((s) => `- ${s}`).join("\n")}`).join("\n\n")}
`;
}

export function normRule(s: string): string { return s.toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim() }

function ruleGroups(clusters: RuleCluster[]) {
  const groups = clusters.map((c, i) => ({
    label: `G${i + 1}`, sessions: c.sessions,
    samples: c.samples.map((x) => displayLine(x, 240)).slice(0, 4),
  }));
  return { groups, key: hash(JSON.stringify(groups)) };
}

function ruleReceipt(ctx: MirrorContext, c: RuleCluster, p = c.members[c.members.length - 1]): Receipt {
  const said = directiveSentences(p.text).find((x) => c.samples.includes(x));
  return receipt(ctx, { tool: p.tool, project: ctx.slugOf(p) }, { ts: p.ts, text: said ?? p.text });
}

function ruleProject(ctx: MirrorContext, cs: RuleCluster[]): string | undefined {
  const votes = new Map<string, number>();
  for (const c of cs) for (const p of c.members) { const s = ctx.slugOf(p); if (s) votes.set(s, (votes.get(s) ?? 0) + 1); }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

// No model: each cluster stands for itself, in its shortest wording.
function rawRuleItem(ctx: MirrorContext, c: RuleCluster): FindingItem {
  const text = displayLine([...c.samples].sort((a, b) => a.length - b.length)[0], 200);
  const project = ruleProject(ctx, [c]);
  return { id: hash(normRule(text)).slice(0, 12), label: text, rule_text: text, count: c.sessions, ...(project ? { project } : {}) };
}

export async function repeatedRules(ctx: MirrorContext, m: ModelOpts): Promise<Finding | null> {
  const clusters = findRepeatedCandidates(ctx.prompts);
  if (!clusters.length) return null;
  const { groups, key } = ruleGroups(clusters);
  const cachePath = mpath(ctx.vault, "rules_cache.json");
  const cache = readJson<RulesCache | null>(cachePath, null);
  const already = new Set(standingRules(ctx.vault).map(normRule));
  const recFor = (c: RuleCluster) => ruleReceipt(ctx, c);
  const projectOf = (cs: RuleCluster[]) => ruleProject(ctx, cs);
  let items: FindingItem[] = [];
  let receipts: Receipt[] = [];
  // A cache from before rules remembered their clusters is rebuilt once.
  if (cache && cache.hash === key && cache.model === m.model.model && cache.clusters) {
    ({ items, receipts } = cache);
  } else {
    let done = false;
    if (m.run) {
      try {
        const ans = parseJsonAnswer<{ rule?: string; groups?: string[] }[]>(await m.run(buildRulesPrompt(groups), m.model));
        const from: Record<string, number[]> = {};
        for (const r of Array.isArray(ans) ? ans : []) {
          const rule = sanitizeEmDashes((r.rule ?? "").trim());
          const ixs = (r.groups ?? []).map((g) => Number(String(g).replace(/\D/g, "")) - 1).filter((i) => clusters[i]);
          const cs = ixs.map((i) => clusters[i]);
          if (!rule || !cs.length) continue;
          const sessions = new Set(cs.flatMap((c) => c.members.map(sessionKey))).size;
          const project = projectOf(cs);
          const id = hash(normRule(rule)).slice(0, 12);
          items.push({ id, label: rule, rule_text: rule, count: sessions, ...(project ? { project } : {}) });
          from[id] = ixs;
          if (receipts.length < 5) receipts.push(recFor(cs[0]));
        }
        items.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
        writeJson(cachePath, { hash: key, model: m.model.model, items, receipts, clusters: from } satisfies RulesCache);
        done = true;
      } catch (e) { m.log(`repeated rules: model pass failed (${(e as Error).message}); showing raw repeats`); }
    }
    if (!done) {
      items = clusters.map((c) => rawRuleItem(ctx, c));
      receipts = clusters.slice(0, 5).map(recFor);
    }
  }
  items = items.filter((i) => !already.has(normRule(i.rule_text ?? i.label))).slice(0, 12);
  if (!items.length) return null;
  const top = items[0];
  return {
    id: "repeated_rules", kind: "repeated_rules",
    headline: `${plural(items.length, "instruction")} you keep restating across sessions`,
    detail: `The top one came up in ${plural(top.count ?? 0, "separate session")}: "${displayLine(top.rule_text ?? top.label, 120)}"`,
    metric: { value: items.length, unit: "rules" },
    visual: { type: "list", data: items.map((i) => ({ label: i.label, count: i.count ?? 0 })) },
    receipts: receipts.slice(0, 5),
    items,
    actions: ["rule"], cadence: "weekly", status: "new",
  };
}

// ---------------------------------------------------------------------------
// 4. open_loops

export function openLoops(ctx: MirrorContext, verdicts: Verdicts, win?: Window): Finding | null {
  const bySlug = new Map<string, PromptRec[]>();
  for (const p of ctx.prompts) { const s = ctx.slugOf(p); if (s) (bySlug.get(s) ?? bySlug.set(s, []).get(s)!).push(p); }
  const status = new Map((ctx.index?.projects ?? []).map((p) => [p.slug, p.status]));
  const loops: { slug: string; n: number; last: PromptRec }[] = [];
  for (const [slug, ps] of bySlug) {
    if (ps.length < 3 || status.get(slug) === "done") continue;
    const v = verdicts.items[itemKey("open_loops", slug)];
    if (v && (v.action === "let_go" || v.status === "not_really")) continue;
    const weeks = new Map<string, number>();
    for (const p of ps) { const w = weekOf(p.ts, ctx.tz); weeks.set(w, (weeks.get(w) ?? 0) + 1); }
    const peak = Math.max(...weeks.values());
    const last = ps[ps.length - 1];
    const burst = peak / ps.length >= 0.9 && ctx.now - last.ts >= 45 * DAY;
    if ((burst || status.get(slug) === "dormant") && (!win || inWin(last.ts, win))) loops.push({ slug, n: ps.length, last });
  }
  if (!loops.length) return null;
  loops.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  // Rotate: a different two or three each week, the same all week. A past
  // period shows every loop that went quiet inside it.
  const shown = win ? loops.length : Math.min(3, loops.length);
  const weekNo = Math.floor((ctx.now - ctx.tz * 60_000 + 3 * DAY) / WEEK);
  const start = win ? 0 : (weekNo * shown) % loops.length;
  const pick = Array.from({ length: shown }, (_, i) => loops[(start + i) % loops.length]);
  return {
    id: "open_loops", kind: "open_loops",
    headline: win
      ? `${plural(loops.length, "project")} went quiet after ${win.word}`
      : `${plural(loops.length, "project")} went quiet mid-stream; ${shown} to look at this week`,
    detail: win
      ? `Each had its last prompt ${win.word} and then nothing. Resume it, replay it with a newer model, or let it go.`
      : `Each had nearly all its prompts in one week, or was marked dormant, and then nothing. Resume it, replay it with a newer model, or let it go.`,
    metric: { value: loops.length, unit: "projects" },
    visual: { type: "list", data: pick.map((l) => ({ label: ctx.titleOf(l.slug), count: l.n, last_ts: l.last.ts })) },
    receipts: pick.map((l) => receipt(ctx, { tool: l.last.tool, project: l.slug }, l.last)),
    items: pick.map((l) => ({ id: l.slug, label: ctx.titleOf(l.slug), count: l.n, project: l.slug, domain: ctx.domainOf(l.slug) || undefined })),
    actions: ["resume", "let_go", "replay"], cadence: "weekly", status: "new",
  };
}

// ---------------------------------------------------------------------------
// 5. late_night

export const CORRECTION = /\b(again|still|didn'?t work|i already|not what|wrong)\b/i;

export function lateNight(ctx: MirrorContext, win: Window = lastWeek(ctx)): Finding | null {
  const recent = ctx.sittings.filter((s) => inWin(s.start_ts, win));
  const isLate = (ts: number) => { const h = localHour(ts, ctx.tz); return h >= 23 || h < 5; };
  const late = recent.filter((s) => isLate(s.start_ts));
  if (late.length < (win.word === "that day" ? 1 : 3)) return null;
  const lateP: { s: Sitting; p: { ts: number; text: string } }[] = [];
  const dayP: typeof lateP = [];
  for (const s of recent) for (const p of s.prompts) (isLate(p.ts) ? lateP : dayP).push({ s, p });
  if (!lateP.length || !dayP.length) return null;
  const lateHits = lateP.filter((x) => CORRECTION.test(x.p.text));
  const dayHits = dayP.filter((x) => CORRECTION.test(x.p.text));
  const lr = pct(lateHits.length, lateP.length);
  const dr = pct(dayHits.length, dayP.length);
  const ratio = dr ? Math.round((lr / dr) * 10) / 10 : 0;
  const headline = lr > dr && dr > 0 && ratio >= 1.2
    ? `Late-night prompts were corrections ${ratio}x as often as daytime ones`
    : lr > dr
      ? `${lr}% of late-night prompts were corrections, ${dr}% by day`
      : `Late nights ${win.word} read as calm as your days`;
  return {
    id: "late_night", kind: "late_night", headline,
    detail: `${plural(late.length, "sitting")} started between 23:00 and 05:00 ${win.word}; ${lr}% of those prompts said "again", "still" or "wrong", against ${dr}% during the day.`,
    metric: { value: lr, unit: "%" },
    visual: { type: "bar", data: [{ label: "23:00 to 05:00", value: lr, prompts: lateP.length }, { label: "Daytime", value: dr, prompts: dayP.length }] },
    receipts: lateHits.slice(-5).map((x) => receipt(ctx, x.s, x.p)),
    items: [],
    actions: ["none"], cadence: "weekly", status: "new",
  };
}

// ---------------------------------------------------------------------------
// weekly intent lines

export function buildWeeksPrompt(weeks: { week: string; label: string; projects: { title: string; sittings: number; samples: string[] }[] }[]): string {
  return `Below is what one person worked on with AI tools, week by week: the projects they had sittings on and a few of their prompts.

For EACH week write one plain sentence (at most 25 words) saying what they were really after that week, in the second person ("You mostly ..."). Name the project. Say the intent, not the activity count. No em dashes.

Return ONLY a JSON object mapping the week key to the sentence.

${weeks.map((w) => `### ${w.week} (${w.label})\n${w.projects.map((p) => `- ${p.title} (${p.sittings} sittings): ${p.samples.join(" | ")}`).join("\n")}`).join("\n\n")}
`;
}

function weekDigest(ctx: MirrorContext, ss: Sitting[]) {
  const byP = new Map<string, Sitting[]>();
  for (const s of ss) (byP.get(s.project) ?? byP.set(s.project, []).get(s.project)!).push(s);
  return [...byP.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6).map(([slug, xs]) => ({
    title: slug ? ctx.titleOf(slug) : "Other", sittings: xs.length,
    samples: [...new Set(xs.flatMap((s) => s.prompts.slice(0, 2)).map((p) => displayLine(p.text, 140)))].slice(0, 4),
  }));
}

function sittingsByWeek(ctx: MirrorContext): Map<string, Sitting[]> {
  const out = new Map<string, Sitting[]>();
  for (const s of ctx.sittings) { const w = weekOf(s.start_ts, ctx.tz); (out.get(w) ?? out.set(w, []).get(w)!).push(s); }
  return out;
}

export function readWeekLines(vault: string): Record<string, WeekLine> {
  return readJson<Record<string, WeekLine>>(mpath(vault, "weeks.json"), {});
}

async function refreshWeekLines(ctx: MirrorContext, m: ModelOpts): Promise<number> {
  if (!m.run) return 0;
  const lines = readWeekLines(ctx.vault);
  const current = weekOf(ctx.now, ctx.tz);
  const todo: { week: string; label: string; hash: string; projects: ReturnType<typeof weekDigest> }[] = [];
  for (const [week, ss] of sittingsByWeek(ctx)) {
    const projects = weekDigest(ctx, ss);
    const h = hash(JSON.stringify(projects));
    const have = lines[week];
    if (have && (week !== current || have.hash === h)) continue;
    todo.push({ week, label: periodOf(ss[0].start_ts, "week", ctx.tz).label, hash: h, projects });
  }
  let written = 0;
  for (let i = 0; i < todo.length; i += 12) {
    const batch = todo.slice(i, i + 12);
    try {
      const ans = parseJsonAnswer<Record<string, string>>(await m.run(buildWeeksPrompt(batch), m.model));
      for (const w of batch) {
        const line = typeof ans[w.week] === "string" ? sanitizeEmDashes(ans[w.week].trim()) : "";
        if (line) { lines[w.week] = { line, hash: w.hash, model: m.model.model, ts: ctx.now }; written++; }
      }
      writeJson(mpath(ctx.vault, "weeks.json"), lines);
    } catch (e) { m.log(`week lines: batch failed (${(e as Error).message}); retry next refresh`); }
  }
  return written;
}

// ---------------------------------------------------------------------------
// weekly letter: the last complete week

export function buildLetterPrompt(week: { label: string; projects: { title: string; sittings: number; samples: string[] }[] }, finding: Finding | null, loop: FindingItem | null): string {
  return `Write a short weekly letter to one person about their week with AI tools (${week.label}), from their own prompts. Markdown, 3 to 5 short paragraphs, second person, warm and plain, no headings, no lists, no em dashes, no advice they did not ask for.

Paragraph 1: what they mostly did and what they were after.
Then: one observation${finding ? ` (use this one: ${finding.headline}. ${finding.detail})` : ""}.
Then: one open loop${loop ? ` (${loop.label}, ${loop.count ?? 0} prompts, then quiet)` : " if any"}, as a gentle question.

Their week:
${week.projects.map((p) => `- ${p.title} (${p.sittings} sittings): ${p.samples.join(" | ")}`).join("\n")}
`;
}

function letterDir(vault: string) { return mpath(vault, "letters") }

export function readLetter(vault: string, week: string, label: string): Letter | null {
  try { return { week, title: `Your week, ${label}`, markdown: vreadFile(join(letterDir(vault), `${week}.md`)) }; } catch { return null; }
}

async function weeklyLetter(ctx: MirrorContext, m: ModelOpts, findings: Finding[], week = weekOf(ctx.now - WEEK, ctx.tz)): Promise<Letter | null> {
  const lastWeek = week;
  const ss = sittingsByWeek(ctx).get(lastWeek);
  if (!ss?.length) return null;
  const label = periodOf(ss[0].start_ts, "week", ctx.tz).label;
  const have = readLetter(ctx.vault, lastWeek, label);
  if (have) return have;
  const projects = weekDigest(ctx, ss);
  const finding = findings.find((f) => f.kind !== "open_loops") ?? null;
  const loop = findings.find((f) => f.kind === "open_loops")?.items[0] ?? null;
  let md = "";
  if (m.run) {
    try { md = sanitizeEmDashes((await m.run(buildLetterPrompt({ label, projects }, finding, loop), m.model)).trim().replace(/^```(?:markdown)?\n|\n```$/g, "")); } catch (e) { m.log(`letter failed (${(e as Error).message})`); }
  }
  if (!md) return null;
  mkdirSync(letterDir(ctx.vault), { recursive: true });
  vwriteFile(join(letterDir(ctx.vault), `${lastWeek}.md`), `${md}\n`);
  return { week: lastWeek, title: `Your week, ${label}`, markdown: `${md}\n` };
}

// ---------------------------------------------------------------------------
// refresh / findings

export interface ModelOpts { run: ModelRunner | null; model: ModelChoice; log: (m: string) => void }

export interface RefreshOptions {
  vault: string;
  model?: ModelChoice;
  run?: ModelRunner | null; // null = no model calls (deterministic fallbacks only)
  now?: number;
  tz?: number;
  home?: string;
  log?: (m: string) => void;
  // Entity tagging of new sittings (cheap model) and page digests (the synth
  // model). Defaults to the real runner only when `run` is the default too, so
  // a test that injects `run` never pays for entity calls by accident.
  entityRun?: ModelRunner | null;
  entityModel?: ModelChoice;
  entityLimit?: number;
}

export function modelChoice(model?: string | null, cli?: string | null): ModelChoice {
  const c = (cli === "codex" || (!cli && model && /^(gpt|o\d|codex)/i.test(model)) ? "codex" : "claude") as "claude" | "codex";
  return { cli: c, model: model || SYNTH_DEFAULTS[c] };
}

export async function refreshMirror(opts: RefreshOptions): Promise<FindingsDoc> {
  const m: ModelOpts = { run: opts.run === undefined ? runModelOnce : opts.run, model: opts.model ?? modelChoice(), log: opts.log ?? (() => {}) };
  const ctx = loadContext(opts.vault, { now: opts.now, tz: opts.tz, home: opts.home });
  const verdicts = readVerdicts(opts.vault);
  const all: (Finding | null)[] = [
    await repeatedRules(ctx, m),
    await toolingShare(ctx, m),
    openLoops(ctx, verdicts),
    lateNight(ctx),
    goalsDrift(ctx),
  ];
  const clean = sanitizeEmDashes;
  const findings = all.filter((f): f is Finding => !!f).map((f) => ({
    ...f, headline: clean(f.headline), detail: clean(f.detail),
    receipts: f.receipts.map((r) => ({ ...r, text: clean(r.text) })),
    items: f.items.map((i) => ({ ...i, label: clean(i.label), ...(i.detail ? { detail: clean(i.detail) } : {}), ...(i.rule_text ? { rule_text: clean(i.rule_text) } : {}) })),
  }));
  await refreshWeekLines(ctx, m);
  const letter = await weeklyLetter(ctx, m, applyVerdicts(findings, verdicts, ctx.now));
  await refreshEntityLayer(ctx, m, opts);
  const doc: FindingsDoc = { generated_ts: ctx.now, letter, findings };
  writeJson(mpath(opts.vault, "findings.json"), doc);
  return { ...doc, findings: applyVerdicts(findings, verdicts, ctx.now) };
}

// Entities ride the Intent refresh: tag each new sitting once, then rebuild
// the index, auto pages and any stale digests. Failures never block findings.
async function refreshEntityLayer(ctx: MirrorContext, m: ModelOpts, opts: RefreshOptions) {
  const run = opts.entityRun !== undefined ? opts.entityRun : (opts.run === undefined ? runModelOnce : null);
  try {
    if (run) {
      const fresh = newSittings(ctx.vault, ctx.sittings, ctx.now).slice(0, opts.entityLimit ?? 30);
      const t = await tagSittings(ctx.vault, fresh, { run, model: opts.entityModel ?? TAG_DEFAULT, domainOf: ctx.domainOf, log: m.log, now: ctx.now });
      if (t.tagged) m.log(`entities: tagged ${t.tagged} new sittings`);
    }
    const r = await refreshEntities(ctx.vault, { run, digestModel: m.model, digestLimit: 5, log: m.log, now: ctx.now });
    m.log(`entities: ${r.entities} known, ${r.pages_created} new pages, ${r.digests_written} digests`);
  } catch (e) { m.log(`entities: refresh failed (${(e as Error).message})`); }
}

// Verdicts shape what the person sees: "not really" hides a finding or item
// for good, "later" hides it until the snooze runs out, "true" keeps it with
// its status (and an item the person already acted on drops out).
// A period's finding ("late_night@2026-09-14w") takes its own whole-finding
// verdict; item verdicts given anywhere (a rule kept, a project let go) hold
// for every period.
export const baseId = (id: string) => id.split("@")[0];

export function applyVerdicts(findings: Finding[], v: Verdicts, now = Date.now()): Finding[] {
  const out: Finding[] = [];
  for (const f of findings) {
    const fv = v.findings[f.id];
    if (fv?.status === "not_really") continue;
    const items = f.items.flatMap((i): FindingItem[] => {
      const iv = v.items[itemKey(f.id, i.id)] ?? v.items[itemKey(baseId(f.id), i.id)];
      if (!iv) return [i];
      if (iv.status === "not_really" || iv.status === "true" || iv.action === "let_go") return [];
      if (iv.status === "later" && (iv.snoozed_until ?? 0) > now) return [];
      return [i];
    });
    if (f.items.length && !items.length) continue;
    const snoozed = fv?.status === "later" && (fv.snoozed_until ?? 0) > now;
    out.push({
      ...f, items,
      status: !fv || (fv.status === "later" && !snoozed) ? "new" : fv.status,
      ...(snoozed ? { snoozed_until: fv!.snoozed_until } : {}),
    });
  }
  return out;
}

export function readFindings(vault: string, now = Date.now()): FindingsDoc {
  const doc = readJson<FindingsDoc | null>(mpath(vault, "findings.json"), null);
  if (!doc) return { generated_ts: 0, letter: null, findings: [] };
  return { ...doc, findings: applyVerdicts(doc.findings ?? [], readVerdicts(vault), now) };
}

export function findingsText(doc: FindingsDoc): string {
  if (!doc.generated_ts) return "Nothing noticed yet. Run `prevail intent refresh`.";
  const lines = [`Intent, ${new Date(doc.generated_ts).toISOString().slice(0, 10)}`, ""];
  for (const f of doc.findings) {
    lines.push(`## ${f.headline}${f.status !== "new" ? ` [${f.status}]` : ""}`, f.detail);
    for (const i of f.items.slice(0, 8)) lines.push(`- ${i.rule_text ?? i.label}${i.count !== undefined ? ` (${i.count})` : ""}${i.detail && f.kind === "goals_drift" ? `: ${i.detail}` : ""}`);
    lines.push("");
  }
  if (doc.letter) lines.push(`## ${doc.letter.title}`, doc.letter.markdown.trim());
  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// verdicts

export function standingRules(vault: string): string[] {
  let text = "";
  try { text = vreadFile(runtimePath(vault, "ideal-state.md")); } catch { return []; }
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^##\s+Standing rules\s*$/i.test(l));
  if (at < 0) return [];
  const out: string[] = [];
  for (let i = at + 1; i < lines.length && !/^#{1,2}\s/.test(lines[i]); i++) {
    const mm = lines[i].match(/^\s*[-*]\s+(.*\S)/);
    if (mm) out.push(mm[1]);
  }
  return out;
}

// Appends one rule under "## Standing rules" in build/ideal-state.md. The rest
// of the file is left byte for byte as it was.
export function appendStandingRule(vault: string, rule: string): { path: string; added: boolean } {
  const path = runtimePath(vault, "ideal-state.md");
  const clean = sanitizeEmDashes(rule.replace(/\s+/g, " ").trim());
  if (!clean) throw new Error("empty rule");
  if (standingRules(vault).some((r) => normRule(r) === normRule(clean))) return { path, added: false };
  let text = "";
  try { text = vreadFile(path); } catch { /* new file */ }
  const lines = text.length ? text.split("\n") : [];
  const at = lines.findIndex((l) => /^##\s+Standing rules\s*$/i.test(l));
  if (at < 0) {
    const sep = !text.length ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    text = `${text}${sep}## Standing rules\n\n- ${clean}\n`;
  } else {
    let end = at + 1;
    while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
    let last = end - 1;
    while (last > at && !lines[last].trim()) last--;
    const insertAt = last === at ? at + 1 : last + 1;
    const add = last === at ? ["", `- ${clean}`] : [`- ${clean}`];
    lines.splice(insertAt, 0, ...add);
    text = lines.join("\n");
    if (!text.endsWith("\n")) text += "\n";
  }
  mkdirSync(join(path, ".."), { recursive: true });
  vwriteFile(path, text);
  return { path, added: true };
}

export type VerdictWord = "true" | "not_really" | "later" | "resume" | "let_go";

export interface VerdictResult { ok: boolean; finding_id: string; item_id?: string; status: FindingStatus; rule_path?: string; rule_added?: boolean; snoozed_until?: number; project_status?: string }

export function setVerdict(vault: string, findingId: string, verdict: VerdictWord, opts: { item?: string; rule?: string; action?: string; now?: number } = {}): VerdictResult {
  const now = opts.now ?? Date.now();
  const v = readVerdicts(vault);
  const action = verdict === "resume" || verdict === "let_go" ? verdict : opts.action;
  const status: FindingStatus = verdict === "resume" || verdict === "let_go" ? "true" : verdict;
  const rec: VerdictRec = { status, ts: now };
  if (status === "later") rec.snoozed_until = now + WEEK;
  if (action === "resume") { rec.status = "later"; rec.snoozed_until = now + 30 * DAY; }
  if (action) rec.action = action;
  const res: VerdictResult = { ok: true, finding_id: findingId, status: rec.status, ...(opts.item ? { item_id: opts.item } : {}), ...(rec.snoozed_until ? { snoozed_until: rec.snoozed_until } : {}) };

  if (action === "let_go") {
    const slug = opts.item;
    if (!slug) throw new Error("let_go needs --item <project slug>");
    const ip = runtimePath(vault, join("_meta", "projects.json"));
    const idx = readProjectsIndex(vault);
    const p = idx?.projects.find((x) => x.slug === slug);
    if (idx && p) { p.status = "done"; writeJson(ip, idx); res.project_status = "done"; }
  }

  if (status === "true" && (baseId(findingId) === "repeated_rules" || opts.rule)) {
    let rule = opts.rule ?? "";
    if (!rule && opts.item) {
      const doc = readJson<FindingsDoc | null>(mpath(vault, "findings.json"), null);
      const it = doc?.findings.find((f) => f.id === baseId(findingId))?.items.find((i) => i.id === opts.item);
      rule = it?.rule_text ?? it?.label ?? "";
    }
    if (rule) {
      const r = appendStandingRule(vault, rule);
      res.rule_path = r.path;
      res.rule_added = r.added;
    }
  }

  // An item verdict is about the thing itself, so it is kept under the kind.
  if (opts.item) v.items[itemKey(baseId(findingId), opts.item)] = rec;
  else v.findings[findingId] = rec;
  writeJson(mpath(vault, "verdicts.json"), v);
  return res;
}

// ---------------------------------------------------------------------------
// history: the raw play-by-play, newest week first

export interface HistoryOptions { q?: string; tool?: string; project?: string; before?: number; limit?: number; win?: { start: number; end: number } }

export function mirrorHistory(ctx: MirrorContext, o: HistoryOptions = {}): HistoryDoc {
  const q = o.q?.toLowerCase().trim();
  const tools = [...new Set(ctx.sittings.map((s) => s.tool))].sort();
  const match = ctx.sittings.filter((s) =>
    (!o.tool || s.tool === o.tool)
    && (!o.project || s.project === o.project)
    && (!o.before || s.start_ts < o.before)
    && (!o.win || (s.start_ts >= o.win.start && s.start_ts < o.win.end))
    && (!q || s.prompts.some((p) => p.text.toLowerCase().includes(q)) || s.project_title.toLowerCase().includes(q)));
  match.sort((a, b) => b.start_ts - a.start_ts);
  const page = match.slice(0, Math.max(1, o.limit ?? 200));
  const lines = readWeekLines(ctx.vault);
  const weeks = new Map<string, HistoryWeek>();
  for (const s of page) {
    const w = weekOf(s.start_ts, ctx.tz);
    const hw = weeks.get(w) ?? { week: w, label: periodOf(s.start_ts, "week", ctx.tz).label, intent_line: lines[w]?.line ?? null, sittings: [] };
    weeks.set(w, hw);
    const { session: _s, ...rest } = s;
    // Exactly as typed: never shortened, reflowed or rendered.
    hw.sittings.push({ ...rest, prompts: rest.prompts.map((p) => ({ ts: p.ts, text: p.exact ?? p.text })) });
  }
  return { total: match.length, tools, weeks: [...weeks.values()] };
}

// ---------------------------------------------------------------------------
// periods: weeks going back in time, each with its days. Intent's sidebar.
//
//   periodsList      every week with prompts, newest first, with its days
//   periodFindings   the findings for one week or day, cached per period in
//                    build/_meta/mirror/periods/<week|day>-<date>.json
//   generatePeriod   the model-written parts of a week (its letter, its line
//                    and one line per day), made the first time it is opened

export interface PeriodDay { day: string; label: string; prompts: number; sittings: number; intent_line: string | null }
export interface PeriodWeek {
  week: string; label: string; current: boolean; prompts: number; sittings: number;
  has_letter: boolean; intent_line: string | null; days: PeriodDay[];
}
export interface PeriodsDoc { generated_ts: number; weeks: PeriodWeek[] }

export interface PeriodProject { slug: string; title: string; domain: string; sittings: number; prompts: number; minutes: number }
export interface PeriodDoc {
  period: { kind: "week" | "day"; key: string; week: string; label: string };
  current: boolean;
  generated_ts: number;
  intent_line: string | null;
  letter: Letter | null;
  // ready: written; missing: the week ended and has none yet (generate makes
  // it); not_yet: the week is still going; none: not a week, or nothing typed
  letter_status: "ready" | "missing" | "not_yet" | "none";
  totals: { prompts: number; sittings: number };
  projects: PeriodProject[];
  findings: Finding[];
}

const PERIOD_VERSION = 1;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const dayOf = (ts: number, tz: number) => periodOf(ts, "day", tz).key;

// Local midnight of a YYYY-MM-DD in the viewer's zone, as epoch ms.
export function dayStart(key: string, tz: number): number {
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`expected a date like 2026-09-14, got "${key}"`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + tz * 60_000;
}

export function dayLabel(key: string): string {
  const d = new Date(`${key}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function weekLabel(week: string, tz: number): string { return periodOf(dayStart(week, tz) + 12 * 3600e3, "week", tz).label }

export function periodWindow(kind: "week" | "day", key: string, tz: number): { key: string; week: string; win: Window } {
  const start0 = dayStart(key, tz);
  if (kind === "day") return { key, week: weekOf(start0 + 12 * 3600e3, tz), win: { start: start0, end: start0 + DAY, word: "that day" } };
  const week = weekOf(start0 + 12 * 3600e3, tz); // any date lands on its Monday
  const start = dayStart(week, tz);
  return { key: week, week, win: { start, end: start + WEEK, word: "that week" } };
}

export function readDayLines(vault: string): Record<string, WeekLine> {
  return readJson<Record<string, WeekLine>>(mpath(vault, "days.json"), {});
}

export function periodsList(ctx: MirrorContext): PeriodsDoc {
  const lines = readWeekLines(ctx.vault);
  const dlines = readDayLines(ctx.vault);
  const current = weekOf(ctx.now, ctx.tz);
  const weeks = new Map<string, PeriodWeek>();
  const days = new Map<string, PeriodDay>();
  const weekFor = (w: string) => {
    let pw = weeks.get(w);
    if (!pw) {
      pw = { week: w, label: weekLabel(w, ctx.tz), current: w === current, prompts: 0, sittings: 0, has_letter: false, intent_line: lines[w]?.line ?? null, days: [] };
      weeks.set(w, pw);
    }
    return pw;
  };
  const dayFor = (d: string) => {
    let pd = days.get(d);
    if (!pd) { pd = { day: d, label: dayLabel(d), prompts: 0, sittings: 0, intent_line: dlines[d]?.line ?? null }; days.set(d, pd); }
    return pd;
  };
  for (const s of ctx.sittings) {
    weekFor(weekOf(s.start_ts, ctx.tz)).sittings++;
    dayFor(dayOf(s.start_ts, ctx.tz)).sittings++;
  }
  for (const p of ctx.prompts) {
    weekFor(weekOf(p.ts, ctx.tz)).prompts++;
    dayFor(dayOf(p.ts, ctx.tz)).prompts++;
  }
  for (const d of days.values()) weekFor(periodWindow("day", d.day, ctx.tz).week).days.push(d);
  let letters = new Set<string>();
  try { letters = new Set(readdirSync(letterDir(ctx.vault)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))); } catch { /* none yet */ }
  const out = [...weeks.values()].sort((a, b) => (a.week < b.week ? 1 : -1));
  for (const w of out) {
    w.has_letter = letters.has(w.week);
    w.days.sort((a, b) => (a.day < b.day ? 1 : -1));
  }
  return { generated_ts: ctx.now, weeks: out };
}

function periodProjects(ctx: MirrorContext, ss: Sitting[]): PeriodProject[] {
  const by = new Map<string, PeriodProject>();
  for (const s of ss) {
    const p = by.get(s.project) ?? { slug: s.project, title: s.project ? ctx.titleOf(s.project) : "Other", domain: s.project ? ctx.domainOf(s.project) : "", sittings: 0, prompts: 0, minutes: 0 };
    p.sittings++;
    p.prompts += s.prompts.length;
    p.minutes += Math.max(1, Math.round((s.end_ts - s.start_ts) / 60e3));
    by.set(s.project, p);
  }
  // "Other" (no project) always sorts last.
  return [...by.values()].sort((a, b) => (a.slug ? 0 : 1) - (b.slug ? 0 : 1) || b.prompts - a.prompts || (a.title < b.title ? -1 : 1));
}

// Rules restated inside the period: the same rules the whole-history finding
// names, kept only when one of their mentions falls in it.
export function periodRules(ctx: MirrorContext, win: Window, model: string): Finding | null {
  const clusters = findRepeatedCandidates(ctx.prompts);
  if (!clusters.length) return null;
  const { key } = ruleGroups(clusters);
  const cache = readJson<RulesCache | null>(mpath(ctx.vault, "rules_cache.json"), null);
  const already = new Set(standingRules(ctx.vault).map(normRule));
  // A cache written before rules remembered their clusters is matched back by
  // shared words, so the named rules still show instead of raw candidates.
  const byWords = (item: FindingItem) => {
    const t = ruleTokens(item.rule_text ?? item.label);
    return clusters.filter((c) => {
      const u = ruleTokens(c.samples.join(" "));
      const shared = [...t].filter((w) => u.has(w)).length;
      return shared >= Math.min(3, t.size) && shared / t.size >= 0.5;
    });
  };
  const usable = cache && cache.hash === key && cache.model === model;
  const rows: { item: FindingItem; cs: RuleCluster[] }[] = usable
    ? cache.items.map((item) => ({ item, cs: cache.clusters ? (cache.clusters[item.id] ?? []).map((i) => clusters[i]).filter(Boolean) : byWords(item) }))
    : clusters.map((c) => ({ item: rawRuleItem(ctx, c), cs: [c] }));
  const items: FindingItem[] = [];
  const receipts: Receipt[] = [];
  for (const { item, cs } of rows) {
    if (already.has(normRule(item.rule_text ?? item.label))) continue;
    const hit = cs.flatMap((c) => c.members.filter((p) => inWin(p.ts, win)).map((p) => ({ c, p })));
    if (!hit.length) continue;
    items.push(item);
    if (receipts.length < 5) receipts.push(ruleReceipt(ctx, hit[hit.length - 1].c, hit[hit.length - 1].p));
  }
  if (!items.length) return null;
  const list = items.slice(0, 12);
  return {
    id: "repeated_rules", kind: "repeated_rules",
    headline: `${plural(list.length, "standing instruction")} you restated ${win.word}`,
    detail: `Each one you had already said in other sessions on other days. The top one came up in ${plural(list[0].count ?? 0, "separate session")} in all.`,
    metric: { value: list.length, unit: "rules" },
    visual: { type: "list", data: list.map((i) => ({ label: i.label, count: i.count ?? 0 })) },
    receipts, items: list, actions: ["rule"], cadence: "weekly", status: "new",
  };
}

interface PeriodCache { version: number; hash: string; generated_ts: number; projects: PeriodProject[]; totals: PeriodDoc["totals"]; findings: Finding[] }

const periodCachePath = (vault: string, kind: string, key: string) => mpath(vault, join("periods", `${kind}-${key}.json`));

const cleanFinding = (f: Finding): Finding => ({
  ...f, headline: sanitizeEmDashes(f.headline), detail: sanitizeEmDashes(f.detail),
  receipts: f.receipts.map((r) => ({ ...r, text: sanitizeEmDashes(r.text) })),
  items: f.items.map((i) => ({ ...i, label: sanitizeEmDashes(i.label), ...(i.detail ? { detail: sanitizeEmDashes(i.detail) } : {}), ...(i.rule_text ? { rule_text: sanitizeEmDashes(i.rule_text) } : {}) })),
});

export interface PeriodOptions { run?: ModelRunner | null; model?: ModelChoice; log?: (m: string) => void; fresh?: boolean }

// The findings for one week or one day. The week still going shows the
// standing findings (the last seven days, from `intent refresh`); a past week
// or any day is computed from its own prompts. Only the project kinds a
// tooling split needs may call a model, once per new project.
export async function periodFindings(ctx: MirrorContext, kind: "week" | "day", key: string, o: PeriodOptions = {}): Promise<PeriodDoc> {
  const m: ModelOpts = { run: o.run === undefined ? runModelOnce : o.run, model: o.model ?? modelChoice(), log: o.log ?? (() => {}) };
  const { key: pkey, week, win } = periodWindow(kind, key, ctx.tz);
  const verdicts = readVerdicts(ctx.vault);
  const current = week === weekOf(ctx.now, ctx.tz);
  const ss = ctx.sittings.filter((s) => inWin(s.start_ts, win));
  const nPrompts = ctx.prompts.filter((p) => inWin(p.ts, win)).length;
  const label = kind === "week" ? weekLabel(pkey, ctx.tz) : dayLabel(pkey);
  const lines = kind === "week" ? readWeekLines(ctx.vault) : readDayLines(ctx.vault);
  const letter = kind === "week" ? readLetter(ctx.vault, pkey, label) : null;
  const letter_status: PeriodDoc["letter_status"] = kind !== "week" || !ss.length ? "none" : letter ? "ready" : current ? "not_yet" : "missing";
  const base = {
    period: { kind, key: pkey, week, label }, current: kind === "week" && current,
    intent_line: lines[pkey]?.line ?? null, letter, letter_status,
  };

  if (kind === "week" && current) {
    const doc = readFindings(ctx.vault, ctx.now);
    return { ...base, generated_ts: doc.generated_ts, totals: { prompts: nPrompts, sittings: ss.length }, projects: periodProjects(ctx, ss), findings: doc.findings };
  }

  const rules = readJson<RulesCache | null>(mpath(ctx.vault, "rules_cache.json"), null);
  const statuses = (ctx.index?.projects ?? []).map((p) => `${p.slug}:${p.status}`).join(",");
  const sig = () => {
    const kinds = readJson<KindsCache>(mpath(ctx.vault, "project_kinds.json"), { model: "", kinds: {} }).kinds;
    return hash(JSON.stringify([
      PERIOD_VERSION, ss.map((s) => `${s.id}:${s.prompts.length}:${s.project}`), nPrompts, rules?.hash ?? "", rules?.model ?? "",
      standingRules(ctx.vault).length, statuses, [...new Set(ss.map((s) => kinds[s.project] ?? ""))],
    ]));
  };
  const h = sig();
  const cpath = periodCachePath(ctx.vault, kind, pkey);
  const cached = readJson<PeriodCache | null>(cpath, null);
  let body: PeriodCache;
  if (!o.fresh && cached && cached.version === PERIOD_VERSION && cached.hash === h) {
    body = cached;
  } else {
    const all: (Finding | null)[] = [
      periodRules(ctx, win, m.model.model),
      await toolingShare(ctx, m, win),
      openLoops(ctx, verdicts, win),
      lateNight(ctx, win),
      kind === "week" ? goalsDrift(ctx, win) : null,
    ];
    // Ids carry the period so "not really" on one week leaves the others be.
    const findings = all.filter((f): f is Finding => !!f).map((f) => cleanFinding({ ...f, id: `${f.kind}@${kind}-${pkey}` }));
    // Signed again: a tooling split may just have learned a project's kind.
    const h2 = sig();
    body = { version: PERIOD_VERSION, hash: h2, generated_ts: ctx.now, projects: periodProjects(ctx, ss), totals: { prompts: nPrompts, sittings: ss.length }, findings };
    if (ss.length) writeJson(cpath, body);
  }
  return { ...base, generated_ts: body.generated_ts, totals: body.totals, projects: body.projects, findings: applyVerdicts(body.findings, verdicts, ctx.now) };
}

export function buildDaysPrompt(days: { day: string; label: string; projects: { title: string; sittings: number; samples: string[] }[] }[]): string {
  return `Below is what one person worked on with AI tools, day by day: the projects they had sittings on and a few of their prompts.

For EACH day write one plain sentence (at most 20 words) saying what they were really after that day, in the second person ("You mostly ..."). Name the project. Say the intent, not the activity count. No em dashes.

Return ONLY a JSON object mapping the day key to the sentence.

${days.map((d) => `### ${d.day} (${d.label})\n${d.projects.map((p) => `- ${p.title} (${p.sittings} sittings): ${p.samples.join(" | ")}`).join("\n")}`).join("\n\n")}
`;
}

export interface GenerateResult { week: string; letter: Letter | null; week_line: string | null; day_lines: Record<string, string>; written: string[] }

// The model-written parts of one week, each made once: the week's line, a
// line per day (today's is rewritten while it changes) and, once the week has
// ended, its letter. Past weeks are fixed, so a second call costs nothing.
export async function generatePeriod(ctx: MirrorContext, week: string, o: PeriodOptions = {}): Promise<GenerateResult> {
  const m: ModelOpts = { run: o.run === undefined ? runModelOnce : o.run, model: o.model ?? modelChoice(), log: o.log ?? (() => {}) };
  const { key: wk, win } = periodWindow("week", week, ctx.tz);
  const ss = ctx.sittings.filter((s) => inWin(s.start_ts, win));
  const res: GenerateResult = { week: wk, letter: null, week_line: readWeekLines(ctx.vault)[wk]?.line ?? null, day_lines: {}, written: [] };
  if (!ss.length) return res;
  const label = weekLabel(wk, ctx.tz);
  const current = wk === weekOf(ctx.now, ctx.tz);

  // the week's line
  const lines = readWeekLines(ctx.vault);
  const wdigest = weekDigest(ctx, ss);
  const wh = hash(JSON.stringify(wdigest));
  if (m.run && (!lines[wk] || (o.fresh && current && lines[wk].hash !== wh))) {
    try {
      const ans = parseJsonAnswer<Record<string, string>>(await m.run(buildWeeksPrompt([{ week: wk, label, projects: wdigest }]), m.model));
      const line = typeof ans[wk] === "string" ? sanitizeEmDashes(ans[wk].trim()) : "";
      if (line) { lines[wk] = { line, hash: wh, model: m.model.model, ts: ctx.now }; writeJson(mpath(ctx.vault, "weeks.json"), lines); res.written.push("week_line"); }
    } catch (e) { m.log(`week line failed (${(e as Error).message})`); }
  }
  res.week_line = lines[wk]?.line ?? null;

  // a line per day
  const dlines = readDayLines(ctx.vault);
  const byDay = new Map<string, Sitting[]>();
  for (const s of ss) { const d = dayOf(s.start_ts, ctx.tz); (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(s); }
  const todo: { day: string; label: string; hash: string; projects: ReturnType<typeof weekDigest> }[] = [];
  for (const [d, xs] of byDay) {
    const projects = weekDigest(ctx, xs);
    const dh = hash(JSON.stringify(projects));
    if (dlines[d] && (dlines[d].hash === dh || d !== dayOf(ctx.now, ctx.tz))) continue;
    todo.push({ day: d, label: dayLabel(d), hash: dh, projects });
  }
  if (m.run && todo.length) {
    try {
      const ans = parseJsonAnswer<Record<string, string>>(await m.run(buildDaysPrompt(todo), m.model));
      for (const t of todo) {
        const line = typeof ans[t.day] === "string" ? sanitizeEmDashes(ans[t.day].trim()) : "";
        if (line) { dlines[t.day] = { line, hash: t.hash, model: m.model.model, ts: ctx.now }; res.written.push(`day:${t.day}`); }
      }
      writeJson(mpath(ctx.vault, "days.json"), dlines);
    } catch (e) { m.log(`day lines failed (${(e as Error).message})`); }
  }
  for (const d of byDay.keys()) if (dlines[d]) res.day_lines[d] = dlines[d].line;

  // the letter, once the week is over
  if (!current) {
    const had = readLetter(ctx.vault, wk, label);
    if (had) res.letter = had;
    else {
      const doc = await periodFindings(ctx, "week", wk, { ...o, run: m.run, model: m.model });
      res.letter = await weeklyLetter(ctx, m, doc.findings, wk);
      if (res.letter) res.written.push("letter");
    }
  }
  return res;
}
