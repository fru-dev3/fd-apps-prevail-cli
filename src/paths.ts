// Goals G4: paths and initiative (goals-plan.md, "Pursuing goals").
// The user sees a path as an "initiative" (owner, 2026-10-02: an initiative
// runs as a mission); the data keeps the plan's names (path: lines, p- ids)
// so the later Compass restructure can migrate them.
//
// The user owns the what and the why; the chief of staff owns the how. For a
// goal with no chosen path (or a failing one):
//
//   1. generate  one model call proposes 6 to 8 paths with forced variety
//                (low effort, capital, skill, social, change the target, do
//                nothing), each with hours a week, dollars a month, stress,
//                conditions, effects, its effect on every value, expectations
//                written as metric checks (m-x>=N), a stop rule and the
//                playbooks that would carry it out.
//   2. screen    code drops a path that breaks a non-negotiable (its effect on
//                a rule's state variable), does not fit capacity beside the
//                chosen paths, or is beaten by another path on every value and
//                resource (dominated). 2 or 3 survivors, each with an
//                even-swap sentence written by code.
//   3. choose    the user picks; the path gets its commit date, approval,
//                expectations, stop rule and budget, and its playbooks are
//                installed (build/playbooks/, a loop in the goal's domain),
//                with a first task. Reversible and free work runs alone;
//                money, people, location or identity asks (code: every
//                Writer, Operator or Negotiator step is an ASK step).
//   4. check     weekly: expectations against actuals (metrics), stop rules,
//                and whether the playbooks ran. A miss is explained, with a
//                proposed change; before the commit date only a broken rule
//                reopens a path (no thrashing).
//   5. review    quarterly: keep, switch or drop each path; stalled goals are
//                offered a release with a replacement.
//
// Files: survivors are path: lines in build/compass.md (~status:proposed,
// ~kind:<variety>); every candidate with its verdict, and the playbook
// drafts, in build/_meta/compass/paths.json; installs in installs.jsonl;
// checks in path-checks.json; the quarterly page in General's
// memory/reviews/paths-<YYYY>-Q<n>.md.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compassId, compassMetaDir, findById, items, readCompass, saveCompass, type CompassDoc, type CompassItem, type CompassPath } from "./compass.ts";
import { activePaths, capacityOf, evaluateRules, holds, parseCheck, pathModel, readSignals, type PathModel, type StateValue } from "./compass-align.ts";
import { resolveDomainDir, buildRoot } from "./path-safety.ts";
import { parseModArgs } from "./cli-args.ts";

export const VARIETY = ["low-effort", "capital", "skill", "social", "change-target", "do-nothing"] as const;
export type Variety = (typeof VARIETY)[number] | "other";
export type Cadence = "daily" | "weekly" | "monthly";
export interface StepDraft { specialists: string[]; brief: string }
export interface PlaybookDraft { name: string; cadence: Cadence; goal: string; steps: StepDraft[] }
export interface PathDraft {
  title: string; kind: Variety; why: string; hours: number; usd: number; stress: number;
  needs: string[]; effects: string[]; values: Record<string, number>; expect: string[]; stop?: string;
  commitWeeks: number; outcome?: string; playbooks: PlaybookDraft[];
}
export interface Candidate extends PathDraft { id: string; verdict: "survivor" | "rejected"; reason?: string; swap?: string; score: number }
export interface PathsFile { goals: Record<string, { generated: number; method: "model" | "given"; candidates: Candidate[] }> }

const DAY = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const clamp = (n: unknown, lo: number, hi: number, d = 0) => { const x = Number(n); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
const one = (s: unknown, n = 200) => String(s ?? "").replace(/\s+/g, " ").replace(/\s*—\s*/g, ", ").trim().slice(0, n);
const pathsFile = (vault: string) => join(compassMetaDir(vault), "paths.json");
const installsFile = (vault: string) => join(compassMetaDir(vault), "installs.jsonl");
const checksFile = (vault: string) => join(compassMetaDir(vault), "path-checks.json");

export function readPathsFile(vault: string): PathsFile {
  try { const j = JSON.parse(readFileSync(pathsFile(vault), "utf8")) as PathsFile; return { goals: j.goals ?? {} }; } catch { return { goals: {} }; }
}
function writePathsFile(vault: string, f: PathsFile): void {
  mkdirSync(compassMetaDir(vault), { recursive: true });
  writeFileSync(pathsFile(vault), `${JSON.stringify(f, null, 2)}\n`);
}

// ── 1. Generate ─────────────────────────────────────────────────────────────

export interface GenContext {
  goal: { id: string; title: string; why?: string; enough?: string; due?: string; domain?: string; serves: string[] };
  values: { id: string; title: string; rank: number }[];
  rules: { id: string; title: string; check?: string }[];
  capacity: { hours?: number; usd?: number; stress?: number };
  active: { title: string; hours: number; usd: number; stress: number }[];
  specialists: { id: string; returns: string; ceiling: string }[];
  metrics: { id: string; title: string }[];
}

export function pathsPrompt(c: GenContext): string {
  return [
    "You help a person's chief of staff propose ways to reach one of their goals. The person chooses; you only propose. Reply with JSON only.",
    "",
    `Goal (${c.goal.id}): ${c.goal.title}${c.goal.why ? `\nWhy, in their words: ${c.goal.why}` : ""}${c.goal.enough ? `\nEnough: ${c.goal.enough}` : ""}${c.goal.due ? `\nBy: ${c.goal.due}` : ""}`,
    `It serves: ${c.goal.serves.join(", ") || "(no value named)"}`,
    "",
    "Their values (id, rank; 1 matters most):",
    ...c.values.map((v) => `- ${v.id} ${v.title} (rank ${v.rank})`),
    c.rules.length ? `\nNon-negotiables (never break one):\n${c.rules.map((r) => `- ${r.title}${r.check ? ` [${r.check}]` : ""}`).join("\n")}` : "",
    `\nCapacity for goals: ${c.capacity.hours ?? "?"} hours a week, $${c.capacity.usd ?? "?"} a month, stress budget ${c.capacity.stress ?? "?"} of 5.`,
    c.active.length ? `Already chosen paths use: ${c.active.map((a) => `${a.title} (${a.hours} h, $${a.usd}, stress ${a.stress})`).join("; ")}.` : "No other chosen paths yet.",
    "",
    "Specialists who can carry out a path as a playbook (id: what each returns):",
    ...c.specialists.map((s) => `- ${s.id}: ${s.returns}`),
    "",
    "Metrics that can measure expectations (write checks like m-id>=N, per week):",
    ...c.metrics.slice(0, 60).map((m) => `- ${m.id}: ${m.title}`),
    "",
    "Propose 6 to 8 paths. Use every kind at least once: low-effort, capital, skill, social, change-target (a smaller or different target), do-nothing (what happens if they do nothing).",
    "For each path, estimate honestly, including what it costs the other values. Return:",
    '{ "paths": [ { "title": "<short name>", "kind": "<one of the kinds>", "why": "<one line: how it reaches the goal>",',
    '  "hours": <hours a week>, "usd": <dollars a month>, "stress": <0-5>,',
    '  "needs": ["<conditions that must stay true, as short-hyphenated-tags>"], "effects": ["<what it changes: tags, or variable deltas like dinners_home_wk-1>"],',
    '  "values": { "<value id>": <-2..2 for EVERY value above> },',
    '  "expect": ["<metric check, e.g. m-prompts>=3>"], "stop": "<a metric check that says stop, e.g. m-calm<3>", "commit_weeks": <weeks before reconsidering, 4-26>,',
    '  "playbooks": [ { "name": "<name>", "cadence": "daily | weekly | monthly", "goal": "<what each run does>", "steps": [ { "specialists": ["<specialist id>"], "brief": "<what that step does>" } ] } ] } ] }',
    "A do-nothing path has no playbooks. At most two playbooks a path, at most four steps each. Never propose buying, contacting someone or moving as a step that runs alone; a Writer or Operator step only drafts or proposes.",
  ].filter(Boolean).join("\n");
}

const KINDS = new Set<string>(VARIETY);

/** Validate a model's paths: kinds, numbers in range, known value ids, metric checks, playbooks of specialists that are on. */
export function parsePaths(raw: string, c: GenContext): PathDraft[] {
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return [];
  let j: { paths?: unknown[] };
  try { j = JSON.parse(raw.slice(a, b + 1)) as { paths?: unknown[] }; } catch { return []; }
  const valueIds = new Set(c.values.map((v) => v.id));
  const metricIds = new Set(c.metrics.map((m) => m.id));
  const on = new Set(c.specialists.map((s) => s.id));
  const checkOk = (s: string) => { const k = parseCheck(s.replace(/\s+/g, "")); return !!k && metricIds.has(k.variable); };
  const out: PathDraft[] = [];
  for (const x of (j.paths ?? []).slice(0, 8) as Record<string, unknown>[]) {
    const title = one(x.title, 80);
    if (!title) continue;
    const kind = KINDS.has(String(x.kind)) ? (String(x.kind) as Variety) : "other";
    const values: Record<string, number> = {};
    for (const [k, v] of Object.entries((x.values ?? {}) as Record<string, unknown>)) if (valueIds.has(k)) values[k] = Math.round(clamp(v, -2, 2));
    const tagList = (v: unknown) => (Array.isArray(v) ? v.map((t) => one(t, 40).toLowerCase().replace(/\s+/g, "-")).filter(Boolean).slice(0, 6) : []);
    const playbooks: PlaybookDraft[] = kind === "do-nothing" ? [] : (Array.isArray(x.playbooks) ? x.playbooks : []).slice(0, 2).flatMap((pb) => {
      const p = pb as Record<string, unknown>;
      const steps = (Array.isArray(p.steps) ? p.steps : []).slice(0, 4).map((s) => {
        const st = s as Record<string, unknown>;
        return { specialists: (Array.isArray(st.specialists) ? st.specialists : []).map((y) => String(y).toLowerCase()).filter((y) => on.has(y)).slice(0, 2), brief: one(st.brief, 240) };
      }).filter((s) => s.specialists.length && s.brief);
      if (!steps.length) return [];
      const cadence = (["daily", "weekly", "monthly"] as Cadence[]).includes(p.cadence as Cadence) ? (p.cadence as Cadence) : "weekly";
      return [{ name: one(p.name, 60) || title, cadence, goal: one(p.goal, 240) || title, steps }];
    });
    out.push({
      title, kind, why: one(x.why, 200), hours: clamp(x.hours, 0, 80), usd: clamp(x.usd, 0, 100_000), stress: clamp(x.stress, 0, 5),
      needs: tagList(x.needs), effects: tagList(x.effects), values,
      expect: (Array.isArray(x.expect) ? x.expect : []).map((e) => one(e, 40).replace(/\s+/g, "")).filter(checkOk).slice(0, 3),
      ...(typeof x.stop === "string" && checkOk(x.stop) ? { stop: x.stop.replace(/\s+/g, "") } : {}),
      commitWeeks: Math.round(clamp(x.commit_weeks, 4, 26, 12)),
      ...(typeof x.outcome === "string" && x.outcome.trim() ? { outcome: one(x.outcome, 200) } : {}),
      playbooks,
    });
  }
  return out;
}

// ── 2. Screen: non-negotiables, capacity, dominance; even swaps ─────────────

/** Rank weights (rank-order centroid), by value id. */
export function valueWeights(values: { id: string; rank: number }[]): Map<string, number> {
  const sorted = [...values].sort((a, b) => a.rank - b.rank);
  const n = sorted.length;
  return new Map(sorted.map((v, i) => { let s = 0; for (let k = i + 1; k <= n; k++) s += 1 / k; return [v.id, s / n]; }));
}

function deltasOf(effects: string[]): { variable: string; delta: number }[] {
  return effects.map((t) => /^([a-z][a-z0-9_.]*)([+-]\d+(?:\.\d+)?)$/.exec(t)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ variable: m[1]!, delta: Number(m[2]) }));
}

/** A is at least as good as B on every value and resource, and better on one. */
export function dominates(a: PathDraft, b: PathDraft, valueIds: string[]): boolean {
  let better = false;
  for (const v of valueIds) { const x = a.values[v] ?? 0; const y = b.values[v] ?? 0; if (x < y) return false; if (x > y) better = true; }
  for (const k of ["hours", "usd", "stress"] as const) { if (a[k] > b[k]) return false; if (a[k] < b[k]) better = true; }
  return better;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
/** "Path B gives up X to gain Y": the trade from A to B, written by code. */
export function evenSwap(a: PathDraft, b: PathDraft, values: { id: string; title: string }[]): string {
  const name = (id: string) => values.find((v) => v.id === id)?.title ?? id;
  const lose: string[] = [];
  const gain: string[] = [];
  for (const v of values) {
    const d = (b.values[v.id] ?? 0) - (a.values[v.id] ?? 0);
    if (d < 0) lose.push(name(v.id)); else if (d > 0) gain.push(name(v.id));
  }
  // At most three values named, the rest counted, so the sentence stays readable.
  const cap = (xs: string[]) => (xs.length > 3 ? [...xs.slice(0, 2), `${xs.length - 2} other values`] : xs);
  lose.splice(0, lose.length, ...cap(lose));
  gain.splice(0, gain.length, ...cap(gain));
  const dh = b.hours - a.hours;
  const du = b.usd - a.usd;
  const ds = b.stress - a.stress;
  if (dh > 0) lose.push(`${dh} more hour${dh === 1 ? "" : "s"} a week`); else if (dh < 0) gain.push(`${-dh} hour${dh === -1 ? "" : "s"} a week back`);
  if (du > 0) lose.push(`about ${money(du)} more a month`); else if (du < 0) gain.push(`about ${money(-du)} a month saved`);
  if (ds > 0) lose.push(`stress up ${ds} of 5`); else if (ds < 0) gain.push(`stress down ${-ds} of 5`);
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  if (!lose.length && !gain.length) return `${b.title} trades evenly with ${a.title}.`;
  if (!lose.length) return `${b.title} gains ${list(gain)} over ${a.title}.`;
  if (!gain.length) return `${b.title} gives up ${list(lose)} against ${a.title}.`;
  return `${b.title} gives up ${list(lose)} to gain ${list(gain)}, against ${a.title}.`;
}

export function screenPaths(drafts: PathDraft[], c: { values: { id: string; title: string; rank: number }[]; rules: { id: string; title: string; check?: string }[]; vars: StateValue[]; capacity: { hours?: number; usd?: number; stress?: number }; active: { hours: number; usd: number; stress: number }[] }, keep = 3): Candidate[] {
  const w = valueWeights(c.values);
  const ids = c.values.map((v) => v.id);
  const used = { hours: c.active.reduce((a, p) => a + p.hours, 0), usd: c.active.reduce((a, p) => a + p.usd, 0), stress: c.active.reduce((a, p) => Math.max(a, p.stress), 0) };
  const out: Candidate[] = drafts.map((d) => {
    const score = ids.reduce((s, v) => s + (w.get(v) ?? 0) * (d.values[v] ?? 0), 0) - d.hours * 0.01 - d.stress * 0.02;
    return { ...d, id: compassId("other", d.title), verdict: "survivor" as const, score: Math.round(score * 1000) / 1000 };
  });
  for (const cd of out) {
    // A non-negotiable it would break: its effect on the rule's state variable.
    for (const r of c.rules) {
      const chk = parseCheck(r.check);
      if (!chk) continue;
      const delta = deltasOf(cd.effects).filter((x) => x.variable === chk.variable).reduce((a, x) => a + x.delta, 0);
      if (!delta) continue;
      const cur = c.vars.find((v) => v.id === chk.variable)?.value;
      const base = cur ?? chk.n;
      if (!holds(chk, base + delta)) { cd.verdict = "rejected"; cd.reason = `breaks "${r.title}" (${chk.variable} ${delta > 0 ? "+" : ""}${delta})`; break; }
    }
    if (cd.verdict === "rejected") continue;
    // Capacity, beside the chosen paths.
    const over: string[] = [];
    if (c.capacity.hours != null && used.hours + cd.hours > c.capacity.hours) over.push(`${used.hours + cd.hours} of ${c.capacity.hours} hours a week`);
    if (c.capacity.usd != null && used.usd + cd.usd > c.capacity.usd) over.push(`${money(used.usd + cd.usd)} of ${money(c.capacity.usd)} a month`);
    if (c.capacity.stress != null && Math.max(used.stress, cd.stress) > c.capacity.stress) over.push(`stress ${cd.stress} over a budget of ${c.capacity.stress}`);
    if (over.length) { cd.verdict = "rejected"; cd.reason = `does not fit your capacity: ${over.join(", ")}`; }
  }
  // Dominated by another path still standing.
  for (const cd of out) {
    if (cd.verdict === "rejected") continue;
    const beat = out.find((o) => o !== cd && o.verdict === "survivor" && dominates(o, cd, ids));
    if (beat) { cd.verdict = "rejected"; cd.reason = `${beat.title} is as good or better on every value and costs no more`; }
  }
  // 2 or 3 survivors, best first; the rest stay listed with the reason.
  const alive = out.filter((x) => x.verdict === "survivor").sort((a, b) => b.score - a.score);
  alive.slice(keep).forEach((x) => { x.verdict = "rejected"; x.reason = `ranked below the top ${keep} on your values`; });
  const top = alive.slice(0, keep);
  top.slice(1).forEach((x) => { x.swap = evenSwap(top[0]!, x, c.values); });
  return [...top, ...out.filter((x) => x.verdict === "rejected")];
}

// ── Context from the vault ──────────────────────────────────────────────────

function genContext(vault: string, doc: CompassDoc, goal: CompassItem, defs: { id: string; title: string }[], specs: { id: string; returns: string; ceiling: string }[]): GenContext {
  const live = (x: CompassItem) => x.tokens.status !== "proposed";
  const field = (it: { fields: { key: string; value: string }[] }, k: string) => it.fields.find((f) => f.key === k)?.value?.replace(/^"(.*)"$/, "$1");
  const values = items(doc, "value").filter(live).map((v, i) => ({ id: v.id, title: v.title, rank: Number(v.tokens.rank ?? i + 1) })).sort((a, b) => a.rank - b.rank);
  return {
    goal: { id: goal.id, title: goal.title, why: field(goal, "why") ?? field(goal, "words"), enough: field(goal, "enough"), due: goal.tokens.due, domain: goal.tokens.domain, serves: (goal.tokens.serves ?? "").split(",").filter(Boolean) },
    values,
    rules: items(doc, "rule").filter(live).map((r) => ({ id: r.id, title: r.title, ...(r.tokens.check ? { check: r.tokens.check } : {}) })),
    capacity: capacityOf(doc),
    active: activePaths(doc).filter((p) => p.goal !== goal.id).map((p) => ({ title: p.title, hours: p.hours, usd: p.usd, stress: p.stress })),
    specialists: specs,
    metrics: defs,
  };
}

async function sources(vault: string) {
  const { loadSpecialists } = await import("./specialists.ts");
  const { allDefs } = await import("./metrics.ts");
  const specs = loadSpecialists(vault).filter((s) => s.on).map((s) => ({ id: s.id, returns: s.returns, ceiling: s.ceiling }));
  const defs = allDefs(vault).map((d) => ({ id: d.id, title: d.title }));
  return { specs, defs };
}

export type Runner = (prompt: string) => Promise<string>;

/**
 * Propose paths for a goal: one model call (or `given` drafts), then code
 * screens them. Survivors replace the goal's earlier proposed path lines in
 * the Compass (chosen, trial, retired and rejected lines are never touched);
 * every candidate is kept in paths.json with its verdict.
 */
export async function proposePaths(vault: string, goalId: string, o: { runner?: Runner | null; given?: PathDraft[]; now?: number } = {}): Promise<{ goal: string; candidates: Candidate[]; method: "model" | "given" }> {
  const now = o.now ?? Date.now();
  const doc = readCompass(vault);
  const f = findById(doc, goalId);
  const goal = f.item;
  if (!goal || goal.kind !== "goal") throw new Error(`no goal ${goalId} in the Compass`);
  if (goal.tokens.status === "proposed") throw new Error("confirm the goal first: initiatives are proposed only for your own goals");
  const { specs, defs } = await sources(vault);
  const ctx = genContext(vault, doc, goal, defs, specs);
  let drafts = o.given ?? [];
  let method: "model" | "given" = "given";
  if (!o.given) {
    const run = o.runner ?? (await defaultRunner(vault));
    if (!run) throw new Error("no AI runtime available to propose paths");
    drafts = parsePaths(await run(pathsPrompt(ctx)), ctx);
    method = "model";
  }
  if (!drafts.length) throw new Error("no initiatives came back; try again");
  const vars = readSignals(vault);
  const cands = screenPaths(drafts, { values: ctx.values, rules: ctx.rules, vars, capacity: ctx.capacity, active: ctx.active });
  // The Compass: drop this goal's earlier proposed paths, add the survivors.
  const keepOld = goal.paths.filter((p) => (p.tokens.status ?? "proposed") !== "proposed");
  const fresh: CompassPath[] = cands.filter((c) => c.verdict === "survivor").filter((c) => !keepOld.some((p) => p.id === c.id)).map((c) => pathLine(c, ctx.values));
  goal.paths = [...keepOld, ...fresh];
  goal.dirty = true;
  saveCompass(vault, doc, [{ id: goal.id, from: "paths", to: `${fresh.length} proposed`, reason: `initiatives proposed (${method}), ${cands.length - fresh.length} left out`, evidence: cands.filter((c) => c.verdict === "rejected").map((c) => `${c.title}: ${c.reason}`).slice(0, 6), by: "model" }], now);
  const pf = readPathsFile(vault);
  pf.goals[goal.id] = { generated: now, method, candidates: cands };
  writePathsFile(vault, pf);
  return { goal: goal.id, candidates: cands, method };
}

function pathLine(c: Candidate, values: { id: string }[]): CompassPath {
  const vals = values.map((v) => `${v.id} ${c.values[v.id] && c.values[v.id]! > 0 ? "+" : ""}${c.values[v.id] ?? 0}`).join(", ");
  const fields = [
    { key: "why", value: c.why },
    { key: "hours", value: String(c.hours) }, { key: "usd", value: String(c.usd) }, { key: "stress", value: String(c.stress) },
    ...(c.needs.length ? [{ key: "needs", value: c.needs.join(", ") }] : []),
    ...(c.effects.length ? [{ key: "effects", value: c.effects.join(", ") }] : []),
    ...(vals ? [{ key: "values", value: vals }] : []),
    ...(c.expect.length ? [{ key: "expect", value: c.expect.join("; ") }] : []),
    ...(c.stop ? [{ key: "stop", value: c.stop }] : []),
    ...(c.swap ? [{ key: "swap", value: c.swap }] : []),
  ].filter((x) => x.value);
  return { id: c.id, title: c.title, tokens: { status: "proposed", kind: c.kind }, fields };
}

async function defaultRunner(vault: string): Promise<Runner | null> {
  const { detectClis, runChatTurn, defaultModelFor } = await import("./cli-bridge.ts");
  let clis = await detectClis();
  if (process.env.PREVAIL_BUNKER === "1") clis = clis.filter((c) => ["ollama", "lmstudio", "mlx"].includes(c.kind));
  const cli = clis.find((c) => c.kind === "claude") ?? clis.find((c) => c.kind === "codex") ?? clis[0];
  if (!cli) return null;
  const cwd = resolveDomainDir(vault, "general");
  try { mkdirSync(cwd, { recursive: true }); } catch { /* exists */ }
  return (prompt) => runChatTurn({ prompt, cwd, cli, model: defaultModelFor(cli.kind), isFirst: true, bare: true });
}

// ── 3. Choose: commit date, expectations, stop rule; install the work ───────

export interface Install { ts: number; path: string; goal: string; playbooks: string[]; loops: { domain: string; loop: string }[]; tasks: { domain: string; text: string }[]; mission?: string }

const ASK_SPECIALISTS = new Set(["writer", "operator", "negotiator", "liaison"]);
const GATE_SPECIALISTS = new Set(["steward", "auditor"]);

/** A path's playbook draft as a playbook file: ASK on anything that drafts to people or acts; GATE on checks. */
export function playbookFromDraft(d: PlaybookDraft, o: { id: string; domain: string; goalId: string; pathId: string }) {
  return {
    id: o.id, name: d.name, goal: d.goal, domain: o.domain, goalId: o.goalId, pathId: o.pathId,
    steps: d.steps.map((s, i) => ({
      kind: "specialist" as const, id: `s${i + 1}`, specialists: s.specialists, brief: s.brief,
      ...(i > 0 ? { uses: [`s${i}`] } : {}),
      ...(s.specialists.some((x) => ASK_SPECIALISTS.has(x)) ? { approval: "ask" as const } : {}),
      ...(s.specialists.some((x) => GATE_SPECIALISTS.has(x)) ? { gate: "stop" as const } : {}),
    })),
  };
}

export async function choosePath(vault: string, pathId: string, o: { until?: string; trial?: boolean; now?: number } = {}): Promise<Install> {
  const now = o.now ?? Date.now();
  const doc = readCompass(vault);
  const f = findById(doc, pathId);
  if (!f.path || !f.parent) throw new Error(`no initiative ${pathId} in the Compass`);
  const p = f.path;
  const g = f.parent;
  const from = p.tokens.status ?? "proposed";
  if (from === "chosen" || from === "trial") throw new Error(`${p.title} is already ${from}`);
  const cand = readPathsFile(vault).goals[g.id]?.candidates.find((c) => c.id === pathId);
  const until = o.until && /^\d{4}-\d{2}-\d{2}$/.test(o.until) ? o.until : ymd(now + (cand?.commitWeeks ?? 12) * 7 * DAY);
  p.tokens.status = o.trial ? "trial" : "chosen";
  p.tokens.until = until;
  p.tokens.approval = "ask"; // money, people, location or identity always ask; reversible and free runs alone
  if (!p.fields.some((x) => x.key === "stop")) p.fields.push({ key: "stop", value: "m-calm<3 for 6 weeks" });
  const domain = g.tokens.domain ?? "general";
  const inst: Install = { ts: now, path: pathId, goal: g.id, playbooks: [], loops: [], tasks: [] };
  // Install its playbooks, each on its cadence in the goal's domain.
  const { setTrigger } = await import("./playbooks.ts");
  const dir = join(buildRoot(vault), "playbooks");
  mkdirSync(dir, { recursive: true });
  for (const [i, d] of (cand?.playbooks ?? []).entries()) {
    let id = `${pathId}-${i + 1}`;
    for (let n = 2; existsSync(join(dir, `${id}.json`)); n++) id = `${pathId}-${i + 1}-${n}`;
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(playbookFromDraft(d, { id, domain, goalId: g.id, pathId }), null, 2)}\n`);
    inst.playbooks.push(id);
    inst.loops.push(setTrigger(vault, id, domain, { cadence: d.cadence }));
  }
  if (inst.playbooks.length) p.fields.push({ key: "playbooks", value: inst.playbooks.join(", ") });
  // A first task, so the path shows on Today with its thread (~initiative: walks the Compass chain).
  const { boardFile } = await import("./jobs.ts");
  const bf = boardFile(vault, domain);
  const text = `Start the initiative "${p.title}" toward ${g.title}`;
  const cur = existsSync(bf) ? readFileSync(bf, "utf8") : "";
  if (!cur.includes(text)) {
    mkdirSync(join(bf, ".."), { recursive: true });
    writeFileSync(bf, `${cur ? cur.replace(/\s*$/, "\n") : "# Tasks\n\n"}- [ ] ${text} @${ymd(now + 7 * DAY)} +${ymd(now)} ~src:path:${pathId} ~id:pa${now.toString(36).slice(-5)} ~initiative:${pathId}\n`);
    inst.tasks.push({ domain, text });
  }
  g.dirty = true;
  saveCompass(vault, doc, [{ id: pathId, from, to: p.tokens.status, reason: `chosen by you; commit until ${until}`, evidence: cand?.swap ? [cand.swap] : [], by: "user" }], now);
  // A path with an outcome and a date carries out a mission.
  if (cand?.outcome) {
    try { const m = await (await import("./mission-progress.ts")).missionFromPath(vault, pathId, now); inst.mission = m.slug; } catch { /* the mission can be started later from the path */ }
  }
  mkdirSync(compassMetaDir(vault), { recursive: true });
  appendFileSync(installsFile(vault), `${JSON.stringify(inst)}\n`);
  return inst;
}

export function readInstalls(vault: string): Install[] {
  try { return readFileSync(installsFile(vault), "utf8").split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as Install] : []; } catch { return []; } }); } catch { return []; }
}

/** Retire a path (with the reason): its loops stop; nothing is deleted. */
export async function retirePath(vault: string, pathId: string, because: string, now = Date.now()): Promise<{ loops: number }> {
  if (!because.trim()) throw new Error("retiring an initiative needs a because");
  const doc = readCompass(vault);
  const f = findById(doc, pathId);
  if (!f.path || !f.parent) throw new Error(`no initiative ${pathId} in the Compass`);
  const from = f.path.tokens.status ?? "proposed";
  f.path.tokens.status = from === "proposed" ? "rejected" : "retired";
  f.path.fields = f.path.fields.filter((x) => x.key !== "because");
  f.path.fields.push({ key: "because", value: one(because) });
  f.parent.dirty = true;
  saveCompass(vault, doc, [{ id: pathId, from, to: f.path.tokens.status, reason: one(because), by: "user" }], now);
  const { setTrigger } = await import("./playbooks.ts");
  let loops = 0;
  for (const inst of readInstalls(vault).filter((x) => x.path === pathId)) {
    for (const [i, id] of inst.playbooks.entries()) { try { setTrigger(vault, id, inst.loops[i]?.domain ?? "general", { cadence: "weekly", enabled: false }); loops++; } catch { /* gone */ } }
  }
  return { loops };
}

// ── 4. The weekly expectation check ─────────────────────────────────────────

export interface PathCheck {
  id: string; title: string; goal: string; goalTitle: string; status: string; until?: string;
  state: "on-track" | "missing" | "too-early" | "stop" | "unmeasured";
  lines: string[]; explanation: string; proposal: string; reopen: boolean;
}

export function checkPathsWith(doc: CompassDoc, weekly: (metric: string) => number[], o: { now: number; chosenAt: (id: string) => number | null; ranRecently: (id: string) => boolean | null; rulesBroken: string[]; alternatives: (goal: string, except: string) => string[] }): PathCheck[] {
  const out: PathCheck[] = [];
  for (const g of items(doc, "goal")) {
    for (const p of g.paths) {
      const st = p.tokens.status ?? "proposed";
      if (st !== "chosen" && st !== "trial") continue;
      const until = p.tokens.until;
      const since = o.chosenAt(p.id);
      const lines: string[] = [];
      let missing = 0;
      let measured = 0;
      for (const f of p.fields.filter((x) => x.key === "expect")) for (const part of f.value.split(/[;,]/)) {
        const c = parseCheck(part.trim().replace(/\s+/g, ""));
        if (!c || !c.variable.startsWith("m-")) continue;
        const w = weekly(c.variable).slice(-4);
        if (w.length < 2) { lines.push(`${c.variable}: not enough weeks yet`); continue; }
        measured++;
        const avg = Math.round((w.reduce((a, b) => a + b, 0) / w.length) * 10) / 10;
        const ok = holds(c, avg);
        if (!ok) missing++;
        lines.push(`${c.variable} averages ${avg} a week over ${w.length} weeks; expected ${c.op} ${c.n}${ok ? "" : " (missing)"}`);
      }
      let stopHit = false;
      for (const f of p.fields.filter((x) => x.key === "stop")) {
        const m = /^([^\s]+)(?:\s+for\s+(\d+)\s+weeks?)?$/i.exec(f.value.trim());
        const c = parseCheck(m?.[1]?.replace(/\s+/g, ""));
        if (!c || !c.variable.startsWith("m-")) continue;
        const n = Number(m?.[2] ?? 4);
        const w = weekly(c.variable).slice(-n);
        if (w.length >= n && w.every((v) => holds(c, v))) { stopHit = true; lines.push(`stop rule met: ${f.value}`); }
      }
      const ran = o.ranRecently(p.id);
      if (ran === false) { missing++; lines.push("its playbooks have not run when they should have"); }
      const brokenRule = o.rulesBroken.length > 0;
      const early = since != null && o.now - since < 14 * DAY;
      const beforeCommit = !!until && ymd(o.now) < until;
      const alt = o.alternatives(g.id, p.id);
      let state: PathCheck["state"] = stopHit ? "stop" : early ? "too-early" : missing ? "missing" : measured || ran ? "on-track" : "unmeasured";
      let explanation = "";
      let proposal = "";
      const reopen = stopHit || brokenRule || (!beforeCommit && missing > 0);
      if (state === "stop") { explanation = `${p.title} hit its stop rule.`; proposal = alt.length ? `Stop it and switch to ${alt[0]}.` : "Stop it, or choose a new initiative for the goal."; }
      else if (state === "missing") {
        explanation = `${p.title} is missing ${missing} of its expectations.`;
        proposal = beforeCommit && !brokenRule
          ? `Keep going until ${until} as committed; look at what is in the way (your if-then plan).`
          : alt.length ? `Switch to ${alt[0]}, or lower the expectation to what you actually do.` : "Lower the expectation to what you actually do, or retire the initiative.";
        if (brokenRule) proposal = `A non-negotiable is broken (${o.rulesBroken.join(", ")}): ${proposal}`;
      } else if (state === "too-early") explanation = `${p.title} was chosen less than two weeks ago.`;
      else if (state === "unmeasured") explanation = `${p.title} has no expectation written as a metric yet.`;
      else explanation = `${p.title} is on track.`;
      if (state !== "missing" && state !== "stop" && brokenRule) { state = "missing"; proposal = `A non-negotiable is broken (${o.rulesBroken.join(", ")}); reconsider this initiative before ${until ?? "its commit date"}.`; }
      out.push({ id: p.id, title: p.title, goal: g.id, goalTitle: g.title, status: st, ...(until ? { until } : {}), state, lines, explanation, proposal, reopen });
    }
  }
  return out;
}

/** The weekly check on the vault: metrics, the ledger, playbook runs, the rules. Misses may spend the interruption budget (path-miss). */
export async function checkPaths(vault: string, now = Date.now()): Promise<PathCheck[]> {
  const doc = readCompass(vault);
  const m = await import("./metrics.ts");
  const c = await m.computeMetrics(vault, { now });
  const weekly = (id: string) => { const def = c.defs.find((d) => d.id === id); const w = m.weekly(c.points[id] ?? [], def?.days, def?.avg); return [...w.keys()].sort().slice(0, -1).map((k) => w.get(k) ?? 0); };
  const { readLedger } = await import("./compass.ts");
  const ledger = readLedger(vault);
  const chosenAt = (id: string) => ledger.filter((l) => l.id === id && (l.to === "chosen" || l.to === "trial")).map((l) => l.ts).pop() ?? null;
  const installs = readInstalls(vault);
  const { listJobs } = await import("./jobs.ts");
  const runs = listJobs(vault, 400);
  const ranRecently = (id: string): boolean | null => {
    const inst = installs.filter((x) => x.path === id);
    const pbs = inst.flatMap((x) => x.playbooks);
    if (!pbs.length) return null;
    const since = chosenAt(id) ?? 0;
    if (now - since < 10 * DAY) return null;
    return runs.some((j) => j.playbook && pbs.includes(j.playbook) && j.created > now - 10 * DAY);
  };
  const broken = evaluateRules(doc, readSignals(vault)).filter((r) => r.state === "broken").map((r) => r.title);
  const alternatives = (goal: string, except: string) => items(doc, "goal").find((g) => g.id === goal)?.paths.filter((p) => (p.tokens.status ?? "proposed") === "proposed" && p.id !== except).map((p) => p.title) ?? [];
  const checks = checkPathsWith(doc, weekly, { now, chosenAt, ranRecently, rulesBroken: broken, alternatives });
  mkdirSync(compassMetaDir(vault), { recursive: true });
  writeFileSync(checksFile(vault), `${JSON.stringify({ computed: now, checks }, null, 2)}\n`);
  const { tryInterrupt } = await import("./interruptions.ts");
  const { weekOf, dayOf } = m;
  for (const x of checks.filter((y) => y.state === "missing" || y.state === "stop")) tryInterrupt(vault, { kind: "path-miss", text: `${x.explanation} ${x.proposal}`, key: `path:${x.id}:${weekOf(dayOf(now))}` }, now);
  return checks;
}

export function readPathChecks(vault: string): { computed: number; checks: PathCheck[] } | null {
  try { return JSON.parse(readFileSync(checksFile(vault), "utf8")) as { computed: number; checks: PathCheck[] }; } catch { return null; }
}

// ── 5. The quarterly path review ────────────────────────────────────────────

export const quarterOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`; };

export interface QuarterReview { quarter: string; paths: { id: string; title: string; goal: string; verdict: "keep" | "switch" | "drop"; why: string }[]; stalled: { id: string; title: string; suggestion: string }[]; woop: string[]; file: string }

/** Keep, switch or drop each path against its expectations; stalled goals offered a release with a replacement. Code only. */
export async function quarterlyReview(vault: string, now = Date.now()): Promise<QuarterReview> {
  const checks = await checkPaths(vault, now);
  const doc = readCompass(vault);
  const paths = checks.map((c) => {
    const verdict: "keep" | "switch" | "drop" = c.state === "stop" ? "drop" : c.state === "missing" && c.reopen ? (c.proposal.startsWith("Switch") || /switch to/i.test(c.proposal) ? "switch" : "drop") : "keep";
    return { id: c.id, title: c.title, goal: c.goalTitle, verdict, why: c.state === "missing" || c.state === "stop" ? `${c.explanation} ${c.proposal}` : c.explanation };
  });
  let stalled: QuarterReview["stalled"] = [];
  try {
    const { readRadar, computeRadar } = await import("./radar.ts");
    const r = readRadar(vault, now) ?? (await computeRadar(vault, { now }));
    stalled = r.items.filter((x) => x.kind === "goal").map((x) => {
      const id = x.key.replace(/^goal:/, "");
      const g = items(doc, "goal").find((y) => y.id === id);
      const alt = g?.paths.find((p) => (p.tokens.status ?? "proposed") === "proposed");
      return { id, title: g?.title ?? x.text, suggestion: alt ? `Release it, or try the initiative "${alt.title}" instead.` : "Release it with no shame, or ask me for a smaller target." };
    });
  } catch { /* no radar */ }
  const { goalsNeedingWoop } = await import("./compass.ts");
  const woop = goalsNeedingWoop(vault).map((g) => g.title);
  const quarter = quarterOf(now);
  const dir = join(resolveDomainDir(vault, "general"), "memory", "reviews");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `paths-${quarter}.md`);
  const md = [
    `# Initiatives, ${quarter}`, "", `Written by code on ${ymd(now)} from your Compass, its paths' expectations and the radar.`, "",
    "## Each initiative", ...(paths.length ? paths.map((p) => `- ${p.verdict.toUpperCase()}: ${p.title} (${p.goal}). ${p.why}`) : ["- No chosen initiatives yet."]), "",
    "## Goals gone quiet", ...(stalled.length ? stalled.map((s) => `- ${s.title}: ${s.suggestion}`) : ["- None."]), "",
    "## WOOP again", ...(woop.length ? woop.map((w) => `- ${w}: what is the outcome, the obstacle in you, and an if-then plan?`) : ["- Every goal has its if-then plan."]), "",
  ].join("\n");
  writeFileSync(file, md);
  mkdirSync(compassMetaDir(vault), { recursive: true });
  writeFileSync(join(compassMetaDir(vault), "quarter.json"), JSON.stringify({ quarter, ts: now }));
  return { quarter, paths, stalled, woop, file: file.slice(vault.length + 1) };
}

/** Is this quarter's review still owed (the weekly review asks once a quarter)? */
export function quarterlyDue(vault: string, now = Date.now()): boolean {
  try { return (JSON.parse(readFileSync(join(compassMetaDir(vault), "quarter.json"), "utf8")) as { quarter: string }).quarter !== quarterOf(now); } catch { return items(readCompass(vault), "goal").some((g) => g.paths.some((p) => ["chosen", "trial"].includes(p.tokens.status ?? ""))); }
}

/** The path map for one goal: the Compass lines and every candidate with its verdict. */
export function pathMap(vault: string, goalId: string): { goal: string; title: string; paths: (PathModel & { kind?: string; until?: string; swap?: string; expect?: string; why?: string; because?: string; playbooks?: string; mission?: string; check?: { state: string; explanation: string; proposal: string } })[]; left: { title: string; kind: string; reason?: string }[]; generated?: number } {
  const doc = readCompass(vault);
  const g = items(doc, "goal").find((x) => x.id === goalId);
  if (!g) throw new Error(`no goal ${goalId}`);
  const field = (p: CompassPath, k: string) => p.fields.find((f) => f.key === k)?.value;
  const pf = readPathsFile(vault).goals[goalId];
  const checks = readPathChecks(vault)?.checks ?? [];
  return {
    goal: g.id, title: g.title,
    paths: g.paths.map((p) => ({ ...pathModel(p, g), ...(p.tokens.kind ? { kind: p.tokens.kind } : {}), ...(field(p, "mission") ? { mission: field(p, "mission") } : {}), ...((() => { const c = checks.find((x) => x.id === p.id); return c ? { check: { state: c.state, explanation: c.explanation, proposal: c.proposal } } : {}; })()), ...(p.tokens.until ? { until: p.tokens.until } : {}), ...(field(p, "swap") ? { swap: field(p, "swap") } : {}), ...(field(p, "expect") ? { expect: field(p, "expect") } : {}), ...(field(p, "why") ? { why: field(p, "why") } : {}), ...(field(p, "because") ? { because: field(p, "because") } : {}), ...(field(p, "playbooks") ? { playbooks: field(p, "playbooks") } : {}) })),
    left: (pf?.candidates ?? []).filter((c) => c.verdict === "rejected").map((c) => ({ title: c.title, kind: c.kind, ...(c.reason ? { reason: c.reason } : {}) })),
    ...(pf ? { generated: pf.generated } : {}),
  };
}

// ── CLI: prevail compass paths <goal> [--generate] | path choose|retire <id> | paths check|review ──

export async function pathsCommand(sub: string, argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (m: string) => { if (args.json) out({ ok: false, error: m }); else console.error(m); return 1; };
  try {
    if (sub === "paths") {
      const what = args.pos[1] ?? "";
      if (what === "check") { const c = await checkPaths(vault); if (args.json) out(c); else for (const x of c) console.log(`${x.state.padEnd(10)} ${x.title}: ${x.explanation} ${x.proposal}`); return 0; }
      if (what === "review") { const r = await quarterlyReview(vault); if (args.json) out(r); else console.log(`Wrote ${r.file}`); return 0; }
      if (!what) return fail("usage: prevail compass paths <goal-id> [--generate] | check | review");
      if (args.has("generate")) {
        const r = await proposePaths(vault, what, args.has("no-model") ? { runner: null } : {});
        if (args.json) out({ ok: true, ...r });
        else for (const c of r.candidates) console.log(`${c.verdict === "survivor" ? "+" : "-"} ${c.title} (${c.kind})${c.reason ? `: ${c.reason}` : ""}${c.swap ? `\n    ${c.swap}` : ""}`);
        return 0;
      }
      const m = pathMap(vault, what);
      if (args.json) out(m); else for (const p of m.paths) console.log(`${p.status.padEnd(9)} ${p.title}${p.swap ? `  (${p.swap})` : ""}`);
      return 0;
    }
    if (sub === "path") {
      const act = args.pos[1] ?? "";
      const id = args.pos[2] ?? "";
      if (act === "choose" || act === "trial") { const r = await choosePath(vault, id, { until: args.get("until"), trial: act === "trial" || args.has("trial") }); if (args.json) out({ ok: true, ...r }); else console.log(`Chosen. Installed ${r.playbooks.length} playbook(s)${r.mission ? ` and the mission ${r.mission}` : ""}.`); return 0; }
      if (act === "retire") { const r = await retirePath(vault, id, args.get("because") ?? args.pos.slice(3).join(" ")); if (args.json) out({ ok: true, ...r }); else console.log(`Retired; ${r.loops} loop(s) stopped.`); return 0; }
      return fail("usage: prevail compass path choose|trial|retire <path-id> [--until YYYY-MM-DD] [--because T]");
    }
  } catch (e) { return fail((e as Error).message); }
  return fail("unknown");
}
