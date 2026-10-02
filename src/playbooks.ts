// Playbooks as the user sees them (specialists-plan Phase 2): Running, Yours,
// Drafts (saved from chat), Built in; one playbook's steps as rows with their
// specialists, GATE and ASK markers and typed results; what triggers it (the
// loops that name it); its run history (jobs with origin playbook).
//
// "Save as playbook" turns a job (its owner, team and ask) into a playbook in
// build/playbooks/<id>.json. When the job's last result is the Planner's plan,
// its numbered steps become the playbook: a step that names a specialist is a
// specialist step, any other is a task for the user. A save from chat is a
// draft until the user adopts it. Nothing is overwritten: a taken id gets -2.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRoot, resolveDomainDir, runtimePath } from "./path-safety.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { listPlaybooks, loadPlaybook, userPlaybookDirs, type Playbook, type PlaybookStep } from "./orchestrator.ts";
import { jobDir, jobView, listJobs, readJob, type Job } from "./jobs.ts";
import { loadSpecialists, type Specialist } from "./specialists.ts";
import { parseModArgs } from "./cli-args.ts";

export type PlaybookGroup = "running" | "yours" | "drafts" | "built-in";
export interface StepRow { n: number; kind: PlaybookStep["kind"]; label: string; specialists: string[]; returns: string[]; gate: boolean; ask: boolean; domain?: string }
export interface PlaybookRow { id: string; name: string; goal: string; domain?: string; group: PlaybookGroup; source: "yours" | "built-in"; draft: boolean; steps: number; running: boolean; lastRun?: { ts: number; status: string } }
export interface PlaybookViewT extends PlaybookRow { rows: StepRow[]; triggers: { domain: string; loop: string; cadence: string; enabled: boolean; on?: string }[]; runs: { id: string; status: string; ts: number; summary?: string }[]; goalId?: string; pathId?: string; from?: string }

const yoursDir = (vault: string) => join(buildRoot(vault), "playbooks");
const isYours = (vault: string, id: string) => userPlaybookDirs(vault).some((d) => existsSync(join(d, `${id}.json`)));

function rowsOf(pb: Playbook, specs: Specialist[]): StepRow[] {
  return pb.steps.map((s, i) => {
    if (s.kind === "specialist") {
      const ids = s.specialists ?? (s.specialist ? [s.specialist] : []);
      return { n: i + 1, kind: s.kind, label: s.label ?? s.brief, specialists: ids, returns: ids.map((x) => specs.find((y) => y.id === x)?.returns ?? "?"), gate: s.gate === "stop", ask: s.approval === "ask", ...(s.domain ? { domain: s.domain } : {}) };
    }
    const label = s.label ?? (s.kind === "skill" ? `${s.app}: ${s.skill}` : s.kind === "agent" ? s.goal.slice(0, 120) : s.kind === "task" ? s.text : s.kind === "glance" ? "This week in numbers" : s.instruction.slice(0, 120));
    const returns = s.kind === "glance" || s.kind === "synthesize" ? ["page"] : s.kind === "task" ? ["task"] : s.kind === "skill" ? ["data"] : ["result"];
    return { n: i + 1, kind: s.kind, label, specialists: [], returns, gate: false, ask: s.kind === "agent", ...("domain" in s && s.domain ? { domain: s.domain } : {}) };
  });
}

function runsOf(vault: string, id: string): Job[] {
  return listJobs(vault, 400).filter((j) => j.playbook === id || j.id.startsWith(`pb-${id}-`));
}

/** Every playbook in its group, Running first. */
export function playbookRows(vault: string): PlaybookRow[] {
  const out: PlaybookRow[] = [];
  for (const p of listPlaybooks(vault)) {
    const pb = loadPlaybook(vault, p.id);
    if (!pb) continue;
    const runs = runsOf(vault, p.id);
    const running = runs.some((j) => j.status === "running");
    const yours = isYours(vault, p.id);
    const draft = !!pb.draft;
    out.push({ id: pb.id, name: pb.name, goal: pb.goal, ...(pb.domain ? { domain: pb.domain } : {}), group: running ? "running" : draft ? "drafts" : yours ? "yours" : "built-in", source: yours ? "yours" : "built-in", draft, steps: pb.steps.length, running, ...(runs[0] ? { lastRun: { ts: runs[0].created, status: runs[0].status } } : {}) });
  }
  const order: PlaybookGroup[] = ["running", "yours", "drafts", "built-in"];
  return out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name));
}

/** The loops that run a playbook, across domains. */
export function playbookTriggers(vault: string, id: string): PlaybookViewT["triggers"] {
  const out: PlaybookViewT["triggers"] = [];
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    try {
      const doc = JSON.parse(readFileSync(join(resolveDomainDir(vault, d), "_loops.json"), "utf8")) as { loops?: { id: string; playbook?: string; cadence?: string; enabled?: boolean; on?: string }[] };
      for (const l of doc.loops ?? []) if (l.playbook === id) out.push({ domain: d, loop: l.id, cadence: l.on ? `on ${l.on}` : l.cadence ?? "", enabled: l.enabled !== false, ...(l.on ? { on: l.on } : {}) });
    } catch { /* no loops */ }
  }
  return out;
}

export function playbookView(vault: string, id: string): PlaybookViewT | null {
  const pb = loadPlaybook(vault, id);
  if (!pb) return null;
  const row = playbookRows(vault).find((r) => r.id === id);
  const specs = loadSpecialists(vault);
  const runs = runsOf(vault, id).slice(0, 20).map((j) => ({ id: j.id, status: j.status, ts: j.created, ...(j.result?.summary ? { summary: j.result.summary } : j.why ? { summary: j.why } : {}) }));
  return { ...(row ?? { id, name: pb.name, goal: pb.goal, group: "built-in" as const, source: "built-in" as const, draft: !!pb.draft, steps: pb.steps.length, running: false }), rows: rowsOf(pb, specs), triggers: playbookTriggers(vault, id), runs, ...(pb.goalId ? { goalId: pb.goalId } : {}), ...(pb.pathId ? { pathId: pb.pathId } : {}), ...(pb.from ? { from: pb.from } : {}) };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "playbook";

/**
 * A Planner's plan as playbook steps: each numbered line is a step; a line
 * that names a specialist that is on (by name) becomes that specialist's step
 * (ASK kept when the line says ASK); any other line is a task for the user.
 */
export function planToSteps(plan: string, specs: Specialist[], domain?: string): PlaybookStep[] {
  const on = specs.filter((s) => s.on);
  const steps: PlaybookStep[] = [];
  for (const raw of plan.split("\n")) {
    const m = /^\s*(?:\d+[.)]|[-*])\s+(.+)$/.exec(raw);
    if (!m) continue;
    const text = m[1]!.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    if (text.length < 4) continue;
    const ask = /\bASK\b/.test(text);
    const who = on.filter((s) => new RegExp(`\\b${s.name}\\b`, "i").test(text));
    const clean = text.replace(/\s*\(?\bASK\b\)?\s*/g, " ").replace(/\s+/g, " ").trim();
    const due = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1];
    if (who.length) steps.push({ kind: "specialist", id: `s${steps.length + 1}`, specialists: who.map((s) => s.id), brief: clean.slice(0, 300), ...(domain ? { domain } : {}), ...(ask || who.some((s) => s.ceiling === "draft") ? { approval: "ask" as const } : {}), ...(who.some((s) => s.id === "steward" || s.id === "auditor") ? { gate: "stop" as const } : {}) });
    else steps.push({ kind: "task", id: `s${steps.length + 1}`, text: clean.slice(0, 200), ...(domain ? { domain } : {}), ...(due ? { due } : {}) });
    if (steps.length >= 20) break;
  }
  return steps;
}

function freeId(vault: string, base: string): string {
  let id = slug(base);
  for (let n = 2; existsSync(join(yoursDir(vault), `${id}.json`)) || loadPlaybook(vault, id); n++) id = `${slug(base).slice(0, 56)}-${n}`;
  return id;
}

/**
 * Save a job as a playbook. A Planner's plan becomes its steps; any other job
 * keeps its team, step by step, with the job's ask as each step's brief.
 * Saved as a draft unless `adopt` (the user said "save", not "draft").
 */
export function saveJobAsPlaybook(vault: string, jobId: string, o: { name?: string; draft?: boolean; now?: number } = {}): Playbook {
  const job = readJob(vault, jobId);
  if (!job) throw new Error(`no job ${jobId}`);
  const specs = loadSpecialists(vault);
  const owner = job.domains.owner || undefined;
  const view = jobView(vault, jobId);
  let steps: PlaybookStep[] = [];
  const planner = (view?.steps as { specialist: string; result?: { file: string } }[] | undefined)?.find((s) => s.specialist === "planner" && s.result);
  if (planner) {
    try { steps = planToSteps((JSON.parse(readFileSync(join(jobDir(vault, jobId), planner.result!.file), "utf8")) as { body?: string }).body ?? "", specs, owner); } catch { steps = []; }
  }
  if (!steps.length) {
    steps = job.team.map((t, i) => ({ kind: "specialist" as const, id: `s${i + 1}`, specialists: t.specialists, brief: t.brief ?? job.ask, ...(t.gate ? { gate: "stop" as const } : {}), ...(t.specialists.some((x) => specs.find((s) => s.id === x)?.ceiling === "draft") ? { approval: "ask" as const } : {}) }));
  }
  const name = (o.name ?? job.ask).replace(/\s+/g, " ").trim().slice(0, 80);
  const pb: Playbook = { id: freeId(vault, name), name, goal: job.ask.slice(0, 400), ...(owner ? { domain: owner } : {}), steps, ...(o.draft !== false ? { draft: true } : {}), from: jobId };
  mkdirSync(yoursDir(vault), { recursive: true });
  writeFileSync(join(yoursDir(vault), `${pb.id}.json`), `${JSON.stringify(pb, null, 2)}\n`);
  return pb;
}

/** A draft becomes one of yours (the file stays where it is; only the flag goes). */
export function adoptPlaybook(vault: string, id: string): Playbook {
  const p = join(yoursDir(vault), `${id}.json`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(id) || !existsSync(p)) throw new Error(`no playbook of yours named ${id}`);
  const pb = JSON.parse(readFileSync(p, "utf8")) as Playbook;
  delete pb.draft;
  writeFileSync(p, `${JSON.stringify(pb, null, 2)}\n`);
  return pb;
}

// ── Results of scheduled and event runs land in the Inbox ───────────────────

export interface InboxResult { runId: string; playbook: string; name: string; trigger: "schedule" | "event"; event?: string; domain?: string; ok: boolean; note: string; ts: number; waiting: number; steps: { label: string; ok: boolean; decision: string; note: string }[] }
const seenPath = (vault: string) => join(runtimePath(vault, "_meta"), "jobs", "inbox-seen.json");
function readSeen(vault: string): string[] { try { return JSON.parse(readFileSync(seenPath(vault), "utf8")) as string[]; } catch { return []; } }

/** Playbook runs the user did not start (a loop's clock, a radar event), newest first, until marked seen. */
export function playbookInbox(vault: string, limit = 30): InboxResult[] {
  const root = join(runtimePath(vault, "_meta"), "jobs");
  if (!existsSync(root)) return [];
  const seen = new Set(readSeen(vault));
  const out: InboxResult[] = [];
  for (const id of readdirSync(root)) {
    if (seen.has(id) || !/^(loop|event)-/.test(id)) continue;
    try {
      const r = JSON.parse(readFileSync(join(root, id, "run.json"), "utf8")) as { runId: string; playbook: string; name?: string; ok: boolean; note: string; steps: { label: string; ok: boolean; decision: string; note: string }[]; trigger?: string; event?: string; domain?: string; ts?: number };
      if (r.trigger !== "schedule" && r.trigger !== "event") continue;
      out.push({ runId: r.runId, playbook: r.playbook, name: r.name ?? r.playbook, trigger: r.trigger, ...(r.event ? { event: r.event } : {}), ...(r.domain ? { domain: r.domain } : {}), ok: r.ok, note: r.note, ts: r.ts ?? statSync(join(root, id, "run.json")).mtimeMs, waiting: r.steps.filter((x) => x.decision === "ask").length, steps: r.steps.map((x) => ({ label: x.label, ok: x.ok, decision: x.decision, note: x.note.slice(0, 300) })) });
    } catch { /* not a finished run */ }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export function markSeen(vault: string, runId: string): void {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(runId)) throw new Error(`bad run id ${runId}`);
  const s = readSeen(vault).filter((x) => x !== runId);
  s.push(runId);
  mkdirSync(join(seenPath(vault), ".."), { recursive: true });
  writeFileSync(seenPath(vault), JSON.stringify(s.slice(-500)));
}

/**
 * Put a playbook on a schedule or an event in a domain (or mission): a loop
 * in that space's _loops.json with playbook (and on, for an event). An
 * existing loop for the same playbook is updated, never doubled.
 */
export function setTrigger(vault: string, id: string, space: string, o: { cadence?: "daily" | "weekly" | "monthly"; on?: string; enabled?: boolean; autonomy?: "ask" | "auto" }): { domain: string; loop: string } {
  if (!loadPlaybook(vault, id)) throw new Error(`no playbook ${id}`);
  if (!o.cadence && !o.on) throw new Error("a trigger needs a cadence (daily, weekly, monthly) or an event (on: <radar kind>)");
  if (o.on && !/^(commitment|waiting|routine|relationship|goal|path|admin|domain|decision|mission|rule)(:[^\n]{1,60})?$/.test(o.on)) throw new Error(`unknown event ${o.on}`);
  const dir = resolveDomainDir(vault, space);
  if (!dir || !existsSync(dir)) throw new Error(`no domain or mission ${space}`);
  const file = join(dir, "_loops.json");
  let doc: { schema?: number; desiredState?: string; loops: Record<string, unknown>[] } = { schema: 1, desiredState: "", loops: [] };
  try { doc = JSON.parse(readFileSync(file, "utf8")); doc.loops ??= []; } catch { /* new file */ }
  const loopId = `pb-${id}`.slice(0, 60);
  const now = Date.now();
  let l = doc.loops.find((x) => x.id === loopId || (x.playbook === id && !!x.on === !!o.on));
  if (!l) { l = { id: loopId, name: `Playbook: ${loadPlaybook(vault, id)!.name}`, purpose: loadPlaybook(vault, id)!.goal.slice(0, 200), kind: "steward", type: "open", condition: "", evaluation: "", actions: [], status: "active", lastRunTs: null, createdTs: now }; doc.loops.push(l); }
  Object.assign(l, { playbook: id, cadence: o.cadence ?? (l.cadence as string | undefined) ?? "weekly", autonomy: o.autonomy ?? (l.autonomy as string | undefined) ?? "auto", enabled: o.enabled ?? true });
  if (o.on) l.on = o.on; else delete l.on;
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { domain: space, loop: String(l.id) };
}

export async function playbooksCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "rows";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (m: string) => { if (args.json) out({ ok: false, error: m }); else console.error(m); return 1; };
  try {
    if (sub === "rows") { const r = playbookRows(vault); if (args.json) out(r); else for (const x of r) console.log(`${x.group.padEnd(9)} ${x.id.padEnd(28)} ${x.name}`); return 0; }
    if (sub === "show") { const v = playbookView(vault, args.pos[1] ?? ""); if (!v) return fail(`no playbook ${args.pos[1] ?? ""}`); if (args.json) out(v); else for (const r of v.rows) console.log(`${r.n} ${r.specialists.join(" + ") || r.kind}${r.gate ? " GATE" : ""}${r.ask ? " ASK" : ""}  ${r.label}  -> ${r.returns.join(", ")}`); return 0; }
    if (sub === "save") { const pb = saveJobAsPlaybook(vault, args.pos[1] ?? "", { name: args.get("name"), draft: !args.has("adopt") }); if (args.json) out({ ok: true, playbook: pb }); else console.log(`Saved ${pb.draft ? "draft " : ""}playbook ${pb.id} (${pb.steps.length} steps)`); return 0; }
    if (sub === "inbox") { const r = playbookInbox(vault); if (args.json) out(r); else for (const x of r) console.log(`${x.trigger.padEnd(8)} ${x.name}: ${x.note}${x.event ? ` (on ${x.event})` : ""}`); return 0; }
    if (sub === "seen") { markSeen(vault, args.pos[1] ?? ""); if (args.json) out({ ok: true }); return 0; }
    if (sub === "trigger") {
      const cad = args.get("cadence") as "daily" | "weekly" | "monthly" | undefined;
      const r = setTrigger(vault, args.pos[1] ?? "", args.get("domain") ?? "general", { ...(cad ? { cadence: cad } : {}), ...(args.get("on") ? { on: args.get("on") } : {}), ...(args.has("off") ? { enabled: false } : {}), ...(args.get("autonomy") === "ask" ? { autonomy: "ask" as const } : {}) });
      if (args.json) out({ ok: true, ...r }); else console.log(`${args.pos[1]} runs from ${r.domain}/${r.loop}`);
      return 0;
    }
    if (sub === "adopt") { const pb = adoptPlaybook(vault, args.pos[1] ?? ""); if (args.json) out({ ok: true, playbook: pb }); else console.log(`${pb.id} is one of yours now`); return 0; }
  } catch (e) { return fail((e as Error).message); }
  return fail("usage: prevail playbooks rows | show <id> | save <job-id> [--name N] [--adopt] | adopt <id> | inbox | seen <run-id> | trigger <id> --domain d (--cadence daily|weekly|monthly | --on <radar kind>[:words]) [--off] [--json]");
}
