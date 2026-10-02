// What code knows before a specialist starts: each specialist's "code half".
//
// Specialists Phase 2 folds older features into the specialists that absorb
// them (specialists-plan.md, "Existing features each specialist absorbs"):
//
//   alignment.ts   -> the Steward reads its latest report, and the Compass
//                     rules code checks (and the ones it cannot)
//   surface.ts     -> the Sentinel reads the domain's cached questions and the
//                     radar (computed by code)
//   calibration    -> the Historian reads the decision records, their retros
//                     and how often gut and recommendation were right
//   serendipity.ts -> the Scout is aimed at one neighbouring domain instead of
//                     a random angle after every turn
//   metrics        -> the Analyst reads the week's numbers against the normal
//   briefings.ts   -> the Editor writes the page (delivery stays where it is)
//
// Every block is computed from files, never by a model, and kept short. A
// failure in one reader drops that block; it never stops a run.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { missionScopeSlug, resolveDomainDir } from "./path-safety.ts";
import { vreadFile } from "./vault-session.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";

const readText = (p: string) => { try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } } };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n(cut)` : s);

type Facts = (vault: string, owner: string, now: number) => Promise<string> | string;

async function stewardFacts(vault: string, _owner: string, _now: number): Promise<string> {
  const out: string[] = [];
  try {
    const { readAlignment } = await import("./alignment.ts");
    const a = readAlignment(vault);
    if (a) out.push(`Latest alignment report (${a.method}, ${new Date(a.ts).toISOString().slice(0, 10)}): overall ${a.overall}.${a.actions.length ? ` Actions it named: ${a.actions.slice(0, 3).join("; ")}.` : ""}`);
  } catch { /* none */ }
  return out.join("\n");
}

async function sentinelFacts(vault: string, owner: string, _now: number): Promise<string> {
  const out: string[] = [];
  try {
    const dir = resolveDomainDir(vault, owner);
    const s = JSON.parse(readText(join(dir, "_surface.json"))) as { questions?: string[] };
    if (s.questions?.length) out.push(`Open questions cached for this domain: ${s.questions.slice(0, 4).join(" | ")}`);
  } catch { /* no cache */ }
  return out.join("\n");
}

async function historianFacts(vault: string, owner: string, _now: number): Promise<string> {
  const out: string[] = [];
  const dir = resolveDomainDir(vault, owner);
  const lines = readText(join(dir, "memory", "decisions.jsonl")).split("\n").filter(Boolean).slice(-10);
  if (lines.length) {
    out.push("Decisions on record (newest last):");
    for (const l of lines) {
      try { const d = JSON.parse(l) as { ts?: number; prompt?: string; verdict?: string }; out.push(`- ${d.ts ? new Date(d.ts).toISOString().slice(0, 10) : "?"}: ${(d.prompt ?? "").slice(0, 100)} -> ${(d.verdict ?? "").slice(0, 120)}`); } catch { /* skip */ }
    }
  }
  try {
    const { listDecisions, calibration } = await import("./decision-records.ts");
    const recs = listDecisions(vault, { all: true }).filter((r) => r.domain === owner).slice(0, 8);
    for (const r of recs) out.push(`- record ${r.slug}: ${r.question} [${r.status}${r.chose ? `, chose ${r.chose}` : ""}${r.retroRight ? `, retro: ${r.retroRight} was right` : ""}]`);
    const c = calibration(vault).find((x) => x.domain === owner);
    if (c) out.push(`Calibration here: ${c.retros} retros, gut right ${c.gutRight}, recommendation right ${c.recommendationRight}, ${c.pending} owed.`);
  } catch { /* none */ }
  const ms = missionScopeSlug(owner);
  if (ms) { const log = readText(join(dir, "memory", "log.md")); if (log) out.push(`Mission log:\n${clip(log, 1500)}`); }
  return out.join("\n");
}

async function analystFacts(vault: string, owner: string, now: number): Promise<string> {
  const out: string[] = [];
  try {
    const m = await import("./metrics.ts");
    const g = m.glance(await m.computeMetrics(vault, { now }), { ids: m.glanceIds(vault) });
    if (g.rows.length) out.push(`This week in numbers (week of ${g.week}, computed by code):`, ...g.rows.map((r) => `- ${r.title}: ${r.documentary ? (r.record ?? "a record") : `${m.fmt(r.value, r.unit)} (normal ${m.fmt(r.normal.lo, r.unit)} to ${m.fmt(r.normal.hi, r.unit)})`}`));
  } catch { /* no metrics */ }
  const ms = missionScopeSlug(owner);
  if (ms) {
    try {
      const mm = await import("./missions.ts");
      const v = mm.missionView(vault, ms, now);
      if (v?.progress.budget.planned) out.push(`Mission budget: $${v.progress.budget.used} of $${v.progress.budget.planned} (${v.progress.budget.byLine.map((l) => `${l.label} $${l.used} of $${l.planned}`).join("; ")}).`);
    } catch { /* none */ }
  }
  return out.join("\n");
}

// The Scout looks one step to the side: the neighbouring domain that has
// changed most recently and is not the owner (deterministic, so a rerun reads
// the same neighbour).
function scoutFacts(vault: string, owner: string): string {
  let best: { d: string; t: number } | null = null;
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_") || d === owner) continue;
    const dir = resolveDomainDir(vault, d);
    let t = 0;
    for (const f of ["memory/state.md", "memory/memory.md"]) { try { t = Math.max(t, statSync(join(dir, f)).mtimeMs); } catch { /* none */ } }
    if (t && (!best || t > best.t)) best = { d, t };
  }
  if (!best) return "";
  const st = readText(join(resolveDomainDir(vault, best.d), "memory", "state.md"));
  return st ? `Look one step to the side, at ${best.d} (most recently changed):\n${clip(st, 800)}` : "";
}

const FACTS: Record<string, Facts> = {
  steward: stewardFacts,
  sentinel: sentinelFacts,
  historian: historianFacts,
  analyst: analystFacts,
  auditor: analystFacts,
  scout: (v, o) => scoutFacts(v, o),
};

/** The code half for one specialist on one owner, or "" when it has none. */
export async function specialistFacts(vault: string, specialist: string, owner: string, now = Date.now()): Promise<string> {
  const f = FACTS[specialist];
  if (!f) return "";
  try { const t = (await f(vault, owner, now)).trim(); return t ? clip(t, 4000) : ""; } catch { return ""; }
}

/** Every specialist that has a code half (shown on the Specialists page). */
export const HAS_FACTS = Object.keys(FACTS);
