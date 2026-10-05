// Work mode's Herdr half, on the spaces.ts layer (herdrOn, domainPanes,
// launchLine's --settings rule for Claude Code).
//
// Machines. Each Mac writes only its own record,
// build/_meta/machines/<host>.json, when a work command runs; `machines()`
// merges those records with this Mac's saved Herdr machines
// (`herdr machine list --json`) and the private Glyph map's labels and roots
// when one is present (read at run time, never copied into code). A Mac with
// a record but no saved Herdr machine here is "missing": adding it is the
// user's call (`work machine-add`, with an SSH target they type).
//
// Agent kinds come from `herdr agent start --help` (its possible values),
// cached per process, with a fallback list.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { readChiefOfStaff } from "./chief-of-staff.ts";
import { readMachineRole } from "./config.ts";
import { domainDir } from "./decisions.ts";
import { readJob } from "./jobs.ts";
import { runtimePath } from "./path-safety.ts";
import { getSpecialist } from "./specialists.ts";
import { domainPanes, herdrOn, mapDir, type Herdr } from "./spaces.ts";
import { threadFiles } from "./thread-schedule.ts";
import { appendTurn, defaultSpawnSelf, note, readSettings, readTask, syncBoard, updateTask, withLease, writeSettings, type HerdrRef, type WorkDeps, type WorkTask } from "./work.ts";
import { FALLBACK_AGENT_KINDS, folderOf, folderPath, type CatalogMachine } from "./work-router.ts";

export interface Machine {
  /** "local" for this Mac, else the saved Herdr machine's label or id. */
  id: string;
  hostname?: string;
  label: string;
  role?: "hub" | "client";
  current: boolean;
  herdr: "saved" | "disabled" | "missing" | "local";
  vaultRoot?: string;
  lastSeen?: number;
}

export interface MachineRecord {
  hostname: string;
  label: string;
  role: "hub" | "client";
  herdrVersion: string | null;
  vaultRoot: string;
  homeRoot: string;
  monoRoot?: string;
  herdrMachines: string[];
  lastSeen: number;
}

export interface MachineDeps {
  /** herdr on this Mac (tests pass a fake that records argv). */
  herdr?: Herdr;
  now?: number;
  host?: string;
  role?: "hub" | "client";
  env?: Record<string, string | undefined>;
}

/** This Mac's host key: its hostname, lowercased, without .local. */
export function hostKey(host = hostname()): string {
  return host.toLowerCase().replace(/\.local$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "host";
}

interface GlyphMachine { role?: string; tag?: string; roots?: Record<string, string | null> }

/** The private Glyph map's machines (labels and roots), when one is reachable. Runtime only. */
export function glyphMachines(env: Record<string, string | undefined> = process.env): Record<string, GlyphMachine> {
  try {
    const j = JSON.parse(readFileSync(join(mapDir(env), "machines.json"), "utf8")) as { machines?: Record<string, GlyphMachine> };
    return j.machines && typeof j.machines === "object" ? j.machines : {};
  } catch { return {}; }
}

const expand = (p: string | null | undefined) => (!p ? undefined : p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** This Mac: its label (PREVAIL_MACHINE, else its Glyph tag, else its host key) and roots. */
export function thisMachine(vault: string, deps: MachineDeps = {}): { hostname: string; label: string; roots: { vault: string; home: string; mono?: string } } {
  const env = deps.env ?? process.env;
  const key = hostKey(deps.host);
  const g = glyphMachines(env)[key];
  const label = env.PREVAIL_MACHINE?.trim() || g?.tag?.trim() || key;
  const mono = expand(env.PREVAIL_MONO_ROOT) ?? expand(g?.roots?.mono ?? undefined);
  return { hostname: key, label, roots: { vault, home: homedir(), ...(mono ? { mono } : {}) } };
}

export const machinesDir = (vault: string) => join(runtimePath(vault, "_meta"), "machines");

export interface SavedHerdrMachine { id: string; label: string; enabled: boolean }

/** This Mac's saved Herdr machines; [] when herdr is missing or has none. */
export function savedHerdrMachines(h: Herdr): SavedHerdrMachine[] {
  let raw: unknown;
  try { raw = h(["machine", "list", "--json"]); } catch { return []; }
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { machines?: unknown }).machines) ? (raw as { machines: unknown[] }).machines : [];
  const out: SavedHerdrMachine[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const label = String(r.label ?? r.name ?? r.id ?? "").trim();
    if (!label) continue;
    out.push({ id: String(r.id ?? label), label, enabled: r.enabled !== false && r.disabled !== true });
  }
  return out;
}

function herdrVersion(h: Herdr): string | null {
  try { const v = h(["--version"]); return typeof v === "string" ? v.trim().replace(/^herdr\s+/, "") || null : null; } catch { return null; }
}

/** Write this Mac's record (only its own). Skipped when written in the last ten minutes. */
export function writeMachineRecord(vault: string, deps: MachineDeps = {}): MachineRecord {
  const now = deps.now ?? Date.now();
  const me = thisMachine(vault, deps);
  const p = join(machinesDir(vault), `${me.hostname}.json`);
  try {
    const cur = JSON.parse(readFileSync(p, "utf8")) as MachineRecord;
    if (cur.lastSeen && now - cur.lastSeen < 10 * 60_000 && cur.label === me.label && cur.vaultRoot === vault) return cur;
  } catch { /* first write */ }
  const h = deps.herdr ?? herdrOn("local");
  const rec: MachineRecord = {
    hostname: me.hostname, label: me.label, role: deps.role ?? readMachineRole(), herdrVersion: herdrVersion(h),
    vaultRoot: vault, homeRoot: me.roots.home, ...(me.roots.mono ? { monoRoot: me.roots.mono } : {}),
    herdrMachines: savedHerdrMachines(h).map((m) => m.label), lastSeen: now,
  };
  mkdirSync(machinesDir(vault), { recursive: true });
  writeFileSync(p, `${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}

export function readMachineRecords(vault: string): MachineRecord[] {
  const dir = machinesDir(vault);
  if (!existsSync(dir)) return [];
  const out: MachineRecord[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    try { const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as MachineRecord; if (r?.hostname && r.label) out.push(r); } catch { /* skip */ }
  }
  return out;
}

/** Every machine work can go to, this one first. */
export function machines(vault: string, deps: MachineDeps = {}): Machine[] {
  const me = thisMachine(vault, deps);
  const h = deps.herdr ?? herdrOn("local");
  const records = readMachineRecords(vault);
  const glyph = glyphMachines(deps.env ?? process.env);
  const mine = records.find((r) => r.hostname === me.hostname);
  const out: Machine[] = [{ id: "local", hostname: me.hostname, label: me.label, role: deps.role ?? mine?.role ?? readMachineRole(), current: true, herdr: "local", vaultRoot: vault, ...(mine ? { lastSeen: mine.lastSeen } : {}) }];
  const seen = new Set([me.label, me.hostname]);
  const recordFor = (label: string) => records.find((r) => r.label === label || r.hostname === label);
  for (const s of savedHerdrMachines(h)) {
    if (seen.has(s.label)) continue;
    const r = recordFor(s.label);
    out.push({ id: s.id, label: s.label, current: false, herdr: s.enabled ? "saved" : "disabled", ...(r ? { hostname: r.hostname, role: r.role, vaultRoot: r.vaultRoot, lastSeen: r.lastSeen } : {}) });
    seen.add(s.label);
    if (r) seen.add(r.hostname);
  }
  for (const r of records) {
    if (seen.has(r.label) || seen.has(r.hostname)) continue;
    out.push({ id: r.label, hostname: r.hostname, label: r.label, role: r.role, current: false, herdr: "missing", vaultRoot: r.vaultRoot, lastSeen: r.lastSeen });
    seen.add(r.label);
  }
  // Macs the Glyph map knows that have never run work here: missing too, by their tag.
  for (const [key, g] of Object.entries(glyph)) {
    const label = g.tag?.trim() || key;
    if (seen.has(label) || seen.has(key)) continue;
    out.push({ id: label, hostname: key, label, ...(g.role === "hub" ? { role: "hub" as const } : {}), current: false, herdr: "missing" });
    seen.add(label);
  }
  return out;
}

export const asCatalogMachines = (ms: Machine[]): CatalogMachine[] => ms.map((m) => ({ label: m.label, current: m.current, herdr: m.herdr, ...(m.role ? { role: m.role } : {}) }));

let kindsCache: string[] | null = null;

/** The agent kinds this Herdr can start, from `herdr agent start --help`. */
export function agentKinds(h: Herdr = herdrOn("local"), fresh = false): string[] {
  if (kindsCache && !fresh) return kindsCache;
  let kinds: string[] = [];
  try {
    const help = h(["agent", "start", "--help"]);
    const m = typeof help === "string" ? /possible values:\s*([^\]]+)\]/.exec(help) : null;
    kinds = m ? m[1]!.split(",").map((x) => x.trim()).filter((x) => /^[a-z][a-z0-9_-]{0,31}$/.test(x)) : [];
  } catch { kinds = []; }
  kindsCache = kinds.length ? kinds : FALLBACK_AGENT_KINDS;
  return kindsCache;
}

/** The command that saves a missing machine in Herdr, for the user to confirm with an SSH target. */
export function machineAddCommand(label: string, target = "<ssh target>"): string {
  return `herdr machine add --label ${label} ${target}`;
}

/** Save a machine in Herdr: only on the user's explicit yes, with the SSH target they typed. */
export function addMachine(label: string, target: string, h: Herdr = herdrOn("local")): { label: string; target: string; output: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(label)) throw new Error("a machine label is letters, digits, dots, dashes (at most 40)");
  if (!/^[A-Za-z0-9._@:-]{1,120}$/.test(target) || target.startsWith("-")) throw new Error("an SSH target is user@host or a host alias");
  const r = h(["machine", "add", "--label", label, target]);
  return { label, target, output: typeof r === "string" ? r.trim() : JSON.stringify(r) };
}

// ── The bridge: a task in a Herdr tab ───────────────────────────────────────

const herdrFor = (deps: WorkDeps, machine: string): Herdr => deps.herdrFor?.(machine) ?? herdrOn(machine);

/** The Herdr id for a machine label: "local" for this Mac, else the saved machine (null when it is not saved and enabled). */
function herdrMachine(vault: string, label: string, deps: WorkDeps): string | null {
  const ms = machines(vault, { ...deps.machine, herdr: herdrFor(deps, "local") });
  const m = ms.find((x) => x.label === label);
  if (!m) return null;
  if (m.current) return "local";
  return m.herdr === "saved" ? m.id : null;
}

/** The folder the agent works in, found again on the machine it runs on. */
export function taskCwd(vault: string, t: WorkTask, machine: string, deps: WorkDeps = {}): string {
  const me = thisMachine(vault, deps.machine);
  const local = me.roots;
  const roots = machine === "local" ? local : (() => {
    const r = readMachineRecords(vault).find((x) => x.label === t.machine || x.hostname === t.machine);
    return r ? { vault: r.vaultRoot, home: r.homeRoot, ...(r.monoRoot ? { mono: r.monoRoot } : {}) } : {};
  })();
  const f = t.dest?.folder ?? folderOf(domainDir(vault, t.thread.space), local);
  return folderPath(f, roots) ?? (machine === "local" ? domainDir(vault, t.thread.space) : "~");
}

/** The brief the agent gets first: the task, its home, the team's mandates and the user's rules. */
export function buildBrief(vault: string, t: WorkTask, o: { history?: string } = {}): string {
  const job = t.jobId ? readJob(vault, t.jobId) : null;
  const chief = readChiefOfStaff(vault);
  const team = (job?.team ?? []).flatMap((s) => s.specialists).map((id) => getSpecialist(vault, id)).filter((s): s is NonNullable<typeof s> => !!s);
  const lines = [
    "You are working on one task for the user's chief of staff in Prevail. Prevail keeps this conversation in the user's vault.",
    `Task: ${t.text}`,
    ...(t.goal && t.goal !== t.text ? [`Goal it serves: ${t.goal}`] : []),
    `Where it belongs: ${t.dest ? `${t.dest.label} (${t.dest.kind})` : "General"}.`,
    ...(team.length ? ["", "Work the way these specialists would:", ...team.map((s) => `- ${s.name}: ${s.mandate.replace(/\s+/g, " ").slice(0, 300)}`)] : []),
    "", "Rules:",
    "- Draft, never send: do not email, message, post, buy, pay, book or sign anything. Write the draft and stop.",
    "- Ask before anything that cannot be undone, and before touching money, people, where the user lives or who they are.",
    ...(chief.neverRead.length ? [`- Never read these areas unless the task names them: ${chief.neverRead.join(", ")}.`] : []),
    `- Stay within about $${job?.budget.usd ?? chief.limits.usd} and ${job?.budget.minutes ?? chief.limits.minutes} minutes of work, then report.`,
    ...(job?.askReason ? [`- Why this asked first: ${job.askReason}.`] : []),
    "", "End with a short summary: what you did, what you filed, and what is left.",
  ];
  if (o.history) lines.unshift("Pick this task back up. The conversation so far:", "", o.history, "", "---", "");
  return lines.join("\n");
}

const agentName = (taskId: string) => `pw-${taskId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(-24)}`.replace(/-+$/, "");

interface WsRow { workspace_id: string; label: string; tab_count?: number }
function findWorkspace(h: Herdr, label: string): WsRow | null {
  const r = h(["workspace", "list"]) as { workspaces?: WsRow[] } | undefined;
  return (r?.workspaces ?? []).find((w) => w.label === label) ?? null;
}

/**
 * Open the task in Herdr: the destination's own agent pane when one is open
 * and idle here, else a new tab (--cwd, --no-focus) in the workspace mapped to
 * its space. A missing workspace is only created on the user's yes. Then the
 * agent starts (Claude Code with the act-gate hook) and gets the brief, and a
 * detached mirror copies its output into the thread.
 */
export async function launchTask(vault: string, id: string, deps: WorkDeps = {}, o: { createWorkspace?: boolean; workspace?: string; reopen?: boolean } = {}): Promise<WorkTask> {
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  const t = r.task;
  const ask = (kind: "herdr-workspace" | "machine-add" | "start", detail: string, command?: string) => {
    const x = updateTask(vault, id, (y) => { y.status = "needs-you"; y.ask = { kind, detail, ...(command ? { command } : {}) }; note(y, "asks", detail, now); });
    syncBoard(vault, x);
    return x;
  };
  const machine = herdrMachine(vault, t.machine, deps);
  if (!machine) return ask("machine-add", `${t.machine} is not a saved Herdr machine here`, machineAddCommand(t.machine));
  const h = herdrFor(deps, machine);
  const settings = readSettings(vault);
  let history = "";
  if (o.reopen) {
    const md = threadFiles(vault, t.thread.space, t.thread.session).find((f) => f.endsWith(".md"));
    if (md) history = readFileSync(md, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim().slice(-4000);
  }
  const brief = buildBrief(vault, t, { history });
  let ref: HerdrRef;
  try {
    // The destination's own agent, open and idle on this Mac: prompt it there.
    const pane = machine === "local" && t.dest?.kind === "domain" && !o.reopen ? domainPanes(vault, h).get(t.dest.id) : undefined;
    if (pane?.agent && (pane.agent_status === "idle" || pane.agent_status === "done")) {
      ref = { machine: t.machine, workspaceLabel: "", paneId: pane.pane_id, agent: pane.pane_id, createdTab: false };
    } else {
      const label = o.workspace?.trim() || settings.workspaces[t.thread.space] || settings.workspace;
      const cwd = taskCwd(vault, t, machine, deps);
      const env = ["--env", `PREVAIL_DOMAIN=${t.thread.space}`, "--env", `PREVAIL_THREAD_ID=${t.thread.session}`];
      const ws = findWorkspace(h, label);
      let paneId: string;
      let tabId: string;
      let created = false;
      let workspaceId: string;
      if (!ws) {
        if (!o.createWorkspace) return ask("herdr-workspace", `create the Herdr workspace "${label}" on ${t.machine}?`);
        const c = h(["workspace", "create", "--label", label, "--cwd", cwd, ...env, "--no-focus"]) as { workspace?: { workspace_id: string }; tab?: { tab_id: string }; root_pane?: { pane_id: string } };
        if (!c?.workspace?.workspace_id || !c.tab?.tab_id || !c.root_pane?.pane_id) throw new Error("herdr did not return the new workspace");
        workspaceId = c.workspace.workspace_id; tabId = c.tab.tab_id; paneId = c.root_pane.pane_id; created = true;
        if (o.workspace && o.workspace !== settings.workspace) writeSettings(vault, { workspaces: { ...settings.workspaces, [t.thread.space]: o.workspace } });
      } else {
        const c = h(["tab", "create", "--workspace", ws.workspace_id, "--cwd", cwd, "--label", t.text.replace(/\s+/g, " ").slice(0, 30).trim(), ...env, "--no-focus"]) as { tab?: { tab_id: string }; root_pane?: { pane_id: string } };
        if (!c?.tab?.tab_id || !c.root_pane?.pane_id) throw new Error("herdr did not return the new tab");
        workspaceId = ws.workspace_id; tabId = c.tab.tab_id; paneId = c.root_pane.pane_id;
      }
      const name = agentName(t.id);
      // Claude Code carries Prevail's act-gate hook; the hook file lives on this Mac, so a remote Claude runs without it.
      const settingsPath = t.agentKind === "claude" && machine === "local" ? (deps.settingsPath ?? defaultSettingsPath)(vault, t.thread.space) : null;
      h(["agent", "start", name, "--kind", t.agentKind, "--pane", paneId, ...(settingsPath ? ["--", "--settings", settingsPath] : [])]);
      ref = { machine: t.machine, workspaceLabel: label, workspaceId, tabId, paneId, agent: name, createdWorkspace: created || (t.herdr?.createdWorkspace === true && t.herdr.workspaceLabel === label), createdTab: true };
    }
    h(["agent", "prompt", ref.agent!, brief]);
  } catch (e) {
    return ask("start", `Herdr could not start it: ${(e as Error).message.slice(0, 200)}`);
  }
  const next = updateTask(vault, id, (x) => {
    x.herdr = ref; x.status = "running"; delete x.ask;
    note(x, o.reopen ? "reopened" : "in Herdr", `${ref.workspaceLabel || "its own pane"} on ${x.machine}`, now);
    if (machine !== "local" && x.agentKind === "claude") note(x, "no act gate", "the hook file lives on this Mac; the remote agent runs without it", now);
  });
  syncBoard(vault, next);
  (deps.spawnSelf ?? defaultSpawnSelf(vault))(["work", "mirror", id]);
  return next;
}

function defaultSettingsPath(vault: string, space: string): string {
  // Loaded lazily: it writes the hook file under the user's config.
  const { actGateSettingsPath } = require("./act-gate.ts") as typeof import("./act-gate.ts");
  const { vaultLockActive } = require("./config.ts") as typeof import("./config.ts");
  return actGateSettingsPath(vault, space, vaultLockActive());
}

/** What a read added since the last one: the text after the last mirrored tail. */
export function newText(prev: string | undefined, cur: string): string {
  if (!prev) return cur;
  const anchor = prev.slice(-400);
  const i = cur.lastIndexOf(anchor);
  return i >= 0 ? cur.slice(i + anchor.length) : cur;
}

const readText = (r: unknown): string => {
  if (typeof r === "string") return r;
  const o = (r ?? {}) as Record<string, unknown>;
  for (const k of ["text", "content", "output"]) if (typeof o[k] === "string") return o[k] as string;
  if (Array.isArray(o.lines)) return (o.lines as unknown[]).map(String).join("\n");
  const read = o.read as Record<string, unknown> | undefined;
  return read ? readText(read) : "";
};

const statusOf = (r: unknown): string => {
  const o = (r ?? {}) as Record<string, unknown>;
  const a = (o.agent ?? o) as Record<string, unknown>;
  return String(a.agent_status ?? a.status ?? "");
};

/**
 * Mirror the agent's work into the thread until it settles: wait, read,
 * append only what is new. Blocked means the user must answer in Herdr; idle
 * or done ends the run and asks keep or close. The mirror holds the lease.
 */
export async function mirrorTask(vault: string, id: string, deps: WorkDeps = {}, o: { maxRounds?: number; waitMs?: number } = {}): Promise<WorkTask> {
  const clock = deps.now ?? Date.now;
  const r = readTask(vault, id);
  if (!r?.task.herdr?.agent) throw new Error(`task ${id} has no Herdr agent`);
  const machine = herdrMachine(vault, r.task.machine, deps);
  if (!machine) throw new Error(`${r.task.machine} is not reachable from here`);
  const h = herdrFor(deps, machine);
  const agent = r.task.herdr.agent;
  const until = clock() + 6 * 3_600_000;
  await withLease(vault, id, deps, async () => {
    for (let round = 0; round < (o.maxRounds ?? 10_000) && clock() < until; round++) {
      const cur = readTask(vault, id)?.task;
      if (!cur || !(cur.status === "running" || cur.status === "needs-you") || cur.herdr?.agent !== agent) break;
      try { h(["agent", "wait", agent, "--timeout", String(o.waitMs ?? 600_000)]); } catch { /* a timeout: read what there is */ }
      let text = "";
      let status = "";
      try { text = readText(h(["agent", "read", agent, "--source", "recent-unwrapped", "--lines", "400"])); status = statusOf(h(["agent", "get", agent])); } catch (e) {
        // The agent is gone (its tab closed by hand): stop mirroring.
        updateTask(vault, id, (x) => { note(x, "mirror ended", (e as Error).message.slice(0, 200), clock()); if (x.status === "running") { x.status = "done"; x.ask = { kind: "keep-close", detail: "the Herdr agent is gone; close its place here?" }; } });
        break;
      }
      const fresh = newText(cur.herdr?.lastRead, text).trim();
      const settled = status === "idle" || status === "done";
      const t = updateTask(vault, id, (x) => {
        if (fresh) appendTurn(vault, x, "assistant", fresh, x.agentKind, clock());
        if (x.herdr) x.herdr.lastRead = text.slice(-2000);
        if (status === "blocked" && x.status === "running") { x.status = "needs-you"; x.ask = { kind: "start", detail: "the agent is waiting for your answer in Herdr" }; }
        else if (status === "working" && x.status === "needs-you" && x.ask?.kind === "start") { x.status = "running"; delete x.ask; }
        else if (settled && (x.status === "running" || x.status === "needs-you")) { x.status = "done"; x.ask = { kind: "keep-close", detail: "done; keep the Herdr tab open, or close it?" }; note(x, "done", undefined, clock()); }
      });
      syncBoard(vault, t);
      if (settled) break;
    }
  });
  return readTask(vault, id)!.task;
}

/** Esc to the agent: it stops what it is doing and waits. */
export function pauseHerdr(vault: string, t: WorkTask, deps: WorkDeps = {}): void {
  if (!t.herdr?.agent) return;
  const h = herdrFor(deps, herdrMachine(vault, t.herdr.machine, deps) ?? "local");
  h(["agent", "send-keys", t.herdr.agent, "esc"]);
}

/** Continue in the same tab: the paused agent is asked to go on, and the mirror picks up again. False when the agent is gone. */
export function resumeHerdr(vault: string, id: string, deps: WorkDeps = {}): boolean {
  const r = readTask(vault, id);
  const ref = r?.task.herdr;
  if (!r || !ref?.agent) return false;
  const machine = herdrMachine(vault, ref.machine, deps);
  if (!machine) return false;
  try { herdrFor(deps, machine)(["agent", "prompt", ref.agent, "Continue where you left off."]); } catch { return false; }
  const now = (deps.now ?? Date.now)();
  const t = updateTask(vault, id, (x) => { x.status = "running"; delete x.ask; note(x, "resumed", "in its Herdr tab", now); });
  syncBoard(vault, t);
  (deps.spawnSelf ?? defaultSpawnSelf(vault))(["work", "mirror", id]);
  return true;
}

/** Close what Prevail opened: the tab, and the workspace only when Prevail created it and nothing else is in it. */
export function closeHerdr(vault: string, t: WorkTask, deps: WorkDeps = {}): void {
  const ref = t.herdr;
  if (!ref?.tabId || ref.createdTab === false) return;
  const machine = herdrMachine(vault, ref.machine, deps) ?? "local";
  const h = herdrFor(deps, machine);
  h(["tab", "close", ref.tabId]);
  if (ref.createdWorkspace && ref.workspaceId) {
    let left = 1;
    try { left = ((h(["tab", "list", "--workspace", ref.workspaceId]) as { tabs?: unknown[] })?.tabs ?? []).length; } catch { left = 0; }
    if (left === 0) { try { h(["workspace", "close", ref.workspaceId]); } catch { /* already closed */ } }
  }
}

/** Close: the Herdr side goes, the task and its history stay (reopen brings it back). */
export function closeTask(vault: string, id: string, deps: WorkDeps = {}): WorkTask {
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  closeHerdr(vault, r.task, deps);
  const t = updateTask(vault, id, (x) => {
    if (x.herdr) x.herdr = { machine: x.herdr.machine, workspaceLabel: x.herdr.workspaceLabel, ...(x.herdr.workspaceId ? { workspaceId: x.herdr.workspaceId } : {}), ...(x.herdr.createdWorkspace ? { createdWorkspace: true } : {}) };
    delete x.ask;
    if (x.status !== "done") x.status = "closed";
    note(x, "closed", "its Herdr tab", now);
  });
  syncBoard(vault, t);
  return t;
}

/** Reopen: a new tab in the same place, the conversation so far as the first prompt (the detached run does it). */
export function reopenTask(vault: string, id: string, deps: WorkDeps = {}): WorkTask {
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  if (r.task.executor !== "herdr") throw new Error("only a Herdr task reopens; continue an engine task instead");
  if (r.task.herdr?.tabId && r.task.status === "running") return r.task;
  const t = updateTask(vault, id, (x) => { x.status = "running"; delete x.ask; note(x, "reopening", undefined, now); });
  syncBoard(vault, t);
  (deps.spawnSelf ?? defaultSpawnSelf(vault))(["work", "run", id, "--reopen"]);
  return t;
}

