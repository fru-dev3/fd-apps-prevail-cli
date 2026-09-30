// Filing plan: where should each existing conversation live?
//
//   prevail file plan [--limit N] --vault V --json
//     -> { plan: [{ thread, title, current_home, primary, secondary, candidates, unfiled }],
//          skipped, total, cached }
//
// Covers General threads with no filing (no `routed` or `home` frontmatter)
// and threads anywhere whose filing was never set. Read-only on threads: the
// desktop applies a plan by writing only the `routed` (and `home`)
// frontmatter. The only thing written here is a cache of answers keyed by
// thread mtime, under build/_meta, so a re-run is cheap.
//
// Privacy: exactly what chat routing sends, the user's own words from the
// thread (capped at ROUTE_MAX_TEXT). Under Bunker Mode, in a local-only
// domain, or on an incognito thread nothing is sent: the thread is skipped
// and counted in `skipped`.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { vaultDomains } from "./apps-mirror.ts";
import { domainDir } from "./decisions.ts";
import type { DecisionProvider } from "./decision.ts";
import { readManifest } from "./manifest.ts";
import { runtimePath } from "./path-safety.ts";
import { ROUTE_MAX_TEXT, routeMessage, threadCorrection, type RouteCandidateScore, type RouteRunner } from "./route.ts";
import { isV4Domain } from "./vault-layout-v4.ts";

export interface FilingPlanRow {
  thread: string;
  title: string;
  current_home: string;
  primary: string | null;
  secondary: string[];
  candidates: RouteCandidateScore[];
  unfiled: boolean;
}

export interface FilingPlan {
  plan: FilingPlanRow[];
  /** Threads left out for privacy: Bunker Mode, local-only domains, incognito. */
  skipped: number;
  /** Threads needing a filing (before the cap and the skips). */
  total: number;
  /** Rows answered from the cache without a classifier call. */
  cached: number;
}

export interface FilingPlanOptions {
  vault: string;
  limit?: number;
  provider?: DecisionProvider | null;
  runner?: RouteRunner | null;
  bunker?: boolean;
}

export const FILE_PLAN_LIMIT = 20;
export const FILE_PLAN_MAX = 100;
const GENERAL = "general";

interface ThreadFile {
  path: string;
  stem: string;
  domain: string;
  mtime: number;
  fm: Record<string, string>;
  body: string;
}

export function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { fm: {}, body: raw };
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, body: raw.slice(m[0].length) };
}

/** The user's own turns ("## You" sections), which is all routing ever sends. */
export function userWords(title: string, body: string): string {
  const parts = body.split(/^## /m).filter((s) => s.startsWith("You\n") || s.startsWith("You\r\n"));
  const text = [title, ...parts.map((s) => s.slice(4).trim())].filter(Boolean).join("\n\n");
  return text.slice(0, ROUTE_MAX_TEXT);
}

function threadFiles(vault: string, domain: string): ThreadFile[] {
  const base = domainDir(vault, domain);
  const dirs = isV4Domain(base) ? [join(base, "memory", "threads"), join(base, "_threads")] : [join(base, "_threads")];
  const out: ThreadFile[] = [];
  for (const d of dirs) {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".md")) continue;
      const path = join(d, n);
      try {
        const { fm, body } = parseFrontmatter(readFileSync(path, "utf8"));
        out.push({ path, stem: n.slice(0, -3), domain, mtime: statSync(path).mtimeMs, fm, body });
      } catch { /* unreadable: not ours to plan */ }
    }
  }
  return out;
}

function filingSet(fm: Record<string, string>): boolean {
  return !!(fm.routed?.trim() || fm.home?.trim());
}

type Cache = Record<string, { mtime: number; row: FilingPlanRow }>;

export function filingCachePath(vault: string): string {
  return runtimePath(vault, join("_meta", "filing", "plan-cache.json"));
}

function readCache(vault: string): Cache {
  try { return JSON.parse(readFileSync(filingCachePath(vault), "utf8")) as Cache; } catch { return {}; }
}

function writeCache(vault: string, c: Cache): void {
  try {
    const p = filingCachePath(vault);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(c));
  } catch { /* a cache miss next time, nothing worse */ }
}

export async function filingPlan(o: FilingPlanOptions): Promise<FilingPlan> {
  const limit = Math.min(FILE_PLAN_MAX, Math.max(1, Math.floor(o.limit ?? FILE_PLAN_LIMIT)));
  const bunker = o.bunker ?? process.env.PREVAIL_BUNKER === "1";
  const domains = vaultDomains(o.vault);
  const routable = domains.filter((d) => d !== GENERAL);
  const all = [GENERAL, ...routable].filter((d, i, xs) => xs.indexOf(d) === i && (d === GENERAL || existsSync(domainDir(o.vault, d))));

  // General first, newest first; a thread the user already filed (frontmatter
  // or a route correction) is not in the plan.
  const pending = all
    .flatMap((d) => threadFiles(o.vault, d).sort((a, b) => b.mtime - a.mtime))
    .filter((t) => !filingSet(t.fm) && !t.fm.app && threadCorrection(o.vault, t.stem, routable) === null);

  const localOnly = new Map<string, boolean>();
  const isLocal = (d: string): boolean => {
    if (!localOnly.has(d)) {
      let v = false;
      try { v = readManifest(o.vault, d)?.privacy.localOnly ?? false; } catch { /* no manifest */ }
      localOnly.set(d, v);
    }
    return localOnly.get(d)!;
  };

  const cache = readCache(o.vault);
  const plan: FilingPlanRow[] = [];
  let skipped = 0;
  let cached = 0;
  let dirty = false;
  for (const t of pending) {
    if (bunker || isLocal(t.domain) || t.fm.incognito === "true") { skipped++; continue; }
    if (plan.length >= limit) continue;
    const hit = cache[t.path];
    if (hit && hit.mtime === t.mtime) { plan.push(hit.row); cached++; continue; }
    const title = t.fm.title && t.fm.title !== "Untitled" ? t.fm.title : t.stem;
    const text = userWords(t.fm.title ?? "", t.body);
    const current = t.domain === GENERAL ? [] : [t.domain];
    const r = await routeMessage({ vault: o.vault, text, thread: t.stem, provider: o.provider ?? null, runner: o.runner, domains: routable, current });
    const row: FilingPlanRow = {
      thread: t.stem, title, current_home: t.domain,
      primary: r.primary, secondary: r.secondary, candidates: r.candidates, unfiled: r.unfiled,
    };
    plan.push(row);
    // Only a real answer is cached; a failed call is retried next run.
    if (r.source !== "none") { cache[t.path] = { mtime: t.mtime, row }; dirty = true; }
  }
  if (dirty) writeCache(o.vault, cache);
  return { plan, skipped, total: pending.length, cached };
}
