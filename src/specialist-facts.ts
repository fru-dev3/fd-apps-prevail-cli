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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { missionScopeSlug, resolveDomainDir } from "./path-safety.ts";
import { vreadFile } from "./vault-session.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";

const readText = (p: string) => { try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } } };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n(cut)` : s);

type Facts = (vault: string, owner: string, now: number) => Promise<string> | string;

async function stewardFacts(vault: string, _owner: string, now: number): Promise<string> {
  const out: string[] = [];
  try {
    const ca = await import("./compass-align.ts");
    const rules = ca.evaluateRules((await import("./compass.ts")).readCompass(vault), ca.readSignals(vault).length ? ca.readSignals(vault) : await ca.stateVariables(vault, { now }));
    if (rules.length) {
      out.push("Non-negotiables, checked by code:");
      for (const r of rules) out.push(`- ${r.title}: ${r.state}${r.detail ? ` (${r.detail})` : ""}`);
      const unchecked = rules.filter((r) => r.state === "unchecked");
      if (unchecked.length) out.push(`Judge these yourself (code cannot check them): ${unchecked.map((r) => r.title).join("; ")}.`);
    }
    const open = ca.openConflicts(vault).slice(0, 3);
    if (open.length) out.push("Open conflicts in the Compass:", ...open.map((c) => `- ${c.question} (${c.evidence.join("; ")})`));
  } catch { /* no Compass */ }
  try {
    const { readAlignment } = await import("./alignment.ts");
    const a = readAlignment(vault);
    if (a) out.push(`Latest alignment report (${a.method}, ${new Date(a.ts).toISOString().slice(0, 10)}): overall ${a.overall}.${a.actions.length ? ` Actions it named: ${a.actions.slice(0, 3).join("; ")}.` : ""}`);
  } catch { /* none */ }
  return out.join("\n");
}

async function sentinelFacts(vault: string, owner: string, now: number): Promise<string> {
  const out: string[] = [];
  try {
    const { readRadar, computeRadar } = await import("./radar.ts");
    const r = readRadar(vault, now) ?? (await computeRadar(vault, { now }));
    const mine = r.items.filter((x) => owner === "general" || x.domain === owner || (missionScopeSlug(owner) && x.mission === missionScopeSlug(owner)));
    const rows = (mine.length ? mine : r.items).slice(0, 12);
    if (rows.length) out.push(`The radar (computed by code ${new Date(r.computed).toISOString().slice(0, 10)}):`, ...rows.map((x) => `- [${x.kind}] ${x.text} (${x.evidence})`));
    else out.push("The radar finds nothing slipping.");
  } catch { /* radar unavailable */ }
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
  if (ms) { const log = readText(join(dir, "memory", "log.md")); if (log) out.push(`Project log:\n${clip(log, 1500)}`); }
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

// The Mechanic reads Prevail's own health, computed by code: the connection
// doctor, sources that failed, loops that error or stopped running, and
// capture that went quiet.
async function mechanicFacts(vault: string, _owner: string, now: number): Promise<string> {
  const out: string[] = [];
  try {
    const { readAllHealth } = await import("./app-doctor.ts");
    const bad = Object.values(readAllHealth(vault)).filter((h) => h.status !== "ok");
    out.push(bad.length ? "Connections that are not ok (the doctor, by code):" : "The connection doctor finds every checked app ok.");
    for (const h of bad.slice(0, 10)) out.push(`- ${h.app} on ${h.host}: ${h.status}${h.first_fail ? ` since ${h.first_fail.slice(0, 10)}` : ""}${h.checks[0]?.fix ? `; fix: ${h.checks[0].fix}` : ""}`);
  } catch { /* no doctor yet */ }
  try {
    const { listSources } = await import("./sources.ts");
    const failing = listSources(vault).filter((x) => x.on && /fail|error|restricted|disabled/i.test(`${x.state} ${x.note ?? ""}`));
    for (const x of failing.slice(0, 6)) out.push(`- source ${x.id}: ${x.state}${x.note ? ` (${x.note.slice(0, 120)})` : ""}`);
  } catch { /* no sources */ }
  // Loops: an enabled loop whose last runs errored, or that has not run for twice its cadence.
  const cadence: Record<string, number> = { daily: 1, weekly: 7, monthly: 30 };
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    const dir = resolveDomainDir(vault, d);
    try {
      // Playbooks replace loops: the loops as the runner sees them (a carried-over loop's last run is on its playbook).
      const { readLoops } = await import("./daemon-loops.ts");
      const doc = { loops: readLoops(vault, dir) };
      const rt = (() => { try { return JSON.parse(readText(join(dir, "_loops_runtime.json"))) as { loops?: Record<string, { history?: { ts: number; note?: string }[] }> }; } catch { return {}; } })();
      for (const l of doc.loops ?? []) {
        if (l.enabled === false || (l.status && l.status !== "active")) continue;
        const last = rt.loops?.[l.id]?.history?.[0];
        if (last?.note && /error|fail|not found|no cli/i.test(last.note)) out.push(`- loop ${d}/${l.id}: last run said "${last.note.slice(0, 120)}"`);
        const days = cadence[l.cadence ?? ""];
        if (days && l.lastRunTs && now - l.lastRunTs > 2 * days * 86_400_000) out.push(`- loop ${d}/${l.id}: has not run since ${new Date(l.lastRunTs).toISOString().slice(0, 10)} (${l.cadence})`);
      }
    } catch { /* no loops */ }
  }
  try {
    const { readRadar } = await import("./radar.ts");
    const r = readRadar(vault, now);
    const cap = (r?.items ?? []).filter((x) => /capture/i.test(x.text));
    for (const x of cap.slice(0, 4)) out.push(`- ${x.text} (${x.evidence})`);
  } catch { /* no radar */ }
  return out.join("\n");
}

// The Coach and the Interviewer read the Compass goals, what they still lack
// (a WOOP, a date, a domain) and the candidates heard in chat.
async function coachFacts(vault: string, owner: string, _now: number): Promise<string> {
  const out: string[] = [];
  try {
    const c = await import("./compass.ts");
    const goals = c.items(c.readCompass(vault), "goal").filter((g) => !c.isProposed(g) && (!g.tokens.domain || owner === "general" || g.tokens.domain === owner));
    if (goals.length) out.push("Compass goals (the user's words):", ...goals.slice(0, 10).map((g) => `- ${g.id} ${g.title} [${g.tokens.status ?? "active"}${g.tokens.due ? `, due ${g.tokens.due}` : ""}${c.woopComplete(g) ? "" : ", no if-then plan yet"}]`));
    const need = c.goalsNeedingWoop(vault).slice(0, 5);
    if (need.length) out.push(`Goals that still need a WOOP: ${need.map((g) => g.title).join("; ")}.`);
  } catch { /* no Compass */ }
  try {
    const { topCandidates } = await import("./said.ts");
    const t = topCandidates(vault, 5);
    if (t.length) out.push("Heard in chat, not yet in the Compass:", ...t.map((x) => `- ${x.kind}: "${x.quote.slice(0, 160)}" (${x.count}x)`));
  } catch { /* none */ }
  return out.join("\n");
}

function interviewerFacts(vault: string, owner: string): string {
  const dir = resolveDomainDir(vault, owner);
  const has = (f: string) => readText(join(dir, f)).trim().length;
  const out: string[] = [`What the notes hold (characters): ideal state ${has("ideal-state.md")}, memory ${has("memory/memory.md")}, state ${has("memory/state.md")}, goals ${has("source/goals.md")}.`];
  const asked = readText(join(dir, "memory", "memory.md")).match(/^## Questions to ask you[\s\S]*?(?=^## |$(?![\s\S]))/gm);
  if (asked?.length) out.push(`Already asked, not answered yet:\n${asked.join("\n").slice(0, 1200)}`);
  return out.join("\n");
}

// Phase 4. The Liaison starts from the people the radar finds out of touch
// (days since against their own normal, computed by code); the Confidant
// reads the owner's journal; the Tutor sees the lesson plans already filed.
async function liaisonFacts(vault: string, _owner: string, now: number): Promise<string> {
  try {
    const { relationships } = await import("./radar.ts");
    const due = relationships(vault, now).slice(0, 8);
    return due.length ? ["People due a note (by code: days since you were in touch against your normal with them):", ...due.map((r) => `- ${r.text} (${r.evidence})`)].join("\n") : "Code finds nobody overdue against their normal.";
  } catch { return ""; }
}

function confidantFacts(vault: string, owner: string): string {
  const dir = resolveDomainDir(vault, owner);
  const parts: string[] = [];
  for (const rel of ["memory/journal/decisions.md", "memory/journal/facts.md", "_journal/decisions.md", "_journal/facts.md"]) {
    const t = readText(join(dir, rel)).trim();
    if (t) parts.push(`From ${rel.split("/").pop()} (newest last):\n${clip(t.split("\n").slice(-40).join("\n"), 1500)}`);
  }
  return parts.length ? parts.join("\n\n") : "No journal here yet; read the notes in the context.";
}

function tutorFacts(vault: string, owner: string): string {
  const dir = join(resolveDomainDir(vault, owner), "memory", "lessons");
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().slice(-8);
    return files.length ? `Lesson plans already filed here (do not repeat them; build on them):\n${files.map((f) => `- ${f.replace(/\.md$/, "")}`).join("\n")}` : "";
  } catch { return ""; }
}

const FACTS: Record<string, Facts> = {
  liaison: liaisonFacts,
  confidant: (v, o) => confidantFacts(v, o),
  tutor: (v, o) => tutorFacts(v, o),
  negotiator: stewardFacts,
  mechanic: mechanicFacts,
  coach: coachFacts,
  interviewer: (v, o) => interviewerFacts(v, o),
  skeptic: stewardFacts,
  operator: stewardFacts,
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
