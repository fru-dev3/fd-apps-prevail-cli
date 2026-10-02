// Metrics from what the user already does: no data entry.
//
// SOURCES -> EVENTS -> METRICS -> the weekly glance.
//
// Events are content-free facts, one line per day, source, kind and project:
//   { ts: "YYYY-MM-DD", src, kind, n, project?, host, tier, attrs }
// Two kinds of source:
//   - machine sources live on one Mac (AI tools' records, git repos). Each
//     host writes its own files, build/_meta/events/<src>/<YYYY-MM>.<host>.jsonl,
//     rewriting the current and previous month (a backfill also writes older
//     months that have no file yet). Readers merge every host. `prevail ai
//     scan` writes the AI ones; `prevail metrics scan` (and every capture
//     sync) writes git.
//   - vault sources are files already in the vault (task boards, loop runs,
//     decisions, the prompt capture, trip atlases, watch-history scrapes,
//     card statement CSVs). They are read into events when metrics are
//     computed, never copied into a second store, so two Macs can never
//     disagree about them or double count them.
// Metrics are definitions over events (the catalog below), with an honesty
// tier (measured, derived) and coverage. Daily points go to
// build/_meta/metrics/<id>.jsonl; the source registry to build/_meta/sources.json.
// build/metrics.md is the registry the user can read and edit (Pinned,
// Tracking, Paused, Retired); it is written once with the catalog under
// Tracking, and unknown lines are kept.
//
// Nothing here reads message bodies, prompt text or page text: counts only
// (the prompt metric counts the filtered prompt corpus; no text leaves it).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join, relative } from "node:path";
import { buildRoot, dataRoot, runtimePath } from "./path-safety.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { parseModArgs } from "./cli-args.ts";

export interface MetricEvent {
  ts: string;
  src: string;
  kind: string;
  n: number;
  project?: string;
  model?: string;
  host: string;
  tier: "measured" | "derived" | "asked" | "inferred";
  attrs: Record<string, number | string>;
  file?: string;           // where it was read from (vault-relative); never written
}

const pad = (n: number) => String(n).padStart(2, "0");
export const dayOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthOf = (day: string) => day.slice(0, 7);
export function hostSlug(): string { return hostname().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "host"; }

function readText(p: string): string {
  try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } }
}

export function eventsRoot(vault: string): string { return join(runtimePath(vault, "_meta"), "events"); }
export function metricsDir(vault: string): string { return join(runtimePath(vault, "_meta"), "metrics"); }

// ── Machine source: git ─────────────────────────────────────────────────────

/** Folders that hold the user's repos, searched to a small depth. */
export function defaultGitRoots(home = homedir()): string[] {
  return ["Documents", "Developer", "code", "src", "projects", "repos", "work"].map((d) => join(home, d)).filter((p) => existsSync(p));
}

export function findRepos(roots: string[], depth = 3, max = 400): string[] {
  const out: string[] = [];
  const walk = (dir: string, left: number) => {
    if (out.length >= max) return;
    let es: string[] = [];
    try { es = readdirSync(dir); } catch { return; }
    if (es.includes(".git")) { out.push(dir); return; }
    if (left <= 0) return;
    for (const e of es) {
      if (e.startsWith(".") || e === "node_modules" || e === "Library" || e.startsWith("_")) continue;
      const p = join(dir, e);
      try { if (statSync(p).isDirectory()) walk(p, left - 1); } catch { /* skip */ }
    }
  };
  for (const r of roots) walk(r, depth);
  return out;
}

const AI_TRAILER = /(claude|anthropic|codex|openai|copilot|gemini|cursor|aider|devin)/i;
const git = (repo: string, args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });

/** One repo's commits by the user and its tags since `since`, as daily events. */
export function gitRepoEvents(repo: string, since: string, identities: Set<string>, host: string): MetricEvent[] {
  const project = basename(repo);
  const by = new Map<string, MetricEvent & { _h: number[] }>();
  const add = (day: string, kind: string, f: (e: MetricEvent & { _h: number[] }) => void) => {
    const k = `${day}\t${kind}`;
    let e = by.get(k);
    if (!e) { e = { ts: day, src: "git", kind, n: 0, project, host, tier: "measured", attrs: {}, _h: [] }; by.set(k, e); }
    f(e);
  };
  let local = "";
  try { local = git(repo, ["config", "user.email"]).trim().toLowerCase(); } catch { /* none */ }
  const mine = new Set([...identities, ...(local ? [local] : [])]);
  let log = "";
  try { log = git(repo, ["log", "--all", "--no-merges", `--since=${since}`, "--format=%H%x1f%ae%x1f%at%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x2C)%x1e"]); } catch { log = ""; }
  const seen = new Set<string>();
  for (const rec of log.split("\x1e")) {
    const [hash, email, at, trailers] = rec.trim().split("\x1f");
    if (!hash || seen.has(hash) || !mine.has((email ?? "").toLowerCase())) continue;
    seen.add(hash);
    const ms = Number(at) * 1000;
    if (!Number.isFinite(ms)) continue;
    add(dayOf(ms), "git.commit", (e) => {
      e.n += 1;
      if (AI_TRAILER.test(trailers ?? "")) e.attrs.ai = Number(e.attrs.ai ?? 0) + 1;
      e._h.push(new Date(ms).getHours());
    });
  }
  let tags = "";
  try { tags = git(repo, ["for-each-ref", "refs/tags", "--format=%(creatordate:unix)"]); } catch { tags = ""; }
  const sinceMs = Date.parse(since);
  for (const t of tags.split("\n")) {
    const ms = Number(t.trim()) * 1000;
    if (!ms || ms < sinceMs) continue;
    add(dayOf(ms), "git.tag", (e) => { e.n += 1; });
  }
  return [...by.values()].map(({ _h, ...e }) => (_h.length ? { ...e, attrs: { ...e.attrs, hours: _h.join(",") } } : e));
}

function gitIdentities(): Set<string> {
  const ids = new Set<string>();
  try { const g = execFileSync("git", ["config", "--global", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().toLowerCase(); if (g) ids.add(g); } catch { /* none */ }
  return ids;
}

function writeHostMonths(dir: string, events: MetricEvent[], host: string, months: Set<string>, backfill: boolean): number {
  let written = 0;
  const all = new Set(events.map((e) => monthOf(e.ts)));
  for (const m of all) if (backfill && !existsSync(join(dir, `${m}.${host}.jsonl`))) months.add(m);
  for (const m of months) {
    const rows = events.filter((e) => monthOf(e.ts) === m).sort((a, b) => a.ts.localeCompare(b.ts) || (a.project ?? "").localeCompare(b.project ?? ""));
    const file = join(dir, `${m}.${host}.jsonl`);
    if (!rows.length && !existsSync(file)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, rows.map((e) => JSON.stringify(e)).join("\n") + (rows.length ? "\n" : ""));
    renameSync(`${file}.tmp`, file);
    written += rows.length;
  }
  return written;
}

function recentMonths(now: number): Set<string> {
  const d = new Date(now);
  const p = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return new Set([`${p.getFullYear()}-${pad(p.getMonth() + 1)}`, `${d.getFullYear()}-${pad(d.getMonth() + 1)}`]);
}

export interface GitScan { host: string; repos: number; events: number; ms: number }

/** Scan this Mac's repos into build/_meta/events/git/<YYYY-MM>.<host>.jsonl. */
export function scanGit(vault: string, opts: { roots?: string[]; host?: string; now?: number; backfill?: boolean; identities?: string[] } = {}): GitScan {
  const t0 = Date.now();
  const now = opts.now ?? Date.now();
  const host = opts.host ?? hostSlug();
  const repos = findRepos(opts.roots ?? defaultGitRoots());
  const backfill = !!opts.backfill;
  // Recent months by default; a backfill reads twelve.
  const sinceDate = new Date(now);
  sinceDate.setMonth(sinceDate.getMonth() - (backfill ? 12 : 1), 1);
  const since = dayOf(sinceDate.getTime());
  const ids = opts.identities ? new Set(opts.identities.map((x) => x.toLowerCase())) : gitIdentities();
  const events = repos.flatMap((r) => gitRepoEvents(r, since, ids, host));
  const written = writeHostMonths(join(eventsRoot(vault), "git"), events, host, recentMonths(now), backfill);
  return { host, repos: repos.length, events: written, ms: Date.now() - t0 };
}

// ── Reading machine events (every host) ─────────────────────────────────────

/** Events that stay on this Mac (sources marked local-only): never synced. */
export function localEventsRoot(vault: string): string { return join(runtimePath(vault, "_meta"), "events-local"); }

export function readMachineEvents(vault: string, fromDay: string): { events: MetricEvent[]; files: Record<string, string[]> } {
  const events: MetricEvent[] = [];
  const files: Record<string, string[]> = {};
  const fromMonth = fromDay.slice(0, 7);
  for (const root of [eventsRoot(vault), localEventsRoot(vault)]) {
  let srcs: string[] = [];
  try { srcs = readdirSync(root); } catch { continue; }
  for (const src of srcs) {
    let fs: string[] = [];
    try { fs = readdirSync(join(root, src)).filter((f) => f.endsWith(".jsonl") && f.slice(0, 7) >= fromMonth); } catch { continue; }
    for (const f of fs) {
      (files[src] ??= []).push(relative(vault, join(root, src, f)));
      for (const l of readText(join(root, src, f)).split("\n")) {
        if (!l) continue;
        try { const e = JSON.parse(l) as MetricEvent; if (e.ts >= fromDay) events.push({ ...e, src: e.src || src, file: relative(vault, join(root, src, f)) }); } catch { /* skip */ }
      }
    }
  }
  }
  return { events, files };
}

// ── Vault sources (read in place) ───────────────────────────────────────────

export interface SourceInfo { id: string; kind: "machine" | "vault"; files: string[]; first?: string; last?: string; events: number; note?: string; hosts?: string[] }

const CLOSED = /(?:~closed:|\+closed-)(\d{4}-\d{2}-\d{2})/;

function domainDirs(vault: string): string[] {
  return listDomainDirs(vault).map((d) => join(dataRoot(vault), "domains", d)).filter((p) => existsSync(p));
}

export function taskEvents(vault: string): { events: MetricEvent[]; info: SourceInfo } {
  const events: MetricEvent[] = [];
  const files: string[] = [];
  let undated = 0;
  for (const dir of domainDirs(vault)) {
    for (const f of ["memory/tasks.md", "_tasks.md"]) {
      const p = join(dir, f);
      if (!existsSync(p)) continue;
      let hit = false;
      for (const l of readText(p).split("\n")) {
        if (!/^- \[[xX]\]/.test(l)) continue;
        const m = CLOSED.exec(l);
        if (!m) { undated++; continue; }
        hit = true;
        events.push({ ts: m[1]!, src: "tasks", kind: "task.done", n: 1, project: basename(dir), host: "vault", tier: "measured", attrs: {}, file: relative(vault, p) });
      }
      if (hit) files.push(relative(vault, p));
    }
  }
  return { events, info: { id: "tasks", kind: "vault", files, events: events.length, note: undated ? `${undated} done tasks carry no date and are not counted` : undefined } };
}

export function loopEvents(vault: string): { events: MetricEvent[]; info: SourceInfo } {
  const events: MetricEvent[] = [];
  const files: string[] = [];
  for (const dir of domainDirs(vault)) {
    const p = join(dir, "_loops_runtime.json");
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readText(p)) as { loops?: Record<string, { history?: { ts?: number }[] }> };
      for (const [, v] of Object.entries(j.loops ?? {})) for (const h of v.history ?? []) {
        if (typeof h.ts === "number") events.push({ ts: dayOf(h.ts), src: "loops", kind: "loop.run", n: 1, project: basename(dir), host: "vault", tier: "measured", attrs: {}, file: relative(vault, p) });
      }
      files.push(relative(vault, p));
    } catch { /* skip */ }
  }
  return { events, info: { id: "loops", kind: "vault", files, events: events.length, note: "each loop keeps its last few runs only" } };
}

export function decisionEvents(vault: string): { events: MetricEvent[]; info: SourceInfo } {
  const events: MetricEvent[] = [];
  const files: string[] = [];
  for (const dir of domainDirs(vault)) {
    const p = join(dir, "memory", "decisions.jsonl");
    if (!existsSync(p)) continue;
    for (const l of readText(p).split("\n")) {
      if (!l) continue;
      try { const d = JSON.parse(l) as { ts?: number | string }; const ms = typeof d.ts === "number" ? d.ts : Date.parse(String(d.ts)); if (Number.isFinite(ms)) events.push({ ts: dayOf(ms), src: "decisions", kind: "decision.made", n: 1, project: basename(dir), host: "vault", tier: "measured", attrs: {}, file: relative(vault, p) }); } catch { /* skip */ }
    }
    files.push(relative(vault, p));
  }
  return { events, info: { id: "decisions", kind: "vault", files, events: events.length } };
}

/** The user's own prompts to AI tools (the filtered capture corpus), counted per day and tool; hours kept for the rhythm plot. */
export async function promptEvents(vault: string, home = homedir()): Promise<{ events: MetricEvent[]; info: SourceInfo; times: number[] }> {
  const { loadCorpus } = await import("./prompt-corpus.ts");
  const { prompts } = loadCorpus(vault, home);
  const by = new Map<string, MetricEvent>();
  const times: number[] = [];
  for (const p of prompts) {
    times.push(p.ts);
    const k = `${dayOf(p.ts)}\t${p.tool}`;
    const e = by.get(k) ?? { ts: dayOf(p.ts), src: "capture", kind: "ai.prompt", n: 0, project: p.tool, host: "vault", tier: "measured" as const, attrs: {}, file: relative(vault, join(runtimePath(vault, "_meta"), "prompts")) + `/${p.tool}*.jsonl` };
    e.n += 1;
    by.set(k, e);
  }
  const dir = join(runtimePath(vault, "_meta"), "prompts");
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => relative(vault, join(dir, f))); } catch { /* none */ }
  return { events: [...by.values()], info: { id: "prompts", kind: "vault", files, events: prompts.length, note: "your own prompts only: agent, classifier and demo prompts are filtered out" }, times };
}

interface TripRec { date?: string; kind?: string; verdict?: string; date_suspect?: boolean; region?: string; activity?: string; display?: string; published?: boolean }

/** Trip atlases: any skill folder holding a trips.json of dated trips. */
export function tripEvents(vault: string): { events: MetricEvent[]; info: SourceInfo; trips: { date: string; region: string; activity: string; file: string }[] } {
  const events: MetricEvent[] = [];
  const files: string[] = [];
  const trips: { date: string; region: string; activity: string; file: string }[] = [];
  let scanned = "";
  for (const dir of domainDirs(vault)) {
    const sk = join(dir, "memory", "skills");
    let ids: string[] = [];
    try { ids = readdirSync(sk); } catch { continue; }
    for (const id of ids) {
      const p = join(sk, id, "trips.json");
      if (!existsSync(p)) continue;
      try {
        const j = JSON.parse(readText(p)) as { trips?: TripRec[]; scan_date?: string; generated?: string };
        if (!Array.isArray(j.trips)) continue;
        const rel = relative(vault, p);
        files.push(rel);
        scanned = j.scan_date ?? j.generated ?? scanned;
        for (const t of j.trips) {
          if (t.kind !== "trip" || t.date_suspect || t.verdict === "EMPTY" || !/^\d{4}-\d{2}-\d{2}$/.test(t.date ?? "")) continue;
          events.push({ ts: t.date!, src: "trips", kind: "trip.activity", n: 1, host: "vault", tier: "measured", attrs: { region: (t.region ?? "").replace(/\s*\(Narrated\)\s*/, "").slice(0, 60) }, file: rel });
          trips.push({ date: t.date!, region: (t.region ?? "").replace(/\s*\(Narrated\)\s*/, ""), activity: t.activity ?? "", file: rel });
        }
      } catch { /* skip */ }
    }
  }
  return { events, info: { id: "trips", kind: "vault", files, events: events.length, note: scanned ? `trip atlas scanned ${String(scanned).slice(0, 10)}` : undefined }, trips };
}

/** Watch-history scrapes: per scrape day, unique videos and minutes (the scrapes overlap, so videos count once). */
export function watchEvents(vault: string): { events: MetricEvent[]; info: SourceInfo } {
  const events: MetricEvent[] = [];
  const files: string[] = [];
  const seen = new Set<string>();
  for (const dir of domainDirs(vault)) {
    const raw = join(dir, "source", "files", "watch-history", "raw");
    let days: string[] = [];
    try { days = readdirSync(raw).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); } catch { continue; }
    files.push(relative(vault, raw));
    for (const day of days) {
      let n = 0;
      let secs = 0;
      let fs: string[] = [];
      try { fs = readdirSync(join(raw, day)).filter((f) => f.endsWith(".json") && !f.startsWith("_")); } catch { continue; }
      for (const f of fs) {
        try {
          const j = JSON.parse(readText(join(raw, day, f))) as { videos?: { video_id?: string; duration_s?: number }[] };
          for (const v of j.videos ?? []) {
            if (!v.video_id || seen.has(v.video_id)) continue;
            seen.add(v.video_id);
            n++;
            secs += typeof v.duration_s === "number" ? v.duration_s : 0;
          }
        } catch { /* skip */ }
      }
      if (n) events.push({ ts: day, src: "watch", kind: "watch.video", n, host: "vault", tier: "measured", attrs: { minutes: Math.round(secs / 60) }, file: relative(vault, join(raw, day)) });
    }
  }
  return { events, info: { id: "watch", kind: "vault", files, events: events.length, note: "occasional scrapes of watch history, not a continuous record" } };
}

export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "";
    let q = false;
    for (const ch of line) {
      if (ch === "\"") q = !q;
      else if (ch === "," && !q) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}
export const mdy = (s: string) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };

/** Card statement CSVs in app folders: spend per day and category. Merchant names are read and dropped. */
export function spendEvents(vault: string): { events: MetricEvent[]; info: SourceInfo } {
  const by = new Map<string, MetricEvent>();
  const files: string[] = [];
  const apps = join(dataRoot(vault), "apps");
  let ids: string[] = [];
  try { ids = readdirSync(apps); } catch { ids = []; }
  let cur = "";
  const add = (day: string, cat: string, usd: number) => {
    const k = `${day}\t${cat}\t${cur}`;
    const e = by.get(k) ?? { ts: day, src: "spend", kind: "money.spend", n: 0, project: cat, host: "vault", tier: "measured" as const, attrs: { usd: 0 }, file: cur };
    e.n += 1;
    e.attrs.usd = Math.round((Number(e.attrs.usd) + usd) * 100) / 100;
    by.set(k, e);
  };
  for (const id of ids) {
    if (id.startsWith("_")) continue;
    let fs: string[] = [];
    try { fs = readdirSync(join(apps, id)).filter((f) => /\.csv$/i.test(f)); } catch { continue; }
    for (const f of fs) {
      const p = join(apps, id, f);
      cur = relative(vault, p);
      const rows = csvRows(readText(p));
      const head = (rows[0] ?? []).map((h) => h.toLowerCase());
      const col = (name: string) => head.indexOf(name);
      let used = false;
      if (col("transaction date") >= 0 && col("amount") >= 0 && col("type") >= 0) {
        for (const r of rows.slice(1)) {
          const day = mdy(r[col("transaction date")] ?? "");
          const amt = Number(r[col("amount")]);
          if (!day || !Number.isFinite(amt) || (r[col("type")] ?? "").toLowerCase() !== "sale" || amt >= 0) continue;
          add(day, (r[col("category")] || "uncategorized").toLowerCase(), -amt);
          used = true;
        }
      } else if (head.join(",") === "date,description,amount") {
        for (const r of rows.slice(1)) {
          const day = mdy(r[0] ?? "");
          const amt = Number(r[2]);
          if (!day || !Number.isFinite(amt) || amt <= 0 || /payment/i.test(r[1] ?? "")) continue;
          add(day, "uncategorized", amt);
          used = true;
        }
      }
      if (used) files.push(relative(vault, p));
    }
  }
  const events = [...by.values()];
  return { events, info: { id: "spend", kind: "vault", files, events: events.reduce((a, e) => a + e.n, 0), note: files.length ? "card statements exported by hand; only the dates they cover" : undefined } };
}

// ── The catalog ─────────────────────────────────────────────────────────────

export type Per = "week" | "month";
export interface MetricDef {
  id: string; title: string; family: string; per: Per; unit: "count" | "usd" | "tokens" | "minutes" | "days" | "score" | "km" | "mi" | "hours";
  tier: "measured" | "derived" | "asked" | "inferred"; srcs: string[]; kinds: string[]; from: string;
  value?: (e: MetricEvent) => number; days?: boolean; documentary?: boolean;
  /** A week's value is the average of its days (a 1-5 check-in), not the sum. */
  avg?: boolean;
  /** Count distinct projects (people, places) a week, not events. */
  distinct?: boolean;
  /** Learned from the user (a metrics.md line with ~kind:), not built in. */
  learned?: boolean;
  /** A mission's metric (~mission:<slug>): only events carrying attrs.mission === slug count. */
  mission?: string;
}

const usdApi = (e: MetricEvent) => Number(e.attrs.usd_api ?? 0);
const tokens = (e: MetricEvent) => ["in", "out", "cache_read", "cache_write", "cache_write_1h"].reduce((a, k) => a + Number(e.attrs[k] ?? 0), 0);

export const CATALOG: MetricDef[] = [
  { id: "m-ai-spend", title: "AI spend", family: "AI and building", per: "week", unit: "usd", tier: "measured", srcs: ["*"], kinds: ["ai.tokens"], value: usdApi, from: "every AI tool's own records, priced at API rates (not what you pay)" },
  { id: "m-ai-tokens", title: "AI tokens", family: "AI and building", per: "week", unit: "tokens", tier: "measured", srcs: ["*"], kinds: ["ai.tokens"], value: tokens, from: "every AI tool's own records" },
  { id: "m-ai-sessions", title: "AI sessions", family: "AI and building", per: "week", unit: "count", tier: "measured", srcs: ["*"], kinds: ["ai.session"], from: "every AI tool's own records" },
  { id: "m-prompts", title: "Prompts you wrote", family: "AI and building", per: "week", unit: "count", tier: "measured", srcs: ["capture"], kinds: ["ai.prompt"], from: "the prompt capture, your own prompts only" },
  { id: "m-commits", title: "Commits", family: "AI and building", per: "week", unit: "count", tier: "measured", srcs: ["git"], kinds: ["git.commit"], from: "git, commits you authored, on every Mac that scans" },
  { id: "m-ai-commits", title: "AI-assisted commits", family: "AI and building", per: "week", unit: "count", tier: "derived", srcs: ["git"], kinds: ["git.commit"], value: (e) => Number(e.attrs.ai ?? 0), from: "git commits with an AI co-author trailer" },
  { id: "m-coding-days", title: "Active coding days", family: "AI and building", per: "week", unit: "days", tier: "derived", srcs: ["git"], kinds: ["git.commit"], days: true, from: "days with at least one commit" },
  { id: "m-shipped", title: "Things shipped", family: "AI and building", per: "week", unit: "count", tier: "derived", srcs: ["git"], kinds: ["git.tag"], from: "release tags in your repos (deploys without a tag are not counted yet)" },
  { id: "m-tasks-done", title: "Tasks done", family: "Prevail itself", per: "week", unit: "count", tier: "measured", srcs: ["tasks"], kinds: ["task.done"], from: "done tasks with a closed date, every domain's board" },
  { id: "m-loop-runs", title: "Loop runs", family: "Prevail itself", per: "week", unit: "count", tier: "measured", srcs: ["loops"], kinds: ["loop.run"], from: "each domain's loop run history" },
  { id: "m-decisions", title: "Decisions recorded", family: "Prevail itself", per: "week", unit: "count", tier: "measured", srcs: ["decisions"], kinds: ["decision.made"], from: "each domain's decisions.jsonl" },
  { id: "m-trips", title: "Trips", family: "Exploration", per: "month", unit: "count", tier: "measured", srcs: ["trips"], kinds: ["trip.activity"], documentary: true, from: "the trip atlas (dated trip folders)" },
  { id: "m-watch-minutes", title: "Watch time", family: "Learning and attention", per: "week", unit: "minutes", tier: "measured", srcs: ["watch"], kinds: ["watch.video"], value: (e) => Number(e.attrs.minutes ?? 0), from: "watch-history scrapes" },
  { id: "m-spend", title: "Card spend", family: "Money", per: "week", unit: "usd", tier: "measured", srcs: ["spend"], kinds: ["money.spend"], value: (e) => Number(e.attrs.usd ?? 0), from: "card statement exports in your app folders" },
  { id: "m-screen-minutes", title: "Screen time", family: "Time", per: "week", unit: "minutes", tier: "measured", srcs: ["apps"], kinds: ["app.focus"], value: (e) => Number(e.attrs.minutes ?? 0), from: "minutes per app in front, from Screen Time or Prevail's live focus (Mac and iPhone)" },
  { id: "m-phone-minutes", title: "Phone screen time", family: "Time", per: "week", unit: "minutes", tier: "measured", srcs: ["apps"], kinds: ["app.focus"], value: (e) => (e.attrs.device && e.attrs.device !== "mac" ? Number(e.attrs.minutes ?? 0) : 0), from: "Screen Time minutes synced from the iPhone (Screen Time sharing on)" },
  { id: "m-web-visits", title: "Web visits", family: "Learning and attention", per: "week", unit: "count", tier: "measured", srcs: ["web"], kinds: ["web.visits"], from: "visits per website domain from your browsers (no addresses; health, finance, adult and dating never counted)" },
  { id: "m-emails-sent", title: "Emails sent", family: "Communication and people", per: "week", unit: "count", tier: "measured", srcs: ["gmail"], kinds: ["email.sent"], from: "Gmail headers: messages you sent" },
  { id: "m-email-replies", title: "Replies received", family: "Communication and people", per: "week", unit: "count", tier: "measured", srcs: ["gmail"], kinds: ["email.reply"], from: "Gmail headers: answers to threads you wrote in" },
  { id: "m-reply-time", title: "Your reply time", family: "Communication and people", per: "week", unit: "minutes", tier: "derived", srcs: ["gmail"], kinds: ["email.replied"], value: (e) => Number(e.attrs.minutes ?? 0), avg: true, from: "Gmail headers: minutes from their message to your answer, averaged per day" },
  { id: "m-email-people", title: "People you emailed with", family: "Communication and people", per: "week", unit: "count", tier: "derived", srcs: ["gmail"], kinds: ["email.person"], distinct: true, from: "Gmail headers: distinct people (hashed), personal mail only" },
  { id: "m-job-apps", title: "Job applications", family: "Communication and people", per: "week", unit: "count", tier: "inferred", srcs: ["gmail"], kinds: ["email.job_application"], from: "Gmail headers: mail to hiring systems and their confirmations (inferred)" },
  { id: "m-messages", title: "Messages", family: "Communication and people", per: "week", unit: "count", tier: "measured", srcs: ["messages"], kinds: ["msg.sent", "msg.received"], from: "Messages on this Mac, counts only (stays on this Mac)" },
  { id: "m-calls", title: "Calls", family: "Communication and people", per: "week", unit: "count", tier: "measured", srcs: ["calls"], kinds: ["call.made"], from: "call history on this Mac, counts only (stays on this Mac)" },
  { id: "m-meeting-hours", title: "Meeting hours", family: "Time", per: "week", unit: "hours", tier: "measured", srcs: ["calendar"], kinds: ["cal.meeting"], value: (e) => Number(e.attrs.hours ?? 0), from: "calendar events with at least one other person, not declined" },
  { id: "m-focus-hours", title: "Focus hours", family: "Time", per: "week", unit: "hours", tier: "derived", srcs: ["calendar"], kinds: ["cal.focus"], value: (e) => Number(e.attrs.hours ?? 0), from: "focus-time blocks on your calendar" },
  { id: "m-after-hours", title: "After-hours meetings", family: "Time", per: "week", unit: "hours", tier: "derived", srcs: ["calendar"], kinds: ["cal.after_hours"], value: (e) => Number(e.attrs.hours ?? 0), from: "meetings before 8:00, after 18:00 or on weekends" },
  { id: "m-family-hours", title: "Family time on the calendar", family: "Time", per: "week", unit: "hours", tier: "inferred", srcs: ["calendar"], kinds: ["cal.family"], value: (e) => Number(e.attrs.hours ?? 0), documentary: true, from: "calendar events whose title or calendar names family (inferred)" },
  { id: "m-prs-merged", title: "Pull requests merged", family: "AI and building", per: "week", unit: "count", tier: "measured", srcs: ["github"], kinds: ["gh.pr_merged"], from: "GitHub: your pull requests merged" },
  { id: "m-videos", title: "Videos published", family: "Creating and publishing", per: "month", unit: "count", tier: "measured", srcs: ["youtube"], kinds: ["yt.published"], from: "YouTube: videos published on your channel" },
  { id: "m-yt-views", title: "Channel views", family: "Creating and publishing", per: "week", unit: "count", tier: "measured", srcs: ["youtube"], kinds: ["yt.views"], from: "YouTube Analytics: daily views" },
  { id: "m-subscribers", title: "Subscribers gained", family: "Creating and publishing", per: "week", unit: "count", tier: "measured", srcs: ["youtube"], kinds: ["yt.subscribers"], value: (e) => Number(e.attrs.net ?? 0), from: "YouTube Analytics: subscribers gained minus lost" },
  { id: "m-sleep", title: "Sleep", family: "Health", per: "week", unit: "hours", tier: "measured", srcs: ["apple-health", "oura"], kinds: ["health.sleep"], value: (e) => Number(e.attrs.hours ?? 0), avg: true, from: "Apple Health export or Oura: hours asleep a night, averaged" },
  { id: "m-steps", title: "Steps a day", family: "Health", per: "week", unit: "count", tier: "measured", srcs: ["apple-health", "oura"], kinds: ["health.steps"], value: (e) => Number(e.attrs.steps ?? 0), avg: true, from: "Apple Health export or Oura: steps a day, averaged" },
  { id: "m-workouts", title: "Workouts", family: "Health", per: "week", unit: "count", tier: "measured", srcs: ["apple-health", "strava", "garmin"], kinds: ["health.workout"], from: "Apple Health, Strava or Garmin workouts" },
  { id: "m-rhr", title: "Resting heart rate", family: "Health", per: "week", unit: "count", tier: "measured", srcs: ["apple-health"], kinds: ["health.rhr"], value: (e) => Number(e.attrs.bpm ?? 0), avg: true, from: "Apple Health export, beats a minute" },
  { id: "m-new-places", title: "New places", family: "Exploration", per: "month", unit: "count", tier: "derived", srcs: ["timeline"], kinds: ["place.new"], documentary: true, from: "Timeline export: places you had not been before" },
  { id: "m-days-away", title: "Days away", family: "Exploration", per: "month", unit: "days", tier: "derived", srcs: ["timeline"], kinds: ["day.away"], days: true, documentary: true, from: "Timeline export: days with no stop near home" },
  { id: "m-photo-days", title: "Photo days", family: "Exploration", per: "month", unit: "days", tier: "measured", srcs: ["photos"], kinds: ["photo.taken"], days: true, documentary: true, from: "Apple Photos: days you took photos (stays on this Mac)" },
  { id: "m-subscriptions", title: "Subscriptions paid", family: "Money", per: "month", unit: "usd", tier: "measured", srcs: ["charges", "plaid"], kinds: ["money.charge"], value: (e) => Number(e.attrs.usd ?? 0), from: "recurring charges matched to your apps (card statements, Plaid)" },
  { id: "m-ladder-now", title: "Life ladder, now", family: "Inner life", per: "month", unit: "score", tier: "asked", srcs: ["checkins"], kinds: ["checkin.ladder"], value: (e) => Number(e.attrs.now ?? 0), avg: true, from: "your quarterly life ladder, 0 to 10" },
  { id: "m-ladder-future", title: "Life ladder, in five years", family: "Inner life", per: "month", unit: "score", tier: "asked", srcs: ["checkins"], kinds: ["checkin.ladder"], value: (e) => Number(e.attrs.future ?? 0), avg: true, from: "your quarterly life ladder, 0 to 10" },
  { id: "m-who5", title: "Wellbeing (WHO-5)", family: "Inner life", per: "month", unit: "score", tier: "asked", srcs: ["checkins"], kinds: ["checkin.who5"], value: (e) => Number(e.attrs.score ?? 0), avg: true, from: "the optional monthly WHO-5, 0 to 100" },
  { id: "m-calm", title: "Weekly calm", family: "Inner life", per: "week", unit: "score", tier: "asked", srcs: ["checkins"], kinds: ["checkin.calm"], value: (e) => Number(e.attrs.calm ?? 0), avg: true, from: "your weekly 1-5 check-in" },
];

// The AI tools' own event folders (ai-usage.ts adapters); every other
// machine source (git, check-ins, apps, web, gmail ...) is its own source.
export const AI_SRCS = new Set(["claude", "codex", "opencode", "hermes", "antigravity", "cursor", "aionui", "wispr", "glyph"]);
const NOT_AI = (src: string) => !AI_SRCS.has(src);

/**
 * Learned metrics: a metrics.md line with ~kind: (and ~src:) counts those
 * events, for example "- Runs ~id:m-runs ~per:week ~unit:count ~tier:asked
 * ~src:stated ~kind:stated.ran". ~value:attr sums an attribute instead of
 * counting. Unknown kinds simply stay at zero.
 */
export function learnedDefs(vault: string): MetricDef[] {
  const out: MetricDef[] = [];
  for (const [id, r] of readRegistry(vault)) {
    const t = r.tokens;
    if (!t.kind || CATALOG.some((m) => m.id === id) || !/^m-[a-z0-9-]+$/.test(id)) continue;
    const attr = t.value;
    out.push({
      id, title: r.title || id, family: t.family?.replace(/-/g, " ") ?? "Learned", per: t.per === "month" ? "month" : "week",
      unit: (["count", "usd", "minutes", "days", "score", "km", "mi", "hours"].includes(t.unit ?? "") ? t.unit : "count") as MetricDef["unit"],
      tier: (["measured", "derived", "asked", "inferred"].includes(t.tier ?? "") ? t.tier : "derived") as MetricDef["tier"],
      srcs: [t.src ?? "stated"], kinds: t.kind.split(","), from: r.from || `learned: ${t.kind}`,
      ...(attr ? { value: (e: MetricEvent) => Number(e.attrs[attr] ?? 0) } : {}),
      ...(t.mission ? { mission: t.mission } : {}),
      learned: true,
    });
  }
  return out;
}

export function allDefs(vault: string): MetricDef[] { return [...CATALOG, ...learnedDefs(vault)]; }

// ── The registry the user reads: build/metrics.md ───────────────────────────

export function metricsMdPath(vault: string): string { return join(buildRoot(vault), "metrics.md"); }

export function seedMetricsMd(): string {
  const lines = ["# Metrics", "", "Computed from what you already do. Move a line to Pinned to see it in the weekly glance, to Paused for a season, to Retired with a because: line. Unknown lines are kept.", "", "## Pinned", "", "## Tracking", ""];
  for (const m of CATALOG) {
    lines.push(`- ${m.title} ~id:${m.id} ~per:${m.per} ~unit:${m.unit} ~tier:${m.tier}${m.documentary ? " ~mode:documentary ~show:hidden" : ""}`);
    lines.push(`  from: ${m.from}`);
  }
  lines.push("", "## Paused", "", "## Retired", "");
  return lines.join("\n");
}

export type Lifecycle = "pinned" | "tracking" | "paused" | "retired";
export interface RegistryLine { status: Lifecycle; tokens: Record<string, string>; title: string; from: string; because: string }
export function readRegistry(vault: string): Map<string, RegistryLine> {
  const out = new Map<string, RegistryLine>();
  let status: Lifecycle = "tracking";
  let skip = false;
  let last: RegistryLine | null = null;
  for (const l of readText(metricsMdPath(vault)).split("\n")) {
    const h = /^##\s+(pinned|tracking|paused|retired)\b/i.exec(l);
    if (h) { status = h[1]!.toLowerCase() as Lifecycle; last = null; skip = false; continue; }
    // Any other section (## Seasons) holds no metrics.
    if (/^##\s+/.test(l)) { skip = true; last = null; continue; }
    if (skip) continue;
    const sub = /^\s+(from|because):\s*(.*)$/.exec(l);
    if (sub && last) { last[sub[1] as "from" | "because"] = sub[2]!.trim(); continue; }
    if (!/^- \S/.test(l)) { last = null; continue; }
    const tokens: Record<string, string> = {};
    for (const m of l.matchAll(/~([a-z][a-z0-9_-]*):(\S+)/g)) tokens[m[1]!] = m[2]!;
    const title = l.replace(/^-\s+/, "").replace(/\s+~\S+/g, "").trim();
    // A metric listed twice keeps its first line (Pinned comes first).
    if (tokens.id && !out.has(tokens.id)) { last = { status, tokens, title, from: "", because: "" }; out.set(tokens.id, last); } else last = null;
  }
  return out;
}

// ── Computing ───────────────────────────────────────────────────────────────

export interface Point { date: string; value: number; n: number }
export interface Computed {
  ts: number;
  defs: MetricDef[];
  from: string;
  points: Record<string, Point[]>;
  sources: SourceInfo[];
  files: Record<string, string[]>;
  hosts: Record<string, string[]>;
  times: number[];
  commitHours: { day: string; hour: number }[];
  events: MetricEvent[];
  trips: { date: string; region: string; activity: string; file: string }[];
}

const matches = (m: MetricDef, e: MetricEvent) => m.kinds.includes(e.kind) && (m.srcs.includes("*") ? AI_SRCS.has(e.src) : m.srcs.includes(e.src)) && (!m.mission || e.attrs.mission === m.mission);

export function dailyPoints(m: MetricDef, events: MetricEvent[]): Point[] {
  const by = new Map<string, Point>();
  // A distinct metric counts a project on the first day it shows up in its week.
  const firstInWeek = new Set<string>();
  const list = m.distinct ? [...events].sort((a, b) => a.ts.localeCompare(b.ts)) : events;
  for (const e of list) {
    if (!matches(m, e)) continue;
    if (m.distinct) {
      const k = `${weekOf(e.ts)}\t${e.project ?? ""}`;
      if (firstInWeek.has(k)) continue;
      firstInWeek.add(k);
      const p = by.get(e.ts) ?? { date: e.ts, value: 0, n: 0 };
      p.n += 1; p.value += 1;
      by.set(e.ts, p);
      continue;
    }
    const p = by.get(e.ts) ?? { date: e.ts, value: 0, n: 0 };
    p.n += e.n;
    p.value = m.days ? 1 : Math.round((p.value + (m.value ? m.value(e) : e.n)) * 1e4) / 1e4;
    by.set(e.ts, p);
  }
  // An averaged metric (a check-in) keeps each day's mean, so two Macs that
  // both recorded one never double it.
  if (m.avg) for (const p of by.values()) p.value = Math.round((p.value / Math.max(1, p.n)) * 100) / 100;
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Read every source and write the daily points, the source registry and (once) metrics.md. */
export async function computeMetrics(vault: string, opts: { now?: number; days?: number; home?: string } = {}): Promise<Computed> {
  const now = opts.now ?? Date.now();
  const from = dayOf(now - (opts.days ?? 400) * 86_400_000);
  const machine = readMachineEvents(vault, from);
  const tasks = taskEvents(vault);
  const loops = loopEvents(vault);
  const decisions = decisionEvents(vault);
  const prompts = await promptEvents(vault, opts.home);
  const trips = tripEvents(vault);
  const watch = watchEvents(vault);
  const spend = spendEvents(vault);
  // Charges matched to apps (apps plan A3), read in place from the same card statements.
  const { chargeEvents } = await import("./app-money.ts");
  const ch = chargeEvents(vault);
  const chargesInfo: SourceInfo = { id: "charges", kind: "vault", files: [...new Set(ch.events.map((e) => e.file!).filter(Boolean))], events: ch.events.length, note: "card statement charges matched to your apps only" };
  const events = [...machine.events, ...tasks.events, ...loops.events, ...decisions.events, ...prompts.events, ...trips.events, ...watch.events, ...spend.events, ...ch.events].filter((e) => e.ts >= from);
  const hosts: Record<string, string[]> = {};
  for (const e of machine.events) { const k = NOT_AI(e.src) ? e.src : "ai"; (hosts[k] ??= []); if (!hosts[k]!.includes(e.host)) hosts[k]!.push(e.host); }
  const span = (src: string[]) => { const d = events.filter((e) => src.includes(e.src)).map((e) => e.ts).sort(); return d.length ? { first: d[0], last: d[d.length - 1] } : {}; };
  const aiSrcs = Object.keys(machine.files).filter((s) => !NOT_AI(s));
  // Connected sources (apps, web, gmail, calendar ...): one entry each, with the registry's caveat.
  const { SOURCES } = await import("./sources.ts");
  const connected = Object.keys(machine.files).filter((s) => NOT_AI(s) && !["git", "checkins", "stated"].includes(s)).sort().map((src): SourceInfo => {
    const def = SOURCES.find((d) => d.id === src || d.emits.some((k) => machine.events.some((e) => e.src === src && e.kind === k)));
    return { id: src, kind: "machine", files: machine.files[src] ?? [], events: machine.events.filter((e) => e.src === src).length, hosts: hosts[src] ?? [], ...(def ? { note: `${def.title}: ${def.reads}${def.localOnly ? "; stays on this Mac" : ""}` } : {}), ...span([src]) };
  });
  const sources: SourceInfo[] = [
    { id: "ai", kind: "machine", files: aiSrcs.flatMap((s) => machine.files[s] ?? []), events: machine.events.filter((e) => !NOT_AI(e.src)).length, hosts: hosts.ai ?? [], ...span(aiSrcs) },
    { id: "git", kind: "machine", files: machine.files.git ?? [], events: machine.events.filter((e) => e.src === "git").length, hosts: hosts.git ?? [], ...span(["git"]) },
    ...[tasks.info, loops.info, decisions.info, prompts.info, trips.info, watch.info, spend.info, chargesInfo].map((i) => ({ ...i, ...span([i.id === "prompts" ? "capture" : i.id]) })),
    { id: "checkins", kind: "machine", files: machine.files.checkins ?? [], events: machine.events.filter((e) => e.src === "checkins").length, hosts: hosts.checkins ?? [], note: "your weekly 1-5, asked once a week", ...span(["checkins"]) },
    { id: "stated", kind: "machine", files: machine.files.stated ?? [], events: machine.events.filter((e) => e.src === "stated").length, hosts: hosts.stated ?? [], note: "numbers you said in chat (counts only)", ...span(["stated"]) },
    ...connected,
  ];
  const points: Record<string, Point[]> = {};
  const dir = metricsDir(vault);
  mkdirSync(dir, { recursive: true });
  const defs = allDefs(vault);
  for (const m of defs) {
    points[m.id] = dailyPoints(m, events);
    writeFileSync(join(dir, `${m.id}.jsonl`), points[m.id]!.map((p) => JSON.stringify(p)).join("\n") + (points[m.id]!.length ? "\n" : ""));
  }
  writeFileSync(join(dir, "catalog.json"), `${JSON.stringify({ v: 1, ts: now, metrics: defs.map(({ value: _v, ...m }) => m) }, null, 2)}\n`);
  writeFileSync(join(runtimePath(vault, "_meta"), "sources.json"), `${JSON.stringify({ ts: now, host: hostSlug(), sources }, null, 2)}\n`);
  if (!existsSync(metricsMdPath(vault))) vwriteFile(metricsMdPath(vault), seedMetricsMd());
  const commitHours = machine.events.filter((e) => e.kind === "git.commit" && typeof e.attrs.hours === "string")
    .flatMap((e) => String(e.attrs.hours).split(",").map((h) => ({ day: e.ts, hour: Number(h) })).filter((x) => Number.isFinite(x.hour)));
  return { ts: now, defs, from, points, sources, files: machine.files, hosts, times: prompts.times, commitHours, events, trips: trips.trips };
}

// ── Weeks, baselines and the glance ─────────────────────────────────────────

/** Monday of the week a day falls in. */
export function weekOf(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return dayOf(d.getTime());
}
const addDays = (day: string, n: number) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return dayOf(d.getTime()); };

export function weekly(points: Point[], days = false, avg = false): Map<string, number> {
  const out = new Map<string, number>();
  const n = new Map<string, number>();
  for (const p of points) { const w = weekOf(p.date); n.set(w, (n.get(w) ?? 0) + 1); out.set(w, Math.round(((out.get(w) ?? 0) + (days ? 1 : p.value)) * 100) / 100); }
  if (avg) for (const [w, v] of out) out.set(w, Math.round((v / (n.get(w) ?? 1)) * 100) / 100);
  return out;
}
const weeklyOf = (m: MetricDef, pts: Point[]) => weekly(pts, m.days, m.avg);

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round((sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo)) * 100) / 100;
}

export interface Baseline { median: number; lo: number; hi: number; weeks: number; learning: boolean; learningWeeksLeft: number }
export const LEARN_WEEKS = 4;

/**
 * Your normal: the eight complete weeks before `week`, from the first week
 * with any data (quiet weeks after that count as zero). Median and the
 * middle half as the band. Under four weeks of history it is still learning.
 */
export function baseline(byWeek: Map<string, number>, week: string): Baseline {
  const firstWeek = [...byWeek.keys()].sort()[0];
  const prior: number[] = [];
  for (let i = 1; i <= 8; i++) {
    const w = addDays(week, -7 * i);
    if (!firstWeek || w < firstWeek) break;
    prior.push(byWeek.get(w) ?? 0);
  }
  const s = [...prior].sort((a, b) => a - b);
  return { median: quantile(s, 0.5), lo: quantile(s, 0.25), hi: quantile(s, 0.75), weeks: prior.length, learning: prior.length < LEARN_WEEKS, learningWeeksLeft: Math.max(0, LEARN_WEEKS - prior.length) };
}

export interface GlanceRow {
  /** A season (metrics.md ## Seasons, or a week away) pauses this metric this week. */
  paused?: string;
  id: string; title: string; unit: MetricDef["unit"]; tier: string; family: string;
  value: number; normal: Baseline; spark: number[]; documentary: boolean;
  coverage: string; citations: { file: string; note?: string }[]; record?: string;
}
export interface Glance { week: string; through: string; rows: GlanceRow[]; surprise: string | null; computed: number }

const GLANCE_IDS = ["m-ai-spend", "m-shipped", "m-commits", "m-tasks-done", "m-prompts", "m-trips"];

/** What the glance shows: the metrics pinned in metrics.md (at most five), else the default set. */
export function glanceIds(vault: string): string[] {
  const defs = allDefs(vault);
  const pinned = [...readRegistry(vault).entries()].filter(([id, r]) => r.status === "pinned" && defs.some((m) => m.id === id)).map(([id]) => id);
  return pinned.length ? pinned.slice(0, 5) : GLANCE_IDS;
}

function coverageOf(m: MetricDef, c: Computed, week?: string): { coverage: string; citations: { file: string; note?: string }[] } {
  const src = m.srcs.includes("*") ? "ai" : m.srcs[0] === "capture" ? "prompts" : m.srcs[0]!;
  const s = c.sources.find((x) => x.id === src);
  if (!s) return { coverage: "no source yet", citations: [] };
  const pts = c.points[m.id] ?? [];
  const where = s.kind === "machine"
    ? (s.hosts?.length ? `${s.hosts.length === 1 ? "one Mac" : `${s.hosts.length} Macs`} (${s.hosts.join(", ")})` : "no Mac has scanned yet")
    : "your vault";
  const span = pts.length ? `, ${pts[0]!.date} to ${pts[pts.length - 1]!.date}` : ", no data yet";
  // The files behind this week's number, with how many records each gave.
  const by = new Map<string, number>();
  if (week) {
    const end = addDays(week, 6);
    for (const e of c.events) if (e.ts >= week && e.ts <= end && e.file && matches(m, e)) by.set(e.file, (by.get(e.file) ?? 0) + e.n);
  }
  const citations = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([file, n]) => ({ file, note: `${n} records this week` }));
  return { coverage: `${where}${span}${s.note ? `; ${s.note}` : ""}`, citations };
}

/** The week at a glance: a few metrics against your own normal, each with its tier, coverage and the files behind it. */
export function glance(c: Computed, opts: { week?: string; ids?: string[]; paused?: (id: string, week: string) => string | null } = {}): Glance {
  const today = dayOf(c.ts);
  const week = opts.week ? weekOf(opts.week) : weekOf(today);
  const rows: GlanceRow[] = [];
  for (const id of opts.ids ?? GLANCE_IDS) {
    const m = c.defs.find((x) => x.id === id);
    if (!m) continue;
    const pts = c.points[id] ?? [];
    const byWeek = weeklyOf(m, pts);
    const spark: number[] = [];
    for (let i = 11; i >= 0; i--) spark.push(byWeek.get(addDays(week, -7 * i)) ?? 0);
    const { coverage, citations } = coverageOf(m, c, week);
    const pz = opts.paused?.(id, week) ?? null;
    const row: GlanceRow = { id, title: m.title, unit: m.unit, tier: m.tier, family: m.family, value: byWeek.get(week) ?? 0, normal: baseline(byWeek, week), spark, documentary: !!m.documentary, coverage, citations, ...(pz ? { paused: pz } : {}) };
    if (m.documentary && id === "m-trips") {
      const last = [...c.trips].filter((t) => t.date <= addDays(week, 6)).sort((a, b) => b.date.localeCompare(a.date))[0];
      row.record = last ? `Latest: ${[last.activity, last.region].filter(Boolean).join(", ")} on ${last.date}` : "No trips recorded yet";
      if (last) row.citations = [{ file: last.file, note: last.date }];
    }
    rows.push(row);
  }
  let surprise: string | null = null;
  let best = 0;
  for (const r of rows) {
    if (r.documentary || r.normal.learning || r.paused) continue;
    const spread = Math.max(r.normal.hi - r.normal.lo, r.normal.median * 0.25, 1);
    const z = (r.value - r.normal.median) / spread;
    if (Math.abs(z) > 1.5 && Math.abs(z) > best) {
      best = Math.abs(z);
      surprise = `${r.title}: ${fmt(r.value, r.unit)} this week, ${r.value > r.normal.median ? "above" : "below"} your normal of ${fmt(r.normal.lo, r.unit)} to ${fmt(r.normal.hi, r.unit)}.`;
    }
  }
  return { week, through: today < addDays(week, 6) ? today : addDays(week, 6), rows, surprise, computed: c.ts };
}

export function fmt(v: number, unit: MetricDef["unit"]): string {
  if (unit === "usd") return `$${v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(2)}`;
  if (unit === "tokens") return v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e3)}k`;
  if (unit === "minutes") return `${Math.round(v)} min`;
  return String(Math.round(v * 10) / 10);
}

const TIER_LABEL: Record<string, string> = { measured: "Measured", derived: "Derived", inferred: "Inferred", asked: "Asked" };

/** The glance as markdown, for the weekly review page. Numbers come from code, never from a model. */
export function glanceMarkdown(g: Glance): string {
  const lines = [`## This week in numbers (week of ${g.week}, through ${g.through})`, ""];
  for (const r of g.rows) {
    if (r.paused) { lines.push(`- **${r.title}**: paused for ${r.paused}.`); continue; }
    const normal = r.normal.learning ? `learning your normal (${r.normal.learningWeeksLeft} more week${r.normal.learningWeeksLeft === 1 ? "" : "s"})` : `normal ${fmt(r.normal.lo, r.unit)} to ${fmt(r.normal.hi, r.unit)}`;
    const value = r.documentary ? (r.record ?? "") : `${fmt(r.value, r.unit)}, ${normal}`;
    lines.push(`- **${r.title}**: ${value}. ${TIER_LABEL[r.tier] ?? r.tier}${r.documentary ? ", a record, no target" : ""}; ${r.coverage}.`);
    if (r.citations.length) lines.push(`  Sources: ${r.citations.map((c) => `\`${c.file}\`${c.note ? ` (${c.note})` : ""}`).join(", ")}`);
  }
  if (g.surprise) lines.push("", `One surprise: ${g.surprise}`);
  return `${lines.join("\n")}\n`;
}

export function series(c: Computed, id: string, per: "day" | "week", count: number): { date: string; value: number }[] {
  const m = c.defs.find((x) => x.id === id);
  if (!m) return [];
  const pts = c.points[id] ?? [];
  if (per === "day") return pts.slice(-count).map((p) => ({ date: p.date, value: m.days ? 1 : p.value }));
  const byWeek = weeklyOf(m, pts);
  const end = weekOf(dayOf(c.ts));
  const out: { date: string; value: number }[] = [];
  for (let i = count - 1; i >= 0; i--) { const w = addDays(end, -7 * i); out.push({ date: w, value: byWeek.get(w) ?? 0 }); }
  return out;
}

/** One dot per event, time of day by date: your prompts and your commits over the last `days`. */
export function rhythm(c: Computed, days = 30): { day: string; hour: number; kind: "prompt" | "commit" }[] {
  const since = dayOf(c.ts - days * 86_400_000);
  const out: { day: string; hour: number; kind: "prompt" | "commit" }[] = [];
  for (const t of c.times) { const d = dayOf(t); if (d >= since) { const x = new Date(t); out.push({ day: d, hour: Math.round((x.getHours() + x.getMinutes() / 60) * 100) / 100, kind: "prompt" }); } }
  for (const h of c.commitHours) if (h.day >= since) out.push({ day: h.day, hour: h.hour, kind: "commit" });
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.hour - b.hour);
}

export function listMetrics(c: Computed, vault: string) {
  const reg = readRegistry(vault);
  const week = weekOf(dayOf(c.ts));
  return c.defs.map((m) => {
    const byWeek = weeklyOf(m, c.points[m.id] ?? []);
    const { coverage, citations } = coverageOf(m, c, week);
    return { id: m.id, title: m.title, family: m.family, per: m.per, unit: m.unit, tier: m.tier, documentary: !!m.documentary, status: reg.get(m.id)?.status ?? "tracking", from: m.from, thisWeek: byWeek.get(week) ?? 0, normal: baseline(byWeek, week), coverage, citations, spark: series(c, m.id, "week", 12).map((s) => s.value) };
  });
}

export async function metricsCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "glance";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  if (sub === "scan") {
    const r = scanGit(vault, { backfill: args.has("backfill") });
    if (args.json) out(r); else console.log(`git on ${r.host}: ${r.repos} repos, ${r.events} events (${r.ms} ms)`);
    return 0;
  }
  const c = await computeMetrics(vault);
  if (sub === "compute") { if (args.json) out({ ok: true, ts: c.ts, sources: c.sources }); else console.log(`computed ${c.defs.length} metrics from ${c.sources.length} sources`); return 0; }
  if (sub === "sources") { if (args.json) out(c.sources); else for (const s of c.sources) console.log(`${s.id.padEnd(10)} ${s.kind.padEnd(8)} ${String(s.events).padStart(6)} events  ${s.first ?? ""}${s.last ? ` to ${s.last}` : ""}${s.note ? `  (${s.note})` : ""}`); return 0; }
  if (sub === "list") { const l = listMetrics(c, vault); if (args.json) out(l); else for (const m of l) console.log(`${m.title.padEnd(22)} ${fmt(m.thisWeek, m.unit).padStart(10)}  ${m.tier}`); return 0; }
  if (sub === "series") {
    const id = args.pos[1] ?? "";
    if (!c.defs.some((m) => m.id === id)) { console.error(`unknown metric: ${id}`); return 1; }
    const per = args.get("per") === "day" ? "day" : "week";
    const s = series(c, id, per, Math.min(400, Number(args.get("count") ?? (per === "day" ? 90 : 26)) || 26));
    if (args.json) out(s); else for (const p of s) console.log(`${p.date} ${p.value}`);
    return 0;
  }
  if (sub === "rhythm") { const r = rhythm(c, Number(args.get("days") ?? 30) || 30); if (args.json) out(r); else console.log(`${r.length} dots`); return 0; }
  // Metrics M5: stories (the monthly recap, Your Year, the heatmap, places), patterns and experiments.
  { const st = await import("./stories.ts"); if (st.STORY_SUBCOMMANDS.includes(sub)) return st.storiesCommand(sub, argv, vault, c); }
  if (["proposals", "answer", "pin", "track", "pause", "retire", "insights", "acceptance", "insight-feedback"].includes(sub)) {
    const mp = await import("./metric-proposals.ts");
    try {
      if (sub === "proposals") { const p = mp.proposals(vault, c, Number(args.get("limit") ?? 8) || 8); if (args.json) out(p); else for (const x of p) console.log(`${x.score.toFixed(3)} ${x.kind.padEnd(8)} ${x.title}  ${x.key}`); return 0; }
      if (sub === "answer") {
        const a = args.pos[2];
        if (a !== "track" && a !== "dismiss" && a !== "edit") { console.error("usage: prevail metrics answer <key> track|dismiss|edit [--title t] [--serves id] [--never text]"); return 1; }
        const r = mp.answerProposal(vault, c, args.pos[1] ?? "", a, { title: args.get("title"), serves: args.get("serves"), never: args.get("never") });
        if (args.json) out({ ok: true, ...r }); else console.log(r.id ? `Tracking ${r.id}.` : "Noted.");
        return 0;
      }
      if (sub === "insights") { const i = await mp.insights(vault, c); if (args.json) out(i); else for (const x of i) console.log(x.text); return 0; }
      if (sub === "insight-feedback") { mp.insightFeedback(vault, args.pos[1] ?? "", args.pos[2] !== "down"); if (args.json) out({ ok: true }); return 0; }
      if (sub === "acceptance") { const a = mp.acceptance(vault); if (args.json) out(a); else console.log(`${a.month}: ${a.accepted} of ${a.answered} kept`); return 0; }
      const to = sub === "pin" ? "pinned" : sub === "track" ? "tracking" : sub === "pause" ? "paused" : "retired";
      mp.setLifecycle(vault, args.pos[1] ?? "", to, { serves: args.get("serves"), because: args.get("because") });
      if (args.json) out({ ok: true }); else console.log(`${args.pos[1]}: ${to}`);
      return 0;
    } catch (e) { if (args.json) out({ ok: false, error: (e as Error).message }); else console.error((e as Error).message); return 1; }
  }
  if (["lived", "guardrails", "lags", "proxies", "themes", "hypotheses", "seasons"].includes(sub)) {
    const q = await import("./qualitative.ts");
    const r = sub === "lived" ? q.mattersVsLived(vault, c) : sub === "guardrails" ? q.guardrails(vault, c) : sub === "lags" ? q.lagTests(vault, c) : sub === "proxies" ? q.proxies(vault, c) : sub === "themes" ? q.themeTrends(c, vault) : sub === "seasons" ? q.seasons(vault, c) : q.hypotheses(vault, c);
    if (args.json) out(r); else for (const x of r as { text?: string; title?: string }[]) console.log(x.text ?? JSON.stringify(x));
    return 0;
  }
  if (sub === "glance") { const q = await import("./qualitative.ts"); const ss = q.seasons(vault, c); const g = glance(c, { week: args.get("week"), ids: glanceIds(vault), paused: (id, w) => q.pausedBy(ss, c.defs.find((d) => d.id === id) ?? id, w)?.title ?? null }); if (args.json) out(g); else process.stdout.write(glanceMarkdown(g)); return 0; }
  console.error("usage: prevail metrics scan [--backfill] | compute | sources | list | series <id> [--per day|week] | rhythm | year [--year Y] [--write] | recap [--month YYYY-MM] [--write] | heatmap <id> | places | patterns | experiment list|propose|start|stop|score | glance [--week YYYY-MM-DD] | proposals | answer <key> track|dismiss|edit | pin|track|pause|retire <id> [--serves id] [--because text] | insights | acceptance | lived | guardrails | lags | proxies | themes | hypotheses | seasons [--json]");
  return 1;
}
