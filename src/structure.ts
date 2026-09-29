// Structure suggestions: the vault's shape grows with the owner, but only on
// their yes. Three rules, all deterministic (no model call here; the touch
// step's classifier already did the reading):
//   domain          a topic with no home (unhomed.jsonl) in DOMAIN_AT+
//                   distinct conversations within WINDOW_DAYS
//   project         an Intent project with PROJECT_SITTINGS_AT+ sittings and no
//                   project entity, or an unhomed topic (same threshold) the
//                   classifier mostly marks as an effort with an outcome
//   archive_domain  a domain with no threads, touches or updates in DORMANT_DAYS
// Decisions persist in data/suggestions.json (synced):
//   { accepted: [id], dismissed: [{ id, until?(ms) }] }
// "Not now" dismisses for NOT_NOW_DAYS; "Never" has no until. Accepting
// creates through the existing paths (scaffoldDomain, createProject,
// archiveDomain) and never deletes anything.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { projectFields, slugify } from "./entities.ts";
import { tryAcquireLock } from "./file-lock.ts";
import { appendJsonl, domainUpdatesPath, readJsonl, readUnhomed, touchesPath, type DomainUpdate } from "./linking.ts";
import { dataRoot, resolveDomainDir } from "./path-safety.ts";
import { createProject, listProjectPages, type ProjectDetail } from "./projects.ts";
import { projectSittings, readProjectsIndex } from "./prompt-projects.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { vreadFile, vwriteFileAtomic } from "./vault-session.ts";

export type SuggestionKind = "domain" | "project" | "archive_domain";
export interface SuggestionEvidence { thread?: string; ts: number; domain: string }
export interface StructureSuggestion {
  id: string;
  kind: SuggestionKind;
  title: string;
  reason: string;
  evidence: SuggestionEvidence[];
  confidence: number;
}
/** A suggestion plus its checkable number, for the recommendations feed. */
export type RankedSuggestion = StructureSuggestion & { metric: { value: number; unit: string } };

export interface SuggestionsFile { accepted: string[]; dismissed: { id: string; until?: number }[] }

export const DOMAIN_AT = 3;
export const WINDOW_DAYS = 30;
export const PROJECT_SITTINGS_AT = 3;
export const DORMANT_DAYS = 365;
export const NOT_NOW_DAYS = 30;
const DAY = 864e5;
const MAX_EVIDENCE = 10;

const round2 = (n: number) => Math.round(n * 100) / 100;
const titleCase = (s: string) => s.split(/[-\s]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
const shortDate = (ts: number) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ── Decisions: data/suggestions.json ────────────────────────────────────

const decisionsPath = (vault: string) => join(dataRoot(vault), "suggestions.json");

export function readDecisions(vault: string): SuggestionsFile {
  let raw: Partial<SuggestionsFile> = {};
  try { raw = JSON.parse(vreadFile(decisionsPath(vault))) as Partial<SuggestionsFile>; } catch { /* none yet */ }
  return {
    accepted: Array.isArray(raw.accepted) ? raw.accepted.filter((x): x is string => typeof x === "string") : [],
    dismissed: Array.isArray(raw.dismissed)
      ? raw.dismissed.filter((d) => typeof d?.id === "string").map((d) => (Number.isFinite(d.until) ? { id: d.id, until: d.until } : { id: d.id }))
      : [],
  };
}

function updateDecisions(vault: string, fn: (d: SuggestionsFile) => void): void {
  const path = decisionsPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  const lock = tryAcquireLock(`${path}.lock`);
  try {
    const d = readDecisions(vault);
    fn(d);
    vwriteFileAtomic(path, `${JSON.stringify(d, null, 2)}\n`);
  } finally { lock?.release(); }
}

// ── The rules ───────────────────────────────────────────────────────────

const archivedDomain = (vault: string, slug: string) => existsSync(join(vault, "_archive", slug));

function fromUnhomed(vault: string, domains: Set<string>, projects: Set<string>, now: number): RankedSuggestion[] {
  const groups = new Map<string, { thread: string; ts: number; home: string; fact: string; effort?: boolean }[]>();
  for (const r of readUnhomed(vault)) {
    if (r.ts < now - WINDOW_DAYS * DAY || r.ts > now) continue;
    const label = slugify(r.label);
    if (!label) continue;
    (groups.get(label) ?? groups.set(label, []).get(label)!).push(r);
  }
  const out: RankedSuggestion[] = [];
  for (const [label, rows] of groups) {
    const newest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if ((newest.get(r.thread)?.ts ?? -1) < r.ts) newest.set(r.thread, r);
    const n = newest.size;
    if (n < DOMAIN_AT) continue;
    const effort = rows.filter((r) => r.effort).length * 2 > rows.length;
    if (effort ? projects.has(label) : domains.has(label) || archivedDomain(vault, label)) continue;
    const since = Math.min(...rows.map((r) => r.ts));
    const evidence = [...newest.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_EVIDENCE).map((r) => ({ thread: r.thread, ts: r.ts, domain: r.home }));
    const name = titleCase(label);
    out.push({
      id: effort ? `project:topic:${label}` : `domain:${label}`,
      kind: effort ? "project" : "domain",
      title: effort ? `Track ${name} as a project?` : `Create a ${name} domain?`,
      reason: `${plural(n, "conversation")} about ${label.replace(/-/g, " ")} since ${shortDate(since)}`,
      evidence, confidence: round2(Math.min(0.95, 0.4 + 0.1 * n)),
      metric: { value: n, unit: "conversations" },
    });
  }
  return out;
}

function fromIntent(vault: string, domains: Set<string>): RankedSuggestion[] {
  const idx = readProjectsIndex(vault);
  if (!idx) return [];
  const sittings = projectSittings(vault);
  const tracked = new Set<string>();
  for (const p of listProjectPages(vault)) {
    tracked.add(p.slug);
    const from = projectFields(p.doc).intent_project;
    if (from) tracked.add(from);
  }
  const out: RankedSuggestion[] = [];
  for (const p of idx.projects) {
    const n = sittings[p.slug] ?? 0;
    if (p.status === "done" || n < PROJECT_SITTINGS_AT || tracked.has(p.slug)) continue;
    out.push({
      id: `project:intent:${p.slug}`, kind: "project",
      title: `Track ${p.title} as a project?`,
      reason: `${plural(n, "sitting")} in your prompts since ${shortDate(p.first_ts)}`,
      evidence: [{ ts: p.last_ts, domain: domains.has(p.domain) ? p.domain : "general" }],
      confidence: round2(Math.min(0.9, 0.4 + 0.05 * n)),
      metric: { value: n, unit: "sittings" },
    });
  }
  return out;
}

/** The newest thread, touch or update in a domain; its creation time when it has none. */
export function lastActivity(vault: string, slug: string): number {
  const dir = resolveDomainDir(vault, slug);
  let last = 0;
  try { const st = statSync(dir); last = st.birthtimeMs || st.ctimeMs; } catch { return 0; }
  for (const sub of [join("memory", "threads"), "_threads"]) {
    let names: string[] = [];
    try { names = readdirSync(join(dir, sub)); } catch { continue; }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      try { last = Math.max(last, statSync(join(dir, sub, n)).mtimeMs); } catch { /* gone */ }
    }
  }
  for (const p of [touchesPath(vault, slug), domainUpdatesPath(vault, slug)]) {
    for (const r of readJsonl<{ ts: number }>(p)) if (Number.isFinite(r.ts)) last = Math.max(last, r.ts);
  }
  return Math.floor(last);
}

function fromDormant(vault: string, domains: string[], now: number): RankedSuggestion[] {
  const out: RankedSuggestion[] = [];
  for (const d of domains) {
    if (d.toLowerCase() === "general") continue;
    const last = lastActivity(vault, d);
    const days = Math.floor((now - last) / DAY);
    if (!last || days < DORMANT_DAYS) continue;
    out.push({
      id: `archive:${d}`, kind: "archive_domain",
      title: `Archive ${titleCase(d)}?`,
      reason: `No conversations, touches or updates in ${days} days (since ${new Date(last).toISOString().slice(0, 10)})`,
      evidence: [{ ts: last, domain: d }],
      confidence: days >= 2 * DORMANT_DAYS ? 0.8 : 0.6,
      metric: { value: days, unit: "days" },
    });
  }
  return out;
}

/** Ids the desktop accepts: letters, digits and - _ . : / only. */
export const SUGGESTION_ID_RE = /^[A-Za-z0-9_.:\/-]+$/;

/** Every suggestion the rules make now, before the owner's decisions. */
export function candidateSuggestions(vault: string, now = Date.now()): RankedSuggestion[] {
  const dirs = listDomainDirs(vault);
  const have = new Set(dirs.map((d) => d.toLowerCase()));
  const projects = new Set(listProjectPages(vault).map((p) => p.slug));
  return [...fromUnhomed(vault, have, projects, now), ...fromIntent(vault, have), ...fromDormant(vault, dirs, now)]
    .filter((s) => SUGGESTION_ID_RE.test(s.id))
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
}

/** The pending suggestions: minus accepted ones and live dismissals. */
export function suggestStructureRanked(vault: string, now = Date.now()): RankedSuggestion[] {
  const d = readDecisions(vault);
  const accepted = new Set(d.accepted);
  const hidden = new Set(d.dismissed.filter((x) => x.until === undefined || x.until > now).map((x) => x.id));
  return candidateSuggestions(vault, now).filter((s) => !accepted.has(s.id) && !hidden.has(s.id));
}

/** `prevail suggest structure --json` */
export function suggestStructure(vault: string, now = Date.now()): StructureSuggestion[] {
  return suggestStructureRanked(vault, now).map(({ metric: _m, ...s }) => s);
}

// ── Accept / dismiss ────────────────────────────────────────────────────

export type AcceptResult =
  | { ok: true; id: string; kind: "domain"; domain: string; path: string; backfilled: number }
  | { ok: true; id: string; kind: "project"; project: ProjectDetail }
  | { ok: true; id: string; kind: "archive_domain"; domain: string; archived_to: string; backup: string };

export async function acceptSuggestion(vault: string, id: string, o: { now?: number } = {}): Promise<AcceptResult> {
  const now = o.now ?? Date.now();
  const s = candidateSuggestions(vault, now).find((x) => x.id === id);
  if (!s) throw new Error(`no suggestion "${id}"`);
  let res: AcceptResult;
  if (s.kind === "domain") {
    const label = id.slice("domain:".length);
    const { scaffoldDomain } = await import("./domain-scaffold.ts");
    const r = scaffoldDomain(vault, label);
    if (!r.ok || !r.path) throw new Error(r.message);
    const slug = basename(r.path);
    // Backfill: every line the evidence conversations noted for this topic.
    const threads = new Set(s.evidence.map((e) => e.thread));
    let backfilled = 0;
    for (const u of readUnhomed(vault).sort((a, b) => a.ts - b.ts)) {
      if (slugify(u.label) !== label || !threads.has(u.thread)) continue;
      appendJsonl(domainUpdatesPath(vault, slug), { ts: u.ts, from_domain: u.home, thread: u.thread, fact: u.fact, entities: [] } satisfies DomainUpdate);
      backfilled++;
    }
    res = { ok: true, id, kind: "domain", domain: slug, path: r.path, backfilled };
  } else if (s.kind === "project") {
    let project: ProjectDetail;
    if (id.startsWith("project:intent:")) {
      const slug = id.slice("project:intent:".length);
      const p = readProjectsIndex(vault)?.projects.find((x) => x.slug === slug);
      if (!p) throw new Error(`no Intent project "${slug}"`);
      const domains = listDomainDirs(vault).map((d) => d.toLowerCase());
      project = createProject(vault, { name: p.title, domains: domains.includes(p.domain) ? [p.domain] : [], fromIntent: slug, now });
    } else {
      project = createProject(vault, { name: titleCase(id.slice("project:topic:".length)), now });
    }
    res = { ok: true, id, kind: "project", project };
  } else {
    const domain = id.slice("archive:".length);
    const { archiveDomain } = await import("./vault-ops.ts");
    const r = await archiveDomain(vault, domain);
    res = { ok: true, id, kind: "archive_domain", domain, archived_to: r.to, backup: r.backup.archivePath };
  }
  updateDecisions(vault, (d) => {
    if (!d.accepted.includes(id)) d.accepted.push(id);
    d.dismissed = d.dismissed.filter((x) => x.id !== id);
  });
  return res;
}

export function dismissSuggestion(vault: string, id: string, o: { forever?: boolean; now?: number } = {}): { ok: true; id: string; until?: number } {
  if (!id.trim()) throw new Error("no suggestion id");
  const entry = o.forever ? { id } : { id, until: (o.now ?? Date.now()) + NOT_NOW_DAYS * DAY };
  updateDecisions(vault, (d) => { d.dismissed = [...d.dismissed.filter((x) => x.id !== id), entry]; });
  return { ok: true, ...entry };
}

// ── CLI: prevail suggest structure | accept <id> | dismiss <id> [--forever] ──

export async function suggestCommand(a: string[], vault: string): Promise<number> {
  const json = a.includes("--json");
  const pos = a.filter((x, i) => !x.startsWith("--") && !(i > 0 && a[i - 1] === "--vault"));
  const [sub, id] = pos;
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (msg: string) => { if (json) out({ ok: false, error: msg }); else console.error(`prevail suggest: ${msg}`); return 1; };
  try {
    if (sub === "structure") {
      const rows = suggestStructure(vault);
      if (json) out(rows);
      else if (!rows.length) console.log("no structure suggestions");
      else for (const s of rows) console.log(`${s.id}  ${s.title}  (${s.reason})`);
      return 0;
    }
    if (sub === "accept" && id) {
      const r = await acceptSuggestion(vault, id);
      if (json) out(r);
      else console.log(`accepted ${id}`);
      return 0;
    }
    if (sub === "dismiss" && id) {
      const r = dismissSuggestion(vault, id, { forever: a.includes("--forever") });
      if (json) out(r);
      else console.log(r.until ? `dismissed ${id} until ${new Date(r.until).toISOString().slice(0, 10)}` : `dismissed ${id} for good`);
      return 0;
    }
  } catch (e) { return fail((e as Error).message); }
  return fail("usage: prevail suggest structure | accept <id> | dismiss <id> [--forever] --vault V --json");
}
