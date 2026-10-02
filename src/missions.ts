// Missions: time-bound efforts the user talks to (missions-plan.md). A mission
// is a domain with an outcome and an end: it references domains, apps,
// specialists, people and calendar events by id, and only what is born in it
// lives in its folder:
//
//   data/missions/<slug>/
//     mission.md          frontmatter (below) + ## Outcome, ## Why, ## Your notes
//     milestones.md       - [ ] Title ~id:ms-x ~due:D ~weight:N ~check:<metric>  ~done:D
//     links.json          { calendar, tasks, decisions, files, threads } references
//     artifacts/ files/   what the mission produced; files the user added
//     memory/state.md memory.md log.md decisions.jsonl updates.jsonl touches.jsonl
//     memory/ledger.jsonl budget actuals: { ts, line, usd (spend is negative), what, ref, by }
//     memory/tasks.md     mission-native tasks (the same board file a domain uses)
//     memory/threads/     mission chats (never edited)
//     closeout.md         written at completion
//
// Frontmatter values are YAML; lists and maps are written in flow style (JSON
// is valid YAML), so any YAML reader and this module agree.
//
// Ids: mission/<slug>. The retired entity kind project/<slug> resolves to the
// mission forever (migrateProjects carries old vaults over).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import { appendJsonl, readJsonl } from "./linking.ts";
import { dataRoot, MISSIONS_DIR, resolveDomainDir } from "./path-safety.ts";
import { listDomainDirs, V4_MARKER } from "./vault-layout-v4.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { CEILINGS, type Ceiling } from "./specialists.ts";

export type MissionStatus = "active" | "paused" | "completed" | "archived";
export const MISSION_STATUSES: MissionStatus[] = ["active", "paused", "completed", "archived"];
export type Role = "owner" | "consulted" | "informed";
export const ROLES: Role[] = ["owner", "consulted", "informed"];
export type MissionResult = "met" | "partly" | "not-met" | "changed";
export const RESULTS: MissionResult[] = ["met", "partly", "not-met", "changed"];

export interface MissionDomain { slug: string; role: Role }
export interface BudgetLine { id: string; label: string; usd: number }
export interface MissionBudget { total_usd?: number; hours_wk?: number; lines: BudgetLine[] }
export interface MissionMatch { calendar?: string[]; email_from?: string[]; merchants?: string[] }

export interface Mission {
  slug: string;
  id: string; // mission/<slug>
  name: string;
  status: MissionStatus;
  outcome: string;
  start: string;
  target: string;
  completed?: string;
  result?: MissionResult;
  cadence: string;
  domains: MissionDomain[];
  apps: string[];
  specialists: string[];
  people: string[];
  entities: string[];
  budget: MissionBudget;
  goal?: string;
  path?: string;
  serves: string[];
  metrics: string[];
  match: MissionMatch;
  prompt_projects: string[];
  repos: string[];
  ceiling: Ceiling;
  nudges: { per_week: number; muted: boolean };
  privacy: { localOnly: boolean };
  created: string;
  updated: string;
  why: string;
  notes: string;
  /** Body text outside the three known sections, kept verbatim. */
  rest: string;
}

export interface Milestone { id: string; title: string; done: boolean; due?: string; doneOn?: string; weight: number; check?: string; event?: string; raw?: string }
export interface Links {
  calendar: { app: string; event: string; title: string; start: string; kind?: string; source: "matched" | "created"; milestone?: string }[];
  tasks: { domain: string; id: string }[];
  decisions: { domain: string; file: string }[];
  files: { domain: string; path: string }[];
  threads: { domain: string; thread: string; title?: string }[];
}
export interface LedgerRow { ts: string; line: string; usd: number; what: string; ref?: string; by: "matched" | "user" | "mission" }

export interface Progress {
  milestones: { done: number; total: number; share: number; next?: Milestone; overdue: Milestone[] };
  budget: { planned: number; used: number; share: number; byLine: { id: string; label: string; planned: number; used: number }[] };
  days: { day: number; total: number; left: number };
}

export interface Artifact { path: string; name: string; kind: "artifact" | "file" | "brief"; mtime: number }
export type MissionView = Mission & { progress: Progress; milestones: Milestone[]; links: Links; localOnly: boolean; artifacts: Artifact[]; log: string[]; closed: boolean };

// ── Paths ───────────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
export function missionsRoot(vault: string): string { return join(dataRoot(vault), MISSIONS_DIR); }
export function missionDir(vault: string, slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error(`bad mission slug: ${slug}`);
  return join(missionsRoot(vault), slug);
}
const missionFile = (vault: string, slug: string) => join(missionDir(vault, slug), "mission.md");

export function missionSlugify(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
}

/** mission/<slug>, project/<slug> (the retired kind), _mission-<slug> or a bare slug, to a slug. */
export function missionSlugOf(ref: string): string {
  const s = ref.trim().replace(/^prevail:\/\//, "");
  const m = /^(?:mission|project)\/(.+)$/.exec(s) ?? /^_mission-(.+)$/.exec(s);
  return missionSlugify(m ? m[1]! : s);
}

function readText(p: string): string {
  if (!existsSync(p)) return "";
  try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } }
}
function writeText(p: string, text: string): void {
  mkdirSync(join(p, ".."), { recursive: true });
  vwriteFile(p, text);
}
function readJson<T>(p: string, fallback: T): T {
  const t = readText(p);
  if (!t.trim()) return fallback;
  try { return JSON.parse(t) as T; } catch { return fallback; }
}

const iso = (ts: number) => new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");
const ymd = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const oneLine = (s: string, n = 300) => s.replace(/\s+/g, " ").replace(/\s*\u2014\s*/g, ", ").trim().slice(0, n);
const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

// ── mission.md ──────────────────────────────────────────────────────────────

const KEY_ORDER = [
  "name", "status", "outcome", "start", "target", "completed", "result", "cadence", "domains", "apps", "specialists",
  "people", "entities", "budget", "goal", "path", "serves", "metrics", "match", "prompt_projects", "repos", "ceiling",
  "nudges", "privacy", "created", "updated",
] as const;

function yamlValue(v: unknown): string {
  if (typeof v === "string") return /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/.test(v) && !/^(true|false|yes|no|null|~)$/i.test(v) ? v : JSON.stringify(v);
  return JSON.stringify(v);
}
function parseValue(raw: string): unknown {
  const t = raw.trim();
  if (!t) return undefined;
  if (/^[[{"]/.test(t)) { try { return JSON.parse(t); } catch { return t.replace(/^"|"$/g, ""); } }
  return t;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? uniq(v.filter((x): x is string => typeof x === "string")) : typeof v === "string" && v ? uniq(v.split(",")) : []);

function sectionOf(body: string, name: string): string {
  const m = new RegExp(`^##\\s+${name}\\s*$`, "im").exec(body);
  if (!m) return "";
  const after = body.slice(m.index + m[0].length);
  const next = /^##\s+/m.exec(after);
  return (next ? after.slice(0, next.index) : after).trim();
}
function restOf(body: string): string {
  return body.split(/^(?=##\s+)/m).filter((p) => !/^##\s+(Outcome|Why|Your notes)\s*$/i.test(p.split("\n")[0]!)).join("").trim();
}

export function parseMission(md: string, slug: string): Mission {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  const f: Record<string, unknown> = {};
  if (fm) for (const l of fm[1]!.split("\n")) { const m = /^([a-z_]+):\s?(.*)$/.exec(l); if (m) f[m[1]!] = parseValue(m[2]!); }
  const body = fm ? md.slice(fm[0].length) : md;
  const s = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : f[k] == null ? "" : String(f[k]));
  const status = s("status") as MissionStatus;
  const doms = Array.isArray(f.domains) ? (f.domains as unknown[]).flatMap((d): MissionDomain[] => {
    if (typeof d === "string") return [{ slug: d, role: "consulted" }];
    const o = d as { slug?: unknown; role?: unknown };
    return typeof o?.slug === "string" ? [{ slug: o.slug, role: ROLES.includes(o.role as Role) ? (o.role as Role) : "consulted" }] : [];
  }) : [];
  const b = (f.budget && typeof f.budget === "object" ? f.budget : {}) as Partial<MissionBudget>;
  const n = (f.nudges && typeof f.nudges === "object" ? f.nudges : {}) as Partial<Mission["nudges"]>;
  const p = (f.privacy && typeof f.privacy === "object" ? f.privacy : {}) as Partial<Mission["privacy"]>;
  const result = s("result") as MissionResult;
  const ceiling = s("ceiling") as Ceiling;
  return {
    slug, id: `mission/${slug}`, name: s("name") || slug,
    status: MISSION_STATUSES.includes(status) ? status : "active",
    outcome: s("outcome"), start: s("start"), target: s("target"),
    ...(s("completed") ? { completed: s("completed") } : {}),
    ...(RESULTS.includes(result) ? { result } : {}),
    cadence: s("cadence") || "weekly",
    domains: doms, apps: strs(f.apps), specialists: strs(f.specialists), people: strs(f.people), entities: strs(f.entities),
    budget: {
      ...(typeof b.total_usd === "number" ? { total_usd: b.total_usd } : {}),
      ...(typeof b.hours_wk === "number" ? { hours_wk: b.hours_wk } : {}),
      lines: Array.isArray(b.lines) ? b.lines.filter((l) => l && typeof l.id === "string").map((l) => ({ id: l.id, label: String(l.label ?? l.id), usd: Number(l.usd) || 0 })) : [],
    },
    ...(s("goal") ? { goal: s("goal") } : {}),
    ...(s("path") ? { path: s("path") } : {}),
    serves: strs(f.serves), metrics: strs(f.metrics),
    match: (f.match && typeof f.match === "object" ? f.match : {}) as MissionMatch,
    prompt_projects: strs(f.prompt_projects), repos: strs(f.repos),
    ceiling: CEILINGS.includes(ceiling) ? ceiling : "draft",
    nudges: { per_week: typeof n.per_week === "number" ? n.per_week : 1, muted: n.muted === true },
    privacy: { localOnly: p.localOnly === true },
    created: s("created"), updated: s("updated"),
    why: sectionOf(body, "Why"), notes: sectionOf(body, "Your notes"), rest: restOf(body),
  };
}

export function serializeMission(m: Mission): string {
  const vals: Record<string, unknown> = {
    name: m.name, status: m.status, outcome: m.outcome, start: m.start, target: m.target, completed: m.completed, result: m.result,
    cadence: m.cadence, domains: m.domains, apps: m.apps, specialists: m.specialists, people: m.people, entities: m.entities,
    budget: m.budget, goal: m.goal, path: m.path, serves: m.serves, metrics: m.metrics, match: m.match,
    prompt_projects: m.prompt_projects, repos: m.repos, ceiling: m.ceiling, nudges: m.nudges, privacy: m.privacy,
    created: m.created, updated: m.updated,
  };
  const fm = KEY_ORDER.map((k) => { const v = vals[k]; return v === undefined || v === "" ? `${k}:` : `${k}: ${yamlValue(v)}`; });
  const body = [`## Outcome`, m.outcome, "", `## Why`, m.why, "", `## Your notes`, m.notes, ...(m.rest ? ["", m.rest] : [])].join("\n");
  return `---\n${fm.join("\n")}\n---\n${body.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// ── Reading ─────────────────────────────────────────────────────────────────

export function missionExists(vault: string, ref: string): boolean {
  const slug = missionSlugOf(ref);
  return !!slug && SLUG_RE.test(slug) && existsSync(missionFile(vault, slug));
}

export function readMission(vault: string, ref: string): Mission | null {
  const slug = missionSlugOf(ref);
  if (!slug || !SLUG_RE.test(slug)) return null;
  const t = readText(missionFile(vault, slug));
  return t ? parseMission(t, slug) : null;
}

export function listMissionSlugs(vault: string): string[] {
  const root = missionsRoot(vault);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((d) => SLUG_RE.test(d) && existsSync(join(root, d, "mission.md"))).sort();
}

export function listMissions(vault: string, o: { status?: MissionStatus | "all"; now?: number } = {}): MissionView[] {
  const want = o.status ?? "all";
  return listMissionSlugs(vault)
    .map((s) => missionView(vault, s, o.now))
    .filter((m): m is MissionView => !!m && (want === "all" || m.status === want))
    .sort((a, b) => (a.status === b.status ? (a.target || "9").localeCompare(b.target || "9") : MISSION_STATUSES.indexOf(a.status) - MISSION_STATUSES.indexOf(b.status)));
}

/** Active missions, for routing, the touch step and the domain pointer. */
export function activeMissions(vault: string): Mission[] {
  return listMissionSlugs(vault).map((s) => readMission(vault, s)).filter((m): m is Mission => !!m && m.status === "active");
}

export function ownerOf(m: Mission): string | undefined { return m.domains.find((d) => d.role === "owner")?.slug; }
export function domainsWith(m: Mission, role: Role): string[] { return m.domains.filter((d) => d.role === role).map((d) => d.slug); }

/** Strictest wins: local-only when the mission says so or any attached domain does. */
export function missionLocalOnly(vault: string, m: Mission, readLocal: (d: string) => boolean = (d) => domainLocalOnly(vault, d)): boolean {
  return m.privacy.localOnly || m.domains.some((d) => readLocal(d.slug));
}
function domainLocalOnly(vault: string, slug: string): boolean {
  try {
    const j = readJson<{ privacy?: { localOnly?: boolean } }>(join(resolveDomainDir(vault, slug), "manifest.json"), {});
    return j.privacy?.localOnly === true;
  } catch { return false; }
}

export function missionView(vault: string, ref: string, now = Date.now()): MissionView | null {
  const m = readMission(vault, ref);
  if (!m) return null;
  const milestones = readMilestones(vault, m.slug);
  const dir = missionDir(vault, m.slug);
  const artifacts: Artifact[] = [];
  for (const [sub, kind] of [["artifacts", "artifact"], ["files", "file"], ["memory/briefs", "brief"]] as const) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) {
      if (n.startsWith(".")) continue;
      try { const st = statSync(join(d, n)); if (st.isFile()) artifacts.push({ path: `data/missions/${m.slug}/${sub}/${n}`, name: n, kind, mtime: st.mtimeMs }); } catch { /* gone */ }
    }
  }
  artifacts.sort((a, b) => b.mtime - a.mtime);
  const log = readText(join(dir, "memory", "log.md")).split("\n").filter((l) => /^-\s/.test(l)).map((l) => l.replace(/^-\s+/, "")).slice(0, 60);
  return { ...m, milestones, links: readLinks(vault, m.slug), progress: progressOf(m, milestones, readLedger(vault, m.slug), now), localOnly: missionLocalOnly(vault, m), artifacts, log, closed: existsSync(join(dir, "closeout.md")) };
}

// ── Milestones ──────────────────────────────────────────────────────────────

const TOKEN = /\s+~([a-z][a-z0-9_-]*):(\S+)/g;

export function parseMilestones(md: string): Milestone[] {
  const out: Milestone[] = [];
  for (const l of md.split("\n")) {
    const m = /^\s*-\s+\[( |x|X)\]\s+(.+)$/.exec(l);
    if (!m) continue;
    const t: Record<string, string> = {};
    const title = ` ${m[2]}`.replace(TOKEN, (_x, k: string, v: string) => { t[k] = v; return ""; }).trim();
    out.push({
      id: t.id ?? `ms-${createHash("sha1").update(title.toLowerCase()).digest("hex").slice(0, 6)}`, title, done: m[1] !== " ",
      ...(t.due ? { due: t.due } : {}), ...(t.done ? { doneOn: t.done } : {}), weight: Math.max(0, Number(t.weight ?? 1) || 1),
      ...(t.check ? { check: t.check } : {}), ...(t.event ? { event: t.event } : {}), raw: l,
    });
  }
  return out;
}
export function renderMilestones(ms: Milestone[]): string {
  return `# Milestones\n${ms.map((m) => `- [${m.done ? "x" : " "}] ${oneLine(m.title, 160)} ~id:${m.id}${m.due ? ` ~due:${m.due}` : ""}${m.weight !== 1 ? ` ~weight:${m.weight}` : ""}${m.check ? ` ~check:${m.check}` : ""}${m.event ? ` ~event:${m.event}` : ""}${m.doneOn ? ` ~done:${m.doneOn}` : ""}`).join("\n")}\n`;
}
export function readMilestones(vault: string, slug: string): Milestone[] { return parseMilestones(readText(join(missionDir(vault, slug), "milestones.md"))); }
function writeMilestones(vault: string, slug: string, ms: Milestone[]): void { writeText(join(missionDir(vault, slug), "milestones.md"), renderMilestones(ms)); }

// ── Links and ledger ────────────────────────────────────────────────────────

const EMPTY_LINKS: Links = { calendar: [], tasks: [], decisions: [], files: [], threads: [] };
export function readLinks(vault: string, slug: string): Links {
  const j = readJson<Partial<Links>>(join(missionDir(vault, slug), "links.json"), {});
  return { calendar: j.calendar ?? [], tasks: j.tasks ?? [], decisions: j.decisions ?? [], files: j.files ?? [], threads: j.threads ?? [] };
}
export function writeLinks(vault: string, slug: string, l: Links): void { writeText(join(missionDir(vault, slug), "links.json"), `${JSON.stringify(l, null, 2)}\n`); }

export const ledgerPath = (vault: string, slug: string) => join(missionDir(vault, slug), "memory", "ledger.jsonl");
/** Ledger rows; a charge referenced twice counts once (the first row). */
export function readLedger(vault: string, slug: string): LedgerRow[] {
  const seen = new Set<string>();
  return readJsonl<LedgerRow>(ledgerPath(vault, slug)).filter((r) => {
    if (!r || typeof r.usd !== "number") return false;
    if (!r.ref) return true;
    if (seen.has(r.ref)) return false;
    seen.add(r.ref);
    return true;
  });
}

const DAY = 86_400_000;
export function progressOf(m: Mission, ms: Milestone[], ledger: LedgerRow[], now = Date.now()): Progress {
  const total = ms.reduce((a, x) => a + x.weight, 0);
  const done = ms.filter((x) => x.done);
  const share = total ? ms.filter((x) => x.done).reduce((a, x) => a + x.weight, 0) / total : 0;
  const today = ymd(now);
  const open = ms.filter((x) => !x.done);
  const next = [...open].sort((a, b) => (a.due ?? "9").localeCompare(b.due ?? "9"))[0];
  const spent = (line?: string) => ledger.filter((r) => !line || r.line === line).reduce((a, r) => a - r.usd, 0);
  const planned = m.budget.total_usd ?? m.budget.lines.reduce((a, l) => a + l.usd, 0);
  const used = Math.round(spent() * 100) / 100;
  const start = Date.parse(m.start || m.created || today);
  const end = Date.parse(m.target || today);
  const t0 = Date.parse(today);
  return {
    milestones: { done: done.length, total: ms.length, share: Math.round(share * 100) / 100, ...(next ? { next } : {}), overdue: open.filter((x) => x.due && x.due < today) },
    budget: { planned, used, share: planned ? Math.round((used / planned) * 100) / 100 : 0, byLine: m.budget.lines.map((l) => ({ id: l.id, label: l.label, planned: l.usd, used: Math.round(spent(l.id) * 100) / 100 })) },
    days: {
      day: Number.isNaN(start) ? 0 : Math.max(1, Math.floor((t0 - start) / DAY) + 1),
      total: Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(1, Math.round((end - start) / DAY) + 1),
      left: Number.isNaN(end) ? 0 : Math.round((end - t0) / DAY),
    },
  };
}

/** What is left of the money budget (null when the mission has no budget). */
export function budgetLeft(vault: string, m: Mission): number | null {
  const p = progressOf(m, [], readLedger(vault, m.slug));
  return p.budget.planned ? Math.round((p.budget.planned - p.budget.used) * 100) / 100 : null;
}

// ── Writing ─────────────────────────────────────────────────────────────────

function save(vault: string, m: Mission, now: number): void {
  m.updated = iso(now);
  writeText(missionFile(vault, m.slug), serializeMission(m));
}

/** One dated line at the top of memory/log.md (newest first). */
export function logLine(vault: string, slug: string, text: string, now = Date.now()): string {
  const p = join(missionDir(vault, slug), "memory", "log.md");
  const cur = readText(p);
  const line = `- ${ymd(now)} ${oneLine(text, 400)}`;
  const body = cur.replace(/^# Log\s*\n*/i, "");
  writeText(p, `# Log\n\n${line}\n${body}`.replace(/\n{3,}/g, "\n\n"));
  return line;
}

function checkDomains(vault: string, ds: MissionDomain[]): MissionDomain[] {
  const have = new Set(listDomainDirs(vault).map((d) => d.toLowerCase()));
  const out: MissionDomain[] = [];
  for (const d of ds) {
    const slug = d.slug.trim().toLowerCase();
    if (!slug) continue;
    if (!have.has(slug)) throw new Error(`no domain "${slug}"`);
    if (!ROLES.includes(d.role)) throw new Error(`role must be owner, consulted or informed, not "${d.role}"`);
    const i = out.findIndex((x) => x.slug === slug);
    if (i >= 0) out.splice(i, 1);
    out.push({ slug, role: d.role });
  }
  const owners = out.filter((d) => d.role === "owner");
  if (owners.length > 1) {
    // The last owner named wins; earlier ones become consulted.
    for (const o of owners.slice(0, -1)) o.role = "consulted";
  }
  return out;
}

/** "learning:owner" or "money" (consulted) to a domain and its role. */
export function parseDomainArg(s: string, fallback: Role = "consulted"): MissionDomain {
  const [slug, role] = s.split(":");
  return { slug: (slug ?? "").trim().toLowerCase(), role: (role?.trim().toLowerCase() as Role) || fallback };
}

/** Ben proposes a target when the user gives none: trips and learning ask, the rest get 90 days. */
export function proposedTarget(now = Date.now()): string { return ymd(now + 90 * DAY); }

export interface CreateMissionInput {
  name: string; outcome?: string; why?: string; target?: string; start?: string; cadence?: string;
  domains?: MissionDomain[]; apps?: string[]; specialists?: string[]; people?: string[]; entities?: string[];
  budgetUsd?: number; budgetLines?: BudgetLine[]; hoursWk?: number; goal?: string; path?: string;
  promptProjects?: string[]; repos?: string[]; ceiling?: Ceiling; milestones?: { title: string; due?: string; weight?: number; check?: string }[];
  from?: string; now?: number;
}

export function createMission(vault: string, i: CreateMissionInput): MissionView {
  const now = i.now ?? Date.now();
  const name = oneLine(i.name, 120);
  const slug = missionSlugify(name);
  if (!slug) throw new Error("a mission needs a name");
  if (existsSync(missionFile(vault, slug))) throw new Error(`mission/${slug} already exists`);
  const target = (i.target ?? "").trim() || proposedTarget(now);
  if (!isYmd(target)) throw new Error(`target must be YYYY-MM-DD, not "${i.target}"`);
  const start = (i.start ?? "").trim() || ymd(now);
  if (!isYmd(start)) throw new Error(`start must be YYYY-MM-DD, not "${i.start}"`);
  if (i.ceiling && !CEILINGS.includes(i.ceiling)) throw new Error(`ceiling must be one of ${CEILINGS.join(", ")}`);
  const domains = checkDomains(vault, i.domains ?? []);
  for (const pp of i.promptProjects ?? []) {
    const have = listMissionSlugs(vault).map((x) => readMission(vault, x)).find((x) => x?.prompt_projects.includes(pp));
    if (have) throw new Error(`the prompt project "${pp}" is already tracked as ${have.id}`);
  }
  const m: Mission = {
    slug, id: `mission/${slug}`, name, status: "active", outcome: oneLine(i.outcome ?? ""), start, target, cadence: i.cadence || "weekly",
    domains, apps: uniq(i.apps ?? []), specialists: uniq((i.specialists ?? []).map((s) => s.toLowerCase())), people: uniq(i.people ?? []), entities: uniq(i.entities ?? []),
    budget: { ...(i.budgetUsd != null ? { total_usd: i.budgetUsd } : {}), ...(i.hoursWk != null ? { hours_wk: i.hoursWk } : {}), lines: i.budgetLines ?? [] },
    ...(i.goal ? { goal: i.goal } : {}), ...(i.path ? { path: i.path } : {}),
    serves: [], metrics: [], match: {}, prompt_projects: uniq(i.promptProjects ?? []), repos: uniq(i.repos ?? []),
    ceiling: i.ceiling ?? "draft", nudges: { per_week: 1, muted: false }, privacy: { localOnly: false },
    created: iso(now), updated: iso(now), why: (i.why ?? "").trim(), notes: "", rest: "",
  };
  const dir = missionDir(vault, slug);
  mkdirSync(join(dir, "memory", "threads"), { recursive: true });
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  mkdirSync(join(dir, "files"), { recursive: true });
  // The v4 marker: threads and boards resolve under memory/ like a v4 domain.
  writeText(join(dir, V4_MARKER), "1");
  save(vault, m, now);
  writeMilestones(vault, slug, (i.milestones ?? []).map((x) => ({ id: `ms-${missionSlugify(x.title).slice(0, 30)}`, title: x.title, done: false, weight: x.weight ?? 1, ...(x.due ? { due: x.due } : {}), ...(x.check ? { check: x.check } : {}) })));
  writeLinks(vault, slug, EMPTY_LINKS);
  writeText(join(dir, "memory", "state.md"), `# ${name}\n\nStarted ${start}. Target ${target}.\n`);
  writeText(join(dir, "memory", "memory.md"), `# What this mission has learned\n`);
  logLine(vault, slug, `Mission started${i.from ? ` (${i.from})` : ""}: ${m.outcome || name}`, now);
  return missionView(vault, slug, now)!;
}

export interface MissionPatch { name?: string; outcome?: string; why?: string; target?: string; cadence?: string; ceiling?: string; goal?: string; path?: string; notes?: string; localOnly?: boolean; nudgesPerWeek?: number; muted?: boolean; budgetUsd?: number; hoursWk?: number; match?: MissionMatch }

export function setMission(vault: string, ref: string, p: MissionPatch, now = Date.now()): MissionView {
  const m = readMission(vault, ref);
  if (!m) throw new Error(`no mission "${ref}"`);
  if (p.name !== undefined && oneLine(p.name)) m.name = oneLine(p.name, 120);
  if (p.outcome !== undefined) m.outcome = oneLine(p.outcome);
  if (p.why !== undefined) m.why = p.why.trim();
  if (p.notes !== undefined) m.notes = p.notes.trim();
  if (p.target !== undefined) { if (!isYmd(p.target.trim())) throw new Error(`target must be YYYY-MM-DD, not "${p.target}"`); m.target = p.target.trim(); }
  if (p.cadence !== undefined) m.cadence = p.cadence.trim() || "weekly";
  if (p.ceiling !== undefined) { if (!CEILINGS.includes(p.ceiling as Ceiling)) throw new Error(`ceiling must be one of ${CEILINGS.join(", ")}`); m.ceiling = p.ceiling as Ceiling; }
  if (p.goal !== undefined) { if (p.goal) m.goal = p.goal; else delete m.goal; }
  if (p.path !== undefined) { if (p.path) m.path = p.path; else delete m.path; }
  if (p.localOnly !== undefined) m.privacy.localOnly = p.localOnly;
  if (p.nudgesPerWeek !== undefined) m.nudges.per_week = Math.max(0, Math.min(3, Math.round(p.nudgesPerWeek)));
  if (p.muted !== undefined) m.nudges.muted = p.muted;
  if (p.budgetUsd !== undefined) m.budget.total_usd = p.budgetUsd;
  if (p.hoursWk !== undefined) m.budget.hours_wk = p.hoursWk;
  if (p.match !== undefined) m.match = { ...m.match, ...p.match };
  save(vault, m, now);
  return missionView(vault, m.slug, now)!;
}

export type AttachKind = "domain" | "app" | "specialist" | "person" | "entity" | "prompt-project" | "repo";
export function attach(vault: string, ref: string, kind: AttachKind, value: string, now = Date.now()): MissionView {
  const m = readMission(vault, ref);
  if (!m) throw new Error(`no mission "${ref}"`);
  const v = value.trim();
  if (!v) throw new Error(`nothing to attach`);
  if (kind === "domain") m.domains = checkDomains(vault, [...m.domains, parseDomainArg(v)]);
  else if (kind === "app") m.apps = uniq([...m.apps, v]);
  else if (kind === "specialist") m.specialists = uniq([...m.specialists, v.toLowerCase()]);
  else if (kind === "person") m.people = uniq([...m.people, v.includes("/") ? v : `person/${v}`]);
  else if (kind === "entity") m.entities = uniq([...m.entities, v]);
  else if (kind === "prompt-project") m.prompt_projects = uniq([...m.prompt_projects, v]);
  else if (kind === "repo") m.repos = uniq([...m.repos, v]);
  save(vault, m, now);
  return missionView(vault, m.slug, now)!;
}
export function detach(vault: string, ref: string, kind: AttachKind, value: string, now = Date.now()): MissionView {
  const m = readMission(vault, ref);
  if (!m) throw new Error(`no mission "${ref}"`);
  const v = value.trim().split(":")[0]!;
  const drop = (xs: string[]) => xs.filter((x) => x !== v && x !== `person/${v}`);
  if (kind === "domain") m.domains = m.domains.filter((d) => d.slug !== v.toLowerCase());
  else if (kind === "app") m.apps = drop(m.apps);
  else if (kind === "specialist") m.specialists = drop(m.specialists);
  else if (kind === "person") m.people = drop(m.people);
  else if (kind === "entity") m.entities = drop(m.entities);
  else if (kind === "prompt-project") m.prompt_projects = drop(m.prompt_projects);
  else if (kind === "repo") m.repos = drop(m.repos);
  save(vault, m, now);
  return missionView(vault, m.slug, now)!;
}

export function milestone(vault: string, ref: string, op: "add" | "done" | "undone" | "move", o: { title?: string; id?: string; due?: string; check?: string; weight?: number }, now = Date.now()): Milestone[] {
  const m = readMission(vault, ref);
  if (!m) throw new Error(`no mission "${ref}"`);
  const ms = readMilestones(vault, m.slug);
  if (o.due && !isYmd(o.due)) throw new Error(`due must be YYYY-MM-DD, not "${o.due}"`);
  const find = () => {
    const x = ms.find((y) => y.id === o.id) ?? ms.find((y) => o.title && y.title.toLowerCase() === o.title.toLowerCase());
    if (!x) throw new Error(`no milestone "${o.id ?? o.title}"`);
    return x;
  };
  if (op === "add") {
    if (!o.title?.trim()) throw new Error("a milestone needs a title");
    let id = `ms-${missionSlugify(o.title).slice(0, 30)}`;
    for (let n = 2; ms.some((x) => x.id === id); n++) id = `ms-${missionSlugify(o.title).slice(0, 27)}-${n}`;
    ms.push({ id, title: oneLine(o.title, 160), done: false, weight: o.weight ?? 1, ...(o.due ? { due: o.due } : {}), ...(o.check ? { check: o.check } : {}) });
    logLine(vault, m.slug, `Milestone added: ${o.title}`, now);
  } else if (op === "done" || op === "undone") {
    const x = find();
    x.done = op === "done";
    if (x.done) x.doneOn = ymd(now); else delete x.doneOn;
    logLine(vault, m.slug, `Milestone ${x.done ? "reached" : "reopened"}: ${x.title}`, now);
  } else {
    const x = find();
    if (o.due) x.due = o.due;
    if (o.title && o.id) x.title = oneLine(o.title, 160);
    if (o.weight != null) x.weight = o.weight;
  }
  writeMilestones(vault, m.slug, ms);
  save(vault, m, now);
  return ms;
}

/** A milestone with ~check:<metric><op><n> completes itself when the metric reads true. */
export function checkMilestones(vault: string, ref: string, read: (metric: string) => number | null, now = Date.now()): Milestone[] {
  const m = readMission(vault, ref);
  if (!m) return [];
  const ms = readMilestones(vault, m.slug);
  const hit: Milestone[] = [];
  for (const x of ms) {
    if (x.done || !x.check) continue;
    const c = /^([a-z0-9_-]+)(>=|<=|>|<|=)(-?\d+(?:\.\d+)?)$/i.exec(x.check);
    if (!c) continue;
    const v = read(c[1]!);
    if (v == null) continue;
    const n = Number(c[3]);
    const ok = c[2] === ">=" ? v >= n : c[2] === "<=" ? v <= n : c[2] === ">" ? v > n : c[2] === "<" ? v < n : v === n;
    if (ok) { x.done = true; x.doneOn = ymd(now); hit.push(x); }
  }
  if (hit.length) {
    writeMilestones(vault, m.slug, ms);
    for (const x of hit) logLine(vault, m.slug, `Milestone reached (from ${x.check}): ${x.title}`, now);
  }
  return hit;
}

export function setBudgetLine(vault: string, ref: string, line: string, usd: number, label?: string, now = Date.now()): MissionView {
  const m = readMission(vault, ref);
  if (!m) throw new Error(`no mission "${ref}"`);
  const id = missionSlugify(line);
  if (!id) throw new Error("a budget line needs a name");
  if (!Number.isFinite(usd) || usd < 0) throw new Error("usd must be a positive number");
  const at = m.budget.lines.find((l) => l.id === id);
  if (at) { at.usd = usd; if (label) at.label = label; } else m.budget.lines.push({ id, label: label || line, usd });
  save(vault, m, now);
  return missionView(vault, m.slug, now)!;
}

/** Record a spend (a positive amount spent). A charge ref already recorded is never counted twice. */
export function spend(vault: string, ref: string, o: { line: string; usd: number; what: string; ref?: string; by?: LedgerRow["by"] }, now = Date.now()): { added: boolean; row: LedgerRow } {
  const m = readMission(vault, ref);
  if (!m) throw new Error(`no mission "${ref}"`);
  if (!Number.isFinite(o.usd) || o.usd <= 0) throw new Error("usd must be a positive amount spent");
  const line = missionSlugify(o.line) || "other";
  const row: LedgerRow = { ts: ymd(now), line, usd: -Math.round(o.usd * 100) / 100, what: oneLine(o.what, 200), ...(o.ref ? { ref: o.ref } : {}), by: o.by ?? "user" };
  if (o.ref && readJsonl<LedgerRow>(ledgerPath(vault, m.slug)).some((r) => r.ref === o.ref)) return { added: false, row };
  appendJsonl(ledgerPath(vault, m.slug), row);
  logLine(vault, m.slug, `Spent $${o.usd.toFixed(2)} on ${line}: ${row.what}`, now);
  return { added: true, row };
}

/** Link a calendar event (matched) or queue a created one (a hold the user approves). */
export function linkEvent(vault: string, ref: string, e: { app?: string; event?: string; title: string; start: string; kind?: string; milestone?: string; create?: boolean }, now = Date.now()): Links {
  const m = readMission(vault, ref);
  if (!m) throw new Error(`no mission "${ref}"`);
  if (Number.isNaN(Date.parse(e.start))) throw new Error(`start must be a date or time, not "${e.start}"`);
  const l = readLinks(vault, m.slug);
  const id = e.event || `pending-${now.toString(36)}`;
  if (!l.calendar.some((c) => c.event === id)) {
    l.calendar.push({ app: e.app || "google-calendar", event: id, title: oneLine(e.title, 120), start: e.start, ...(e.kind ? { kind: e.kind } : {}), source: e.create ? "created" : "matched", ...(e.milestone ? { milestone: e.milestone } : {}) });
    l.calendar.sort((a, b) => a.start.localeCompare(b.start));
    writeLinks(vault, m.slug, l);
  }
  return l;
}

const TRANSITIONS: Record<"pause" | "resume" | "archive" | "reopen", { from: MissionStatus[]; to: MissionStatus }> = {
  pause: { from: ["active"], to: "paused" },
  resume: { from: ["paused"], to: "active" },
  archive: { from: ["active", "paused", "completed"], to: "archived" },
  reopen: { from: ["completed", "archived"], to: "active" },
};

/** Pause, resume, archive or reopen. Completing goes through the close-out (closeout.ts). Nothing moves on disk. */
export function transition(vault: string, ref: string, op: keyof typeof TRANSITIONS, o: { target?: string; now?: number } = {}): MissionView {
  const now = o.now ?? Date.now();
  const m = readMission(vault, ref);
  if (!m) throw new Error(`no mission "${ref}"`);
  const t = TRANSITIONS[op];
  if (!t.from.includes(m.status)) throw new Error(`a ${m.status} mission cannot ${op}`);
  if (op === "reopen") {
    const dir = missionDir(vault, m.slug);
    const co = join(dir, "closeout.md");
    if (existsSync(co)) {
      let to = join(dir, `closeout-${m.completed || ymd(now)}.md`);
      for (let n = 2; existsSync(to); n++) to = join(dir, `closeout-${m.completed || ymd(now)}-${n}.md`);
      renameSync(co, to);
    }
    delete m.completed;
    delete m.result;
    if (o.target) { if (!isYmd(o.target)) throw new Error(`target must be YYYY-MM-DD`); m.target = o.target; }
  }
  m.status = t.to;
  save(vault, m, now);
  logLine(vault, m.slug, op === "pause" ? "Paused" : op === "resume" ? "Resumed" : op === "archive" ? "Archived" : `Reopened${o.target ? `, new target ${o.target}` : ""}`, now);
  return missionView(vault, m.slug, now)!;
}

// ── Migration: entity projects into missions ────────────────────────────────

export interface MigrateResult {
  ok: boolean; dryRun: boolean; backup?: string;
  migrated: { slug: string; from: string; files: number; conflict: boolean; threads: number }[];
  skipped: string[];
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p)); else out.push(p);
  }
  return out;
}
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

const stamp = (now: number) => { const d = new Date(now); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

/**
 * `prevail missions migrate`: every data/entities/projects/<slug>/ becomes
 * data/missions/<slug>/. Never deletes: a tar backup in ~ first, the old folder
 * moves to data/entities/_migrated/projects-<date>/<slug>/, an existing mission
 * is never overwritten (the incoming page goes beside it as mission.conflict.md),
 * and each mission gets a receipt with the hashes of what was carried.
 */
export function migrateProjects(vault: string, o: { dryRun?: boolean; now?: number; backupDir?: string; threadsOf?: (id: string) => { domain: string; slug: string; title: string }[] } = {}): MigrateResult {
  const now = o.now ?? Date.now();
  const res: MigrateResult = { ok: true, dryRun: !!o.dryRun, migrated: [], skipped: [] };
  const ents = join(dataRoot(vault), "entities");
  const src = join(ents, "projects");
  if (!existsSync(src)) return res;
  const slugs = readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(join(src, e.name, "entity.md"))).map((e) => e.name);
  // Flat pages from older vaults (projects/<slug>.md) are carried the same way.
  const flat = readdirSync(src, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name.replace(/\.md$/, ""));
  const all = [...new Set([...slugs, ...flat])];
  if (!all.length) return res;
  if (o.dryRun) {
    for (const s of all) res.migrated.push({ slug: missionSlugify(s), from: relative(vault, join(src, s)), files: filesUnder(join(src, s)).length || 1, conflict: existsSync(join(missionsRoot(vault), missionSlugify(s), "mission.md")), threads: 0 });
    return res;
  }
  const bdir = o.backupDir ?? homedir();
  const backup = join(bdir, `prevail-backup-entities-projects-${stamp(now)}.tar.gz`);
  const tar = spawnSync("tar", ["-czf", backup, "-C", ents, "projects"], { stdio: "ignore" });
  if (tar.status !== 0 || !existsSync(backup)) return { ...res, ok: false, skipped: all.map((s) => `${s}: backup failed, nothing moved`) };
  res.backup = backup;
  const day = ymd(now);
  const archive = join(ents, "_migrated", `projects-${day}`);
  for (const s of all) {
    const from = existsSync(join(src, s, "entity.md")) ? join(src, s) : join(src, `${s}.md`);
    const isDir = from === join(src, s);
    const page = readText(isDir ? join(from, "entity.md") : from);
    const slug = missionSlugify(s);
    if (!slug) { res.skipped.push(`${s}: no usable slug`); continue; }
    const fmm = /^---\n([\s\S]*?)\n---\n?/.exec(page);
    const f: Record<string, string> = {};
    if (fmm) for (const l of fmm[1]!.split("\n")) { const m = /^([a-z_]+):\s?(.*)$/.exec(l); if (m) f[m[1]!] = m[2]!.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"); }
    const body = fmm ? page.slice(fmm[0].length) : page;
    const list = (v?: string) => uniq((v ?? "").replace(/^\[|\]$/g, "").split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")));
    const doms = list(f.domains);
    const status = f.status === "done" ? "completed" : MISSION_STATUSES.includes(f.status as MissionStatus) ? (f.status as MissionStatus) : "active";
    const created = f.created || iso(now);
    const m: Mission = {
      slug, id: `mission/${slug}`, name: f.name || s, status, outcome: f.outcome ?? "", start: created.slice(0, 10),
      target: isYmd(f.target ?? "") ? f.target! : "", cadence: "weekly",
      domains: doms.map((d, i) => ({ slug: d.toLowerCase(), role: i === 0 ? "owner" : "consulted" })),
      apps: [], specialists: [], people: [], entities: [], budget: { lines: [] }, serves: [], metrics: [], match: {},
      prompt_projects: f.intent_project ? [f.intent_project] : [], repos: [], ceiling: "draft", nudges: { per_week: 1, muted: false },
      privacy: { localOnly: false }, created, updated: iso(now), why: "", notes: sectionOf(body, "Your notes"), rest: "",
      ...(status === "completed" ? { completed: (f.updated || iso(now)).slice(0, 10) } : {}),
    };
    const dir = join(missionsRoot(vault), slug);
    const conflict = existsSync(join(dir, "mission.md"));
    mkdirSync(join(dir, "memory", "threads"), { recursive: true });
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    if (!existsSync(join(dir, V4_MARKER))) writeText(join(dir, V4_MARKER), "1");
    writeText(join(dir, conflict ? "mission.conflict.md" : "mission.md"), serializeMission(m));
    const carried: { from: string; to: string; sha: string }[] = [];
    const carry = (a: string, b: string) => {
      if (!existsSync(a)) return;
      if (existsSync(b)) b = b.replace(/(\.[a-z0-9]+)?$/i, (x) => `.from-project${x}`);
      mkdirSync(join(b, ".."), { recursive: true });
      cpSync(a, b);
      carried.push({ from: relative(vault, a), to: relative(vault, b), sha: sha(b) });
    };
    if (isDir) {
      carry(join(from, "updates.jsonl"), join(dir, "memory", "updates.jsonl"));
      for (const p of filesUnder(join(from, "files"))) carry(p, join(dir, "files", relative(join(from, "files"), p)));
      for (const p of readdirSync(from)) if (/^picture\./.test(p)) carry(join(from, p), join(dir, "files", p));
    }
    const discussed = sectionOf(body, "What you've discussed");
    if (!conflict) {
      writeText(join(dir, "memory", "memory.md"), `# What this mission has learned\n${discussed ? `\n## From the old project page\n${discussed}\n` : ""}`);
      if (!existsSync(join(dir, "milestones.md"))) writeMilestones(vault, slug, []);
      if (!existsSync(join(dir, "memory", "state.md"))) writeText(join(dir, "memory", "state.md"), `# ${m.name}\n`);
    }
    const threads = (o.threadsOf?.(`project/${s}`) ?? []).map((t) => ({ domain: t.domain, thread: t.slug, title: t.title }));
    if (threads.length) {
      const l = readLinks(vault, slug);
      for (const t of threads) if (!l.threads.some((x) => x.thread === t.thread)) l.threads.push(t);
      writeLinks(vault, slug, l);
    } else if (!existsSync(join(dir, "links.json"))) writeLinks(vault, slug, EMPTY_LINKS);
    // The old folder moves aside, whole.
    const dest = join(archive, isDir ? s : `${s}.md`);
    mkdirSync(archive, { recursive: true });
    const before = isDir ? filesUnder(from).map((p) => ({ rel: relative(from, p), sha: sha(p) })) : [{ rel: `${s}.md`, sha: sha(from) }];
    renameSync(from, dest);
    writeText(join(dir, "memory", `migrated-${day}.md`), [
      `# Migrated from the project page (${day})`, "",
      `- From: ${relative(vault, from)}`, `- The old folder, unchanged: ${relative(vault, dest)}`, `- Backup: ${backup}`,
      `- Page: ${conflict ? "mission.conflict.md (a mission with this name already existed; nothing was overwritten)" : "mission.md"}`,
      `- Status ${f.status || "active"} became ${status}; domains ${doms.join(", ") || "none"} became owner ${doms[0] ?? "none"}${doms.length > 1 ? `, consulted ${doms.slice(1).join(", ")}` : ""}.`,
      ...(discussed ? ["- What you've discussed moved to memory/memory.md under \"From the old project page\"."] : []),
      ...(threads.length ? [`- ${threads.length} earlier chat(s) are listed in links.json (threads stay where they are).`] : []),
      "", "## Files carried (sha256)", ...carried.map((c) => `- ${c.to} from ${c.from} ${c.sha}`),
      "", "## The old folder (sha256)", ...before.map((b) => `- ${b.rel} ${b.sha}`), "",
    ].join("\n"));
    if (!conflict) logLine(vault, slug, `Migrated from the old project page ${relative(vault, from)}`, now);
    res.migrated.push({ slug, from: relative(vault, from), files: before.length, conflict, threads: threads.length });
  }
  try { if (!readdirSync(src).length) renameSync(src, join(archive, "_empty-projects-dir")); } catch { /* left in place */ }
  return res;
}

// ── The Compass statement is called Purpose ─────────────────────────────────

/** Rewrite `## Mission` in build/compass.md to `## Purpose` (the prior text kept in compass.versions/). */
export async function renamePurposeHeading(vault: string, now = Date.now()): Promise<{ renamed: boolean; snapshot?: string | null }> {
  const { compassPath } = await import("./compass.ts");
  const { writeVersioned } = await import("./goals.ts");
  const p = compassPath(vault);
  const t = readText(p);
  if (!/^##\s+Mission\s*$/m.test(t)) return { renamed: false };
  const snapshot = writeVersioned(p, t.replace(/^##\s+Mission\s*$/m, "## Purpose"), now);
  return { renamed: true, snapshot };
}

// ── The tasks a mission sees: its own board and ~mission:<slug> lines anywhere ─

export interface MissionTask { domain: string; text: string; done: boolean; due?: string; id?: string; own: boolean }
export function missionTasks(vault: string, ref: string): MissionTask[] {
  const m = readMission(vault, ref);
  if (!m) return [];
  const out: MissionTask[] = [];
  const read = (file: string, domain: string, own: boolean) => {
    for (const l of readText(file).split("\n")) {
      const x = /^\s*-\s+\[( |x|X)\]\s+(.+)$/.exec(l);
      if (!x) continue;
      if (!own && !new RegExp(`~mission:${m.slug}(\\s|$)`).test(x[2]!)) continue;
      const due = /\s@(\d{4}-\d{2}-\d{2})/.exec(x[2]!)?.[1];
      const id = /~id:(\S+)/.exec(x[2]!)?.[1];
      out.push({ domain, own, done: x[1] !== " ", text: x[2]!.replace(/\s+[~@+]\S+/g, "").trim(), ...(due ? { due } : {}), ...(id ? { id } : {}) });
    }
  };
  read(join(missionDir(vault, m.slug), "memory", "tasks.md"), m.id, true);
  for (const d of listDomainDirs(vault)) {
    const dir = resolveDomainDir(vault, d);
    for (const f of [join(dir, "memory", "tasks.md"), join(dir, "_tasks.md")]) if (existsSync(f)) read(f, d, false);
  }
  return out;
}

// ── Domain chat pointer ─────────────────────────────────────────────────────

/** One line per active mission the message names (or that this domain is part of), for a domain turn. */
export function missionPointer(vault: string, domain: string, message: string): string {
  const said = message.toLowerCase();
  const lines: string[] = [];
  for (const m of activeMissions(vault)) {
    const named = m.name.length > 3 && said.includes(m.name.toLowerCase());
    if (!named) continue;
    const next = readMilestones(vault, m.slug).filter((x) => !x.done).sort((a, b) => (a.due ?? "9").localeCompare(b.due ?? "9"))[0];
    lines.push(`Active mission: ${m.name} (mission/${m.slug})${next ? `, next: ${next.title}${next.due ? ` by ${next.due}` : ""}` : ""}${m.domains.some((d) => d.slug === domain) ? "" : ". This domain is not part of it."}`);
  }
  return lines.length ? `# ACTIVE MISSIONS\n${lines.join("\n")}` : "";
}

/** A few lines about one mission, for a chat that @-references it. */
export function missionBrief(vault: string, ref: string): string {
  const v = missionView(vault, ref);
  if (!v) return "";
  const p = v.progress;
  return [
    `# MISSION REFERENCED: ${v.name} (${v.id}), ${v.status}`,
    `Outcome: ${v.outcome || "not written"}. Target ${v.target || "none"}, ${p.days.left} days left.`,
    `Milestones ${p.milestones.done} of ${p.milestones.total}${p.milestones.next ? `; next: ${p.milestones.next.title}${p.milestones.next.due ? ` by ${p.milestones.next.due}` : ""}` : ""}.${p.budget.planned ? ` Budget $${p.budget.used} of $${p.budget.planned}.` : ""}`,
    `Domains: ${v.domains.map((d) => `${d.slug} (${d.role})`).join(", ") || "none"}.`,
  ].join("\n");
}

/** The mission an app event, charge or message belongs to, by its match rules (MS4 uses this). */
export function matchMission(vault: string, kind: keyof MissionMatch, text: string): Mission | null {
  const t = text.toLowerCase();
  return activeMissions(vault).find((m) => (m.match[kind] ?? []).some((p) => p && t.includes(p.toLowerCase()))) ?? null;
}
