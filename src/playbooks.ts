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
import { loopOfPlaybook, migrateLoops, nextRun, scheduledPlaybooks, verifyMigration } from "./daemon-loops.ts";
import { parseModArgs } from "./cli-args.ts";

export type PlaybookGroup = "running" | "scheduled" | "yours" | "drafts" | "built-in";
/** When a playbook runs on its own (playbooks replace loops). nextRunTs is null when it waits for an event or is off. */
export interface ScheduleView { space: string; cadence: string; on?: string; enabled: boolean; status: string; autonomy: string; lastRunTs: number | null; nextRunTs: number | null; loop?: string }
export interface StepRow { n: number; kind: PlaybookStep["kind"]; label: string; specialists: string[]; returns: string[]; gate: boolean; ask: boolean; domain?: string }
export interface PlaybookRow { id: string; name: string; goal: string; domain?: string; group: PlaybookGroup; source: "yours" | "built-in"; draft: boolean; steps: number; running: boolean; lastRun?: { ts: number; status: string }; schedule?: ScheduleView }
export interface PlaybookViewT extends PlaybookRow { rows: StepRow[]; triggers: { domain: string; loop: string; cadence: string; enabled: boolean; on?: string }[]; runs: { id: string; status: string; ts: number; summary?: string }[]; goalId?: string; pathId?: string; from?: string }

const yoursDir = (vault: string) => join(buildRoot(vault), "playbooks");
const isYours = (vault: string, id: string) => userPlaybookDirs(vault).some((d) => existsSync(join(d, `${id}.json`)));

function rowsOf(vault: string, pb: Playbook, specs: Specialist[]): StepRow[] {
  const autonomy = pb.schedule?.autonomy ?? "suggest";
  return pb.steps.map((s, i) => {
    if (s.kind === "specialist") {
      const ids = s.specialists ?? (s.specialist ? [s.specialist] : []);
      return { n: i + 1, kind: s.kind, label: s.label ?? s.brief, specialists: ids, returns: ids.map((x) => specs.find((y) => y.id === x)?.returns ?? "?"), gate: s.gate === "stop", ask: s.approval === "ask", ...(s.domain ? { domain: s.domain } : {}) };
    }
    if (s.kind === "loop") {
      const l = s.loop as { name?: string; purpose?: string; kind?: string; playbook?: string };
      const label = l.playbook ? `Runs the playbook ${loadPlaybook(vault, l.playbook)?.name ?? l.playbook}` : (l.purpose || l.name || s.loop.id);
      return { n: i + 1, kind: s.kind, label: String(label).slice(0, 200), specialists: [], returns: [l.kind === "briefing" ? "page" : l.kind === "scout" ? "list" : "tasks"], gate: false, ask: autonomy === "ask" };
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
    const schedule = yours && pb.schedule ? scheduleView(pb as Playbook & { schedule: NonNullable<Playbook["schedule"]> }) : undefined;
    const lastRun = runs[0] ? { ts: runs[0].created, status: runs[0].status } : schedule?.lastRunTs ? { ts: schedule.lastRunTs, status: "done" } : undefined;
    out.push({ id: pb.id, name: pb.name, goal: pb.goal, ...(pb.domain ? { domain: pb.domain } : {}), group: running ? "running" : draft ? "drafts" : schedule ? "scheduled" : yours ? "yours" : "built-in", source: yours ? "yours" : "built-in", draft, steps: pb.steps.length, running, ...(lastRun ? { lastRun } : {}), ...(schedule ? { schedule } : {}) });
  }
  const order: PlaybookGroup[] = ["running", "scheduled", "yours", "drafts", "built-in"];
  return out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name));
}

/** The schedule of a playbook, as the runner sees it (next run from its cadence and last run). */
export function scheduleView(pb: Playbook & { schedule: NonNullable<Playbook["schedule"]> }): ScheduleView {
  const l = loopOfPlaybook(pb);
  return { space: pb.schedule.space, cadence: l.cadence, ...(l.on ? { on: l.on } : {}), enabled: l.enabled, status: l.status ?? "active", autonomy: l.autonomy ?? "suggest", lastRunTs: l.lastRunTs, nextRunTs: nextRun(l), loop: l.id };
}

/** What runs a playbook on its own: its own schedule, a scheduled playbook that runs it, or a loop not yet carried over. */
export function playbookTriggers(vault: string, id: string): PlaybookViewT["triggers"] {
  const out: PlaybookViewT["triggers"] = [];
  const seen = new Set<string>();
  for (const x of scheduledPlaybooks(vault)) {
    const l = loopOfPlaybook(x.pb);
    if (x.pb.id !== id && l.playbook !== id) continue;
    seen.add(`${x.pb.schedule.space}/${l.id}`);
    out.push({ domain: x.pb.schedule.space, loop: l.id, cadence: l.on ? `on ${l.on}` : l.cadence ?? "", enabled: l.enabled !== false, ...(l.on ? { on: l.on } : {}) });
  }
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    try {
      const doc = JSON.parse(readFileSync(join(resolveDomainDir(vault, d), "_loops.json"), "utf8")) as { loops?: { id: string; playbook?: string; cadence?: string; enabled?: boolean; on?: string }[] };
      for (const l of doc.loops ?? []) if (l.playbook === id && !seen.has(`${d}/${l.id}`)) out.push({ domain: d, loop: l.id, cadence: l.on ? `on ${l.on}` : l.cadence ?? "", enabled: l.enabled !== false, ...(l.on ? { on: l.on } : {}) });
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
  return { ...(row ?? { id, name: pb.name, goal: pb.goal, group: "built-in" as const, source: "built-in" as const, draft: !!pb.draft, steps: pb.steps.length, running: false }), rows: rowsOf(vault, pb, specs), triggers: playbookTriggers(vault, id), runs, ...(pb.goalId ? { goalId: pb.goalId } : {}), ...(pb.pathId ? { pathId: pb.pathId } : {}), ...(pb.from ? { from: pb.from } : {}) };
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

export interface InboxResult { runId: string; playbook: string; name: string; trigger: "schedule" | "event"; event?: string; domain?: string; ok: boolean; note: string; ts: number; waiting: number; steps: { label: string; ok: boolean; decision: string; note: string; specialists?: string[] }[] }
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
      const r = JSON.parse(readFileSync(join(root, id, "run.json"), "utf8")) as { runId: string; playbook: string; name?: string; ok: boolean; note: string; steps: { label: string; ok: boolean; decision: string; note: string; specialists?: string[] }[]; trigger?: string; event?: string; domain?: string; ts?: number };
      if (r.trigger !== "schedule" && r.trigger !== "event") continue;
      out.push({ runId: r.runId, playbook: r.playbook, name: r.name ?? r.playbook, trigger: r.trigger, ...(r.event ? { event: r.event } : {}), ...(r.domain ? { domain: r.domain } : {}), ok: r.ok, note: r.note, ts: r.ts ?? statSync(join(root, id, "run.json")).mtimeMs, waiting: r.steps.filter((x) => x.decision === "ask").length, steps: r.steps.map((x) => ({ label: x.label, ok: x.ok, decision: x.decision, note: x.note.slice(0, 300), ...(Array.isArray(x.specialists) && x.specialists.length ? { specialists: x.specialists.filter((y) => typeof y === "string").slice(0, 6) } : {}) })) });
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
 * Put a playbook on a schedule or an event in a domain (or mission). One of
 * yours carries the schedule itself; a built-in one gets a small playbook of
 * yours that runs it (pb-<id>), so the built-in file is never copied. An
 * existing schedule is updated, never doubled.
 */
export function setTrigger(vault: string, id: string, space: string, o: { cadence?: "daily" | "weekly" | "monthly"; on?: string; enabled?: boolean; autonomy?: "ask" | "auto" }): { domain: string; loop: string; playbook: string } {
  const pb = loadPlaybook(vault, id);
  if (!pb) throw new Error(`no playbook ${id}`);
  if (!o.cadence && !o.on && o.enabled === undefined) throw new Error("a trigger needs a cadence (daily, weekly, monthly) or an event (on: <radar kind>)");
  if (o.on && !/^(commitment|waiting|routine|relationship|goal|path|admin|domain|decision|mission|rule)(:[^\n]{1,60})?$/.test(o.on)) throw new Error(`unknown event ${o.on}`);
  const dir = resolveDomainDir(vault, space.startsWith("mission/") ? `_mission-${space.slice(8)}` : space);
  if (!space.startsWith("mission/") && (!dir || !existsSync(dir))) throw new Error(`no domain or project ${space}`);
  const now = Date.now();
  const yours = isYours(vault, id);
  // A scheduled playbook that already runs this one in that space (a carried-over loop, or a wrapper).
  const existing = scheduledPlaybooks(vault, space).find((x) => x.pb.id === id || loopOfPlaybook(x.pb).playbook === id);
  const target: Playbook = existing ? existing.pb : yours ? pb : { id: `pb-${id}`.slice(0, 80), name: pb.name, goal: pb.goal, domain: space, steps: [{ kind: "loop", id: "s1", label: pb.name, loop: { id: `pb-${id}`.slice(0, 60), name: `Playbook: ${pb.name}`, purpose: pb.goal.slice(0, 200), kind: "steward", type: "open", condition: "", evaluation: "", actions: [], playbook: id, createdTs: now } }] };
  const prev = target.schedule;
  target.schedule = {
    space, ...(prev?.loop ? { loop: prev.loop } : {}),
    cadence: o.cadence ?? prev?.cadence ?? "weekly",
    ...(o.on ? { on: o.on } : o.cadence ? {} : prev?.on ? { on: prev.on } : {}),
    enabled: o.enabled ?? true, status: prev?.status ?? "active",
    autonomy: o.autonomy ?? prev?.autonomy ?? "auto",
    ...(prev?.model ? { model: prev.model } : {}),
    lastRunTs: prev?.lastRunTs ?? null, createdTs: prev?.createdTs ?? now,
  };
  mkdirSync(yoursDir(vault), { recursive: true });
  writeFileSync(existing?.file ?? join(yoursDir(vault), `${target.id}.json`), `${JSON.stringify(target, null, 2)}\n`);
  return { domain: space, loop: loopOfPlaybook(target as Playbook & { schedule: NonNullable<Playbook["schedule"]> }).id, playbook: target.id };
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
      const r = setTrigger(vault, args.pos[1] ?? "", args.get("domain") ?? "general", { ...(cad ? { cadence: cad } : {}), ...(args.get("on") ? { on: args.get("on") } : {}), ...(args.has("off") ? { enabled: false } : args.has("resume") ? { enabled: true } : {}), ...(args.get("autonomy") === "ask" ? { autonomy: "ask" as const } : {}) });
      if (args.json) out({ ok: true, ...r }); else console.log(`${args.pos[1]} runs from ${r.domain}/${r.loop}`);
      return 0;
    }
    if (sub === "migrate-loops") {
      const r = migrateLoops(vault, { dryRun: args.has("dry-run") });
      const v = r.dryRun ? null : verifyMigration(vault);
      if (args.json) out({ ok: !v || v.differ.length === 0, ...r, ...(v ? { verify: v } : {}) });
      else {
        console.log(`${r.dryRun ? "Would carry" : "Carried"} ${r.migrated.length} loop${r.migrated.length === 1 ? "" : "s"} into playbooks (${r.already} already were).`);
        if (v) console.log(`Checked ${v.checked}: ${v.same} run the same${v.differ.length ? `, ${v.differ.length} differ` : ""}.`);
        for (const d of v?.differ ?? []) console.log(`  ${d.space}/${d.loop}: ${d.why}`);
      }
      return v && v.differ.length ? 1 : 0;
    }
    if (sub === "verify-loops") { const v = verifyMigration(vault); if (args.json) out(v); else console.log(`Checked ${v.checked}: ${v.same} run the same, ${v.differ.length} differ.`); return v.differ.length ? 1 : 0; }
    if (sub === "adopt") { const pb = adoptPlaybook(vault, args.pos[1] ?? ""); if (args.json) out({ ok: true, playbook: pb }); else console.log(`${pb.id} is one of yours now`); return 0; }
  } catch (e) { return fail((e as Error).message); }
  return fail("usage: prevail playbooks rows | show <id> | save <job-id> [--name N] [--adopt] | adopt <id> | inbox | seen <run-id> | trigger <id> --domain d (--cadence daily|weekly|monthly | --on <radar kind>[:words]) [--off|--resume] | migrate-loops [--dry-run] | verify-loops [--json]");
}
