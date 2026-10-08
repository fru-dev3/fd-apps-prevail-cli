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

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { readChiefOfStaff } from "./chief-of-staff.ts";
import { readMachineRole } from "./config.ts";
import { domainDir } from "./decisions.ts";
import { readJob } from "./jobs.ts";
import { runtimePath } from "./path-safety.ts";
import { getSpecialist } from "./specialists.ts";
import { herdrBin, herdrOn, mapDir, readSpaces, type Herdr } from "./spaces.ts";
import { threadFiles } from "./thread-schedule.ts";
import { addMilestone, appendTurn, defaultSpawnSelf, distilMilestone, distilOutcome, milestoneDue, finish, note, readSettings, addUpdate, readTask, syncBoard, updateTask, withLease, workDir, type HerdrRef, type WorkDeps, type WorkTask } from "./work.ts";
import { FALLBACK_AGENT_KINDS, folderOf, folderPath, noDash, type CatalogMachine } from "./work-router.ts";

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
  /** Glyph is installed here, so Work mode launches agents through it. */
  glyph?: boolean;
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
    herdrMachines: savedHerdrMachines(h).map((m) => m.label), glyph: existsSync(join(homedir(), ".config", "glyph", "glyph.zsh")), lastSeen: now,
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

function checkMachine(label: string, target: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(label)) throw new Error("a machine label is letters, digits, dots, dashes (at most 40)");
  if (!/^[A-Za-z0-9._@:-]{1,120}$/.test(target) || target.startsWith("-")) throw new Error("an SSH target is user@host or a host alias");
}

/** The argv that saves a machine in Herdr. */
export const machineAddArgv = (label: string, target: string, bin = herdrBin()): string[] => [bin, "machine", "add", "--label", label, target];

// Herdr refuses to attach to an older server without a person approving its update in a terminal.
const NEEDS_APPROVAL = /needs one final update|interactive terminal to approve/i;

export type AddMachineResult =
  | { ok: true; label: string; target: string; output: string }
  | { ok: false; needsApproval: true; label: string; target: string; command: string[]; error: string };

/** Save a machine in Herdr: only on the user's explicit yes, with the SSH target they typed. */
export function addMachine(label: string, target: string, h: Herdr = herdrOn("local")): AddMachineResult {
  checkMachine(label, target);
  try {
    const r = h(["machine", "add", "--label", label, target]);
    return { ok: true, label, target, output: typeof r === "string" ? r.trim() : JSON.stringify(r) };
  } catch (e) {
    const msg = (e as Error).message;
    if (!NEEDS_APPROVAL.test(msg)) throw e;
    return { ok: false, needsApproval: true, label, target, command: machineAddArgv(label, target), error: `${label} needs a Herdr update before it can connect; approve it in a terminal` };
  }
}

/** One argv word for a POSIX shell: single-quoted, any single quote closed, escaped and reopened. */
export const shellQuote = (w: string) => /^[A-Za-z0-9_./@:=-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`;

/** The osascript argv that opens Terminal running `argv` for the user to approve there. */
export function terminalArgv(argv: string[]): string[] {
  const line = argv.map(shellQuote).join(" ");
  const as = line.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return ["-e", 'tell application "Terminal"', "-e", "activate", "-e", `do script "${as}"`, "-e", "end tell"];
}

/**
 * Open Terminal on this Mac running exactly `herdr machine add --label <label> <target>`, so the user can
 * approve the remote Herdr's update there. Only the validated label and target reach the command.
 */
export function approveInTerminal(label: string, target: string, run: (osascriptArgs: string[]) => void = realOsascript): { ok: true; command: string[] } {
  checkMachine(label, target);
  const command = machineAddArgv(label, target);
  run(terminalArgv(command));
  return { ok: true, command };
}

function realOsascript(args: string[]): void {
  const r = spawnSync("/usr/bin/osascript", args, { encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0) throw new Error(`could not open Terminal: ${(r.stderr || r.error?.message || "").trim()}`);
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
    ...(t.name ? [`Task name: ${t.name}`] : []),
    `Task: ${t.text}`,
    ...(t.goal && t.goal !== t.text ? [`Goal it serves: ${t.goal}`] : []),
    `Where it belongs: ${t.dest ? `${t.dest.label} (${t.dest.kind})` : "General"}.`,
    ...(team.length ? ["", "Work the way these specialists would:", ...team.map((s) => `- ${s.name}: ${s.mandate.replace(/\s+/g, " ").slice(0, 300)}`)] : []),
    ...(t.context?.length ? ["", "What Prevail already knows (use it; never ask the user for it):", ...t.context.map((c) => `- ${c.text}`)] : []),
    "", "Rules:",
    "- Work on your own. Never ask the user a question or wait for an answer: nobody is watching this tab. When something is truly missing, make a sensible assumption and say so in your summary.",
    "- Draft, never send: do not email, message, post, buy, pay, book or sign anything. Write the draft and stop.",
    "- Stop before anything that cannot be undone, or that touches money, people, where the user lives or who they are, and say in your summary what is waiting for the user's approval.",
    ...(chief.neverRead.length ? [`- Never read these areas unless the task names them: ${chief.neverRead.join(", ")}.`] : []),
    `- Stay within about $${job?.budget.usd ?? chief.limits.usd} and ${job?.budget.minutes ?? chief.limits.minutes} minutes of work, then report.`,
    "", `End with a short summary: what you did, ${BRIEF_END}`,
  ];
  if (o.history) lines.unshift("Pick this task back up. The conversation so far:", "", o.history, "", "---", "");
  return lines.join("\n");
}

// ── Headless agents: each kind in its non-interactive mode ──────────────────

/**
 * The flags that keep each agent kind from ever waiting on an approval prompt.
 * Claude Code also loses its ask-the-user tool and keeps Prevail's act-gate
 * hook (--settings, added at launch), so sending, money and anything that
 * cannot be undone are still blocked by the hook, never asked about in a tab.
 * Codex runs sandboxed to its folder with no approvals. Kinds not listed use
 * the flag the user gave Glyph for them (its agents table), if any.
 */
export const HEADLESS: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--ask-for-approval", "never", "--sandbox", "workspace-write"],
  gemini: ["--yolo"],
  agy: ["--dangerously-skip-permissions"],
  cursor: ["--force"],
  hermes: ["--yolo"],
};
/** The command a Herdr agent kind runs as, where it differs from the kind. */
const KIND_CMD: Record<string, string> = { cursor: "cursor-agent" };
/** The commands Glyph wraps by default (its public table); Claude and pi take the session name with -n, the rest as a first bare word. */
const GLYPH_WRAPS = new Set(["claude", "agy", "codex", "cursor-agent", "crush", "cortex", "hermes", "opencode", "pi", "omni"]);
const NAME_FLAG: Record<string, string> = { claude: "-n", pi: "-n" };

/** The user's own Glyph agents table (command, auto-approve flag), read at run time. */
function glyphAgentFlags(env: Record<string, string | undefined> = process.env): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const f = env.GLYPH_AGENTS || join(homedir(), ".config", "glyph", "agents.tsv");
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const [cmd, flag] = line.split("\t");
      if (cmd && !cmd.startsWith("#") && /^[A-Za-z0-9_.-]+$/.test(cmd)) out.set(cmd, (flag ?? "").trim());
    }
  } catch { /* none */ }
  return out;
}

/** The agent's arguments for a headless run: its approval mode, then Claude's act-gate hook and no ask-the-user tool. */
export function headlessArgs(kind: string, settingsPath: string | null, env?: Record<string, string | undefined>): string[] {
  const cmd = KIND_CMD[kind] ?? kind;
  const flag = glyphAgentFlags(env).get(cmd);
  const base = HEADLESS[kind] ?? (flag ? [flag] : []);
  if (kind !== "claude") return [...base];
  return [...base, ...(settingsPath ? ["--settings", settingsPath] : []), "--disallowedTools", "AskUserQuestion"];
}

const slugName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";

/** The line typed into the new tab's shell so Glyph wraps the launch: its session name (the task's name) and Remote Control. */
export function glyphLine(kind: string, name: string, args: string[]): string {
  const cmd = KIND_CMD[kind] ?? kind;
  const label = NAME_FLAG[cmd] ? [NAME_FLAG[cmd]!, name] : GLYPH_WRAPS.has(cmd) || glyphAgentFlags().has(cmd) ? [slugName(name)] : [];
  return [cmd, ...label, ...args].map(shellQuote).join(" ");
}

/** Is Glyph installed on that machine? This Mac: its zsh file; another: what that Mac's record says. */
export function glyphOn(vault: string, label: string, local: boolean): boolean {
  if (local) return existsSync(join(homedir(), ".config", "glyph", "glyph.zsh"));
  return readMachineRecords(vault).some((r) => (r.label === label || r.hostname === label) && r.glyph === true);
}

// ── Finding the task's workspace ────────────────────────────────────────────
//
// The workspaces are the owner's. A task goes into one of them, found through
// the private Glyph spaces map (read at run time, never copied into code): by
// the folder it works in, then (for the vault) the workspace that holds the
// vault's domains, then a link saved earlier, then by name. With no clear
// home it goes to one shared workspace, SHARED_WORKSPACE, made once and
// reused. Prevail never makes a workspace per destination, and it closes only
// a workspace it made (herdr.json `created`), when nothing is left in it.

export const SHARED_WORKSPACE = "Work";
interface WsRow { workspace_id: string; label: string; cwd?: string; tab_count?: number }
type Links = Record<string, Record<string, string>>;
interface HerdrFile { links: Links; created: Record<string, string[]> }
const linksFile = (vault: string) => join(workDir(vault), "herdr.json");
function readHerdrFile(vault: string): HerdrFile {
  try {
    const j = JSON.parse(readFileSync(linksFile(vault), "utf8")) as Partial<HerdrFile>;
    return { links: j.links && typeof j.links === "object" ? j.links : {}, created: j.created && typeof j.created === "object" ? j.created : {} };
  } catch { return { links: {}, created: {} }; }
}
function writeHerdrFile(vault: string, f: HerdrFile): void {
  const out: Partial<HerdrFile> = { links: f.links };
  if (Object.values(f.created).some((x) => x.length)) out.created = Object.fromEntries(Object.entries(f.created).filter(([, x]) => x.length));
  mkdirSync(workDir(vault), { recursive: true });
  writeFileSync(linksFile(vault), `${JSON.stringify(out, null, 2)}\n`);
}
function saveLink(vault: string, machine: string, space: string, label: string): void {
  const f = readHerdrFile(vault);
  if (f.links[machine]?.[space] === label) return;
  f.links[machine] = { ...(f.links[machine] ?? {}), [space]: label };
  writeHerdrFile(vault, f);
}
function markCreated(vault: string, machine: string, id: string, on: boolean): void {
  const f = readHerdrFile(vault);
  const was = f.created[machine] ?? [];
  const next = on ? [...new Set([...was, id])] : was.filter((x) => x !== id);
  if (next.length === was.length) return;
  f.created[machine] = next;
  writeHerdrFile(vault, f);
}
const madeByPrevail = (vault: string, machine: string, id: string) => (readHerdrFile(vault).created[machine] ?? []).includes(id);

/** Drop links and made-here marks that point at workspaces no longer open on that machine. They are found again, never made again. */
export function pruneLinks(vault: string, machine: string, rows: WsRow[]): void {
  const f = readHerdrFile(vault);
  const labels = new Set(rows.map((w) => norm(w.label)));
  const ids = new Set(rows.map((w) => w.workspace_id));
  const links = Object.fromEntries(Object.entries(f.links[machine] ?? {}).filter(([, l]) => labels.has(norm(l))));
  const created = (f.created[machine] ?? []).filter((id) => ids.has(id));
  if (Object.keys(links).length === Object.keys(f.links[machine] ?? {}).length && created.length === (f.created[machine] ?? []).length) return;
  if (f.links[machine]) f.links[machine] = links;
  f.created[machine] = created;
  writeHerdrFile(vault, f);
}

const norm = (s?: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const titled = (s: string) => s.split(/[-_]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
/** A map tab's path ("{root}/rel") as a root name and a relative path. */
const tabFolder = (p: unknown): { root: string; rel: string } | null => {
  const m = typeof p === "string" ? /^\{(\w+)\}(?:\/(.*))?$/.exec(p.trim()) : null;
  return m ? { root: m[1]!, rel: (m[2] ?? "").replace(/\/+$/, "") } : null;
};
const within = (rel: string, base: string) => base === "" || rel === base || rel.startsWith(`${base}/`);

interface MapSpace { space: string; id: string; tabs: { label: string; folder: { root: string; rel: string } | null }[] }
function readMap(env: Record<string, string | undefined>): MapSpace[] {
  return readSpaces(mapDir(env)).map(({ space: s }) => ({
    space: String(s.space ?? ""), id: String(s.id ?? ""),
    tabs: (Array.isArray(s.tabs) ? s.tabs : []).map((x) => ({ label: String((x as { label?: unknown }).label ?? ""), folder: tabFolder((x as { path?: unknown }).path) })),
  })).filter((s) => s.space || s.id);
}

/**
 * The owner's workspace a task belongs in, or null (it goes to the shared one).
 * `cwd` is the folder on the machine it runs on; `roots` that machine's Glyph roots, when known.
 */
export function findTaskWorkspace(vault: string, rows: WsRow[], t: WorkTask, cwd: string, o: { env?: Record<string, string | undefined>; roots?: Record<string, string | null | undefined> } = {}): WsRow | null {
  const byLabel = (l?: string) => (l && norm(l) ? rows.find((w) => typeof w.label === "string" && norm(w.label) === norm(l)) ?? null : null);
  const tag = Object.values(glyphMachines(o.env ?? process.env)).find((m) => m.tag === t.machine)?.tag;
  const live = (s: MapSpace) => byLabel(s.space) ?? byLabel(s.id) ?? (tag ? byLabel(`${tag}-${s.space}`) : null);
  const space = t.thread.space;
  const pinned = byLabel(readSettings(vault).workspaces[space]);
  if (pinned) return pinned;
  const map = readMap(o.env ?? process.env);
  const f = t.dest?.folder ?? folderOf(domainDir(vault, space), { vault, home: homedir() });
  const abs = cwd.replace(/\/+$/, "");
  const rootPath = (r: string) => expand(o.roots?.[r] ?? undefined)?.replace(/\/+$/, "");
  // 1. By folder: the most specific map tab the task's folder sits in.
  const hits: { s: MapSpace; depth: number }[] = [];
  for (const s of map) for (const tab of s.tabs) {
    if (!tab.folder) continue;
    const base = rootPath(tab.folder.root);
    const tabAbs = base ? (tab.folder.rel ? `${base}/${tab.folder.rel}` : base) : undefined;
    if ((tab.folder.root === f.root && within(f.rel, tab.folder.rel)) || (tabAbs && within(abs, tabAbs))) hits.push({ s, depth: tab.folder.rel.split("/").filter(Boolean).length });
  }
  for (const h of hits.sort((a, b) => b.depth - a.depth)) { const w = live(h.s); if (w) return w; }
  // 2. The vault: the workspace whose tabs hold the most of its domains.
  const vaultRoot = rootPath("vault");
  if (f.root === "vault" || (vaultRoot && within(abs, vaultRoot))) {
    const count = (s: MapSpace) => s.tabs.filter((x) => x.folder?.root === "vault" && within(x.folder.rel, "data/domains") && x.folder.rel !== "data/domains").length;
    for (const s of map.filter((x) => count(x) > 0).sort((a, b) => count(b) - count(a))) { const w = live(s); if (w) return w; }
  }
  // 3. A link saved earlier that still resolves to an owner's workspace (never one Prevail made for a destination).
  const linked = byLabel(readHerdrFile(vault).links[t.machine]?.[space]);
  if (linked && (norm(linked.label) === norm(SHARED_WORKSPACE) || !madeByPrevail(vault, t.machine, linked.workspace_id))) return linked;
  // 4. By name: an open workspace, or a map space or tab, named like the destination.
  const bare = space.replace(/^_(?:mission|app)-/, "");
  const d = t.dest;
  const names = [d?.label, d?.id, bare, titled(bare), d?.folder ? d.folder.rel.split("/").pop() : undefined].filter((n): n is string => !!n && !!norm(n));
  for (const n of names) {
    const w = byLabel(n);
    if (w && norm(w.label) !== norm(SHARED_WORKSPACE)) return w;
    for (const s of map) if ([s.space, s.id, ...s.tabs.map((x) => x.label)].some((l) => norm(l) === norm(n))) { const m = live(s); if (m) return m; }
  }
  return null;
}

// ── Dialogs and questions in the tab ────────────────────────────────────────

const TRUST = /trust (?:this folder|the files in this folder|this project)|Do you trust/i;
const BYPASS = /Bypass Permissions mode/i;
const MENU = /Enter to select|to navigate|Use arrow keys|Esc to cancel|\(y\/n\)|\[y\/N\]|\[Y\/n\]/i;

/** Answer the dialogs a headless launch may still meet (trust this folder; Claude's bypass warning). True when it answered one. */
export function answerDialog(h: Herdr, pane: string | undefined): boolean {
  if (!pane) return false;
  let screen = "";
  try { screen = readText(h(["pane", "read", pane, "--source", "recent", "--lines", "40"])); } catch { return false; }
  // Both default to safe choices; the user's yes was given by turning Herdr on for Work mode.
  if (TRUST.test(screen) && /Yes, (?:proceed|I trust)/i.test(screen)) { h(["pane", "send-keys", pane, "enter"]); return true; }
  if (BYPASS.test(screen) && /Yes, I accept/i.test(screen)) { h(["pane", "send-keys", pane, "down", "enter"]); return true; }
  return false;
}

/** The question an agent is waiting on, as one plain sentence; null when it is not asking. */
export function askingQuestion(words: string): string | null {
  const lines = words.split("\n").map((l) => l.replace(/^[\s❯●⏺>*-]+/, "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(-14);
  if (!lines.length) return null;
  const menu = lines.some((l) => MENU.test(l));
  const q = [...lines].reverse().find((l) => /\?$/.test(l) && l.length > 3 && !/^\d+[.)]/.test(l));
  const last = lines[lines.length - 1]!;
  if (!menu && !/\?$/.test(last)) return null;
  const s = noDash(q ?? "It is waiting on a choice in its Herdr tab.");
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

// What a line of the agent's work means, in plain words ("Reading your Gmail").
const ACTIVITY: [RegExp, (arg: string) => string][] = [
  [/gmail|mail/i, (a) => (/draft/i.test(a) ? "Drafting an email" : "Reading your Gmail")],
  [/calendar/i, () => "Checking your calendar"],
  [/drive|docs|sheets/i, () => "Reading your documents"],
  [/^web ?search$/i, () => "Searching the web"],
  [/^(?:web ?fetch|fetch)$/i, () => "Reading a web page"],
  [/^read$/i, (a) => `Reading ${base(a)}`],
  [/^(?:write|edit|update|multi ?edit)$/i, (a) => `Editing ${base(a)}`],
  [/^(?:bash|shell|run)$/i, () => "Running a command"],
  [/^(?:grep|glob|search|list)$/i, () => "Searching files"],
  [/^(?:task|agent)$/i, () => "Bringing in a helper"],
  [/^(?:todo ?write|update todos)$/i, () => "Planning the steps"],
];
const base = (a: string) => { const p = a.replace(/^["']|["']$/g, "").split(/[,\s]/)[0] ?? ""; const b = p.split("/").filter(Boolean).pop() ?? ""; return b && b.length < 40 ? b : "a file"; };

/** The agent's tool calls in a stretch of its output, as plain activity lines with the call behind each. */
export function activities(words: string): { line: string; more: string }[] {
  const out: { line: string; more: string }[] = [];
  for (const l of words.split("\n")) {
    const m = /^\s*[⏺●]\s+([A-Za-z][\w .:-]*?)\s*\((.*)$/.exec(l);
    if (!m) continue;
    const tool = m[1]!.replace(/\s*\(MCP\)\s*$/i, "").trim();
    const arg = m[2]!.replace(/\)\s*$/, "");
    const hit = ACTIVITY.find(([re]) => re.test(tool));
    const line = hit ? hit[1](`${tool} ${arg}`.includes("draft") ? `draft ${arg}` : arg) : `Using ${tool.replace(/^mcp__/i, "").replace(/[_-]+/g, " ").toLowerCase()}`;
    if (out[out.length - 1]?.line !== line) out.push({ line, more: l.trim().slice(0, 300) });
  }
  return out;
}

const agentName = (t: Pick<WorkTask, "id" | "name" | "text">) => `${slugName(t.name || t.text)}-${t.id.split("-").pop()}`;

/** The Herdr workspaces open on a machine (by label), read only. */
export function herdrWorkspaces(vault: string, label: string, deps: WorkDeps = {}): string[] {
  const machine = herdrMachine(vault, label, deps);
  if (!machine) throw new Error(`${label} is not a saved Herdr machine here`);
  const r = herdrFor(deps, machine)(["workspace", "list"]) as { workspaces?: WsRow[] } | undefined;
  return [...new Set((r?.workspaces ?? []).map((w) => w.label).filter((l) => typeof l === "string" && l.trim()))];
}

/** Wait until Herdr sees the agent in its pane, answering a trust or bypass dialog on the way. */
function settleAgent(h: Herdr, agent: string, pane: string | undefined, deps: WorkDeps, tries = 30): "ready" | "blocked" | "unknown" {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  let answered = 0;
  let last = "";
  for (let i = 0; i < tries; i++) {
    try { last = statusOf(h(["agent", "get", agent])); } catch { last = ""; }
    if (last === "idle" || last === "done") return "ready";
    if (answered < 3 && answerDialog(h, pane)) { answered++; sleep(600); continue; }
    if (last === "blocked") return "blocked";
    sleep(500);
  }
  return last === "working" ? "ready" : "unknown";
}

/**
 * Open the task in Herdr, headless, one tab per task: the owner's workspace
 * it belongs in (findTaskWorkspace), else the shared one (made once), a new tab named after the task, and the agent in its non-interactive
 * mode. With Glyph installed the agent's command is typed into the tab's
 * shell so Glyph names the session and turns on Remote Control; otherwise
 * `herdr agent start`. The brief follows once Herdr sees the agent ready; when
 * it is not ready yet, the mirror sends it. Nothing here asks the user.
 */
export async function launchTask(vault: string, id: string, deps: WorkDeps = {}, o: { reopen?: boolean } = {}): Promise<WorkTask> {
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  let t = r.task;
  let machine = herdrMachine(vault, t.machine, deps);
  if (!machine) {
    // A Mac Herdr cannot reach: it runs on this one.
    const here = thisMachine(vault, deps.machine).label;
    t = updateTask(vault, id, (x) => { note(x, "moved", `${x.machine} is not connected, so it runs on ${here}`, now); x.machine = here; });
    machine = "local";
  }
  const h = herdrFor(deps, machine);
  const md = threadFiles(vault, t.thread.space, t.thread.session).find((f) => f.endsWith(".md"));
  const thread = md ? readFileSync(md, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim() : "";
  // Picked back up (reopen, a follow-up): the brief carries the conversation so far.
  const history = o.reopen || (thread.match(/^## /gm)?.length ?? 0) > 1 ? thread.slice(-4000) : "";
  const brief = buildBrief(vault, t, { history });
  let ref: HerdrRef;
  let opened: HerdrRef | null = null;
  const prior = !o.reopen && t.herdr?.tabId && t.herdr.agent ? t.herdr : null;
  let priorAlive = false;
  if (prior) { try { priorAlive = !!statusOf(h(["agent", "get", prior.agent!])); } catch { priorAlive = false; } }
  try {
    if (prior && priorAlive) ref = { ...prior };
    else {
      const cwd = taskCwd(vault, t, machine, deps);
      const env = ["--env", `PREVAIL_DOMAIN=${t.thread.space}`, "--env", `PREVAIL_THREAD_ID=${t.thread.session}`];
      const rows = ((h(["workspace", "list"]) as { workspaces?: WsRow[] } | undefined)?.workspaces ?? []);
      pruneLinks(vault, t.machine, rows);
      const env0 = deps.machine?.env ?? process.env;
      const gms = glyphMachines(env0);
      const gm = machine === "local" ? gms[hostKey(deps.machine?.host)] : Object.entries(gms).find(([k, m]) => m.tag === t.machine || k === t.machine)?.[1];
      const ws = findTaskWorkspace(vault, rows, t, cwd, { env: env0, roots: gm?.roots }) ?? rows.find((w) => norm(w.label) === norm(SHARED_WORKSPACE)) ?? null;
      const name = (t.name || t.text).replace(/\s+/g, " ").slice(0, 30).trim();
      let workspaceId: string, tabId: string, paneId: string, label: string;
      if (ws) {
        const c = h(["tab", "create", "--workspace", ws.workspace_id, "--cwd", cwd, "--label", name, ...env, "--no-focus"]) as { tab?: { tab_id: string }; root_pane?: { pane_id: string } };
        if (!c?.tab?.tab_id || !c.root_pane?.pane_id) throw new Error("herdr did not return the new tab");
        workspaceId = ws.workspace_id; label = ws.label; tabId = c.tab.tab_id; paneId = c.root_pane.pane_id;
      } else {
        // No home and no shared workspace yet: make the shared one, once.
        label = SHARED_WORKSPACE;
        const c = h(["workspace", "create", "--label", label, "--cwd", cwd, ...env, "--no-focus"]) as { workspace?: { workspace_id: string }; tab?: { tab_id: string }; root_pane?: { pane_id: string } };
        if (!c?.workspace?.workspace_id || !c.tab?.tab_id || !c.root_pane?.pane_id) throw new Error("herdr did not return the new workspace");
        workspaceId = c.workspace.workspace_id; tabId = c.tab.tab_id; paneId = c.root_pane.pane_id;
        markCreated(vault, t.machine, workspaceId, true);
        try { h(["tab", "rename", tabId, name]); } catch { /* the label can wait */ }
      }
      const created = madeByPrevail(vault, t.machine, workspaceId);
      saveLink(vault, t.machine, t.thread.space, label);
      // Claude Code carries Prevail's act-gate hook; the hook file lives on this Mac, so a remote Claude runs without it.
      const settingsPath = t.agentKind === "claude" && machine === "local" ? (deps.settingsPath ?? defaultSettingsPath)(vault, t.thread.space) : null;
      const args = headlessArgs(t.agentKind, settingsPath, deps.machine?.env);
      const glyph = (deps.glyph ?? ((m: string) => glyphOn(vault, m, m === "local")))(machine === "local" ? "local" : t.machine);
      opened = { machine: t.machine, workspaceLabel: label, workspaceId, tabId, paneId, agent: paneId, createdWorkspace: created, createdTab: true, ...(glyph ? { glyph: true } : {}) };
      if (glyph) h(["pane", "run", paneId, glyphLine(t.agentKind, name, args)]);
      else h(["agent", "start", agentName(t), "--kind", t.agentKind, "--pane", paneId, ...(args.length ? ["--", ...args] : [])]);
      try { h(["pane", "rename", paneId, name]); } catch { /* cosmetic */ }
      ref = opened;
    }
    const state = settleAgent(h, ref.agent!, ref.paneId, deps);
    if (state === "ready") { h(["agent", "prompt", ref.agent!, brief]); delete ref.briefPending; }
    else ref.briefPending = true;
  } catch (e) {
    const msg = (e as Error).message;
    const keep = opened;
    const x = updateTask(vault, id, (y) => { if (keep) y.herdr = keep; finish(y, "failed", "Herdr could not start it.", now); note(y, "could not start", msg.slice(0, 200), now); });
    syncBoard(vault, x);
    return x;
  }
  const next = updateTask(vault, id, (x) => {
    x.herdr = ref; x.status = "running"; delete x.ask; delete x.waiting;
    note(x, o.reopen || prior ? "back in Herdr" : "in Herdr", `${ref.workspaceLabel} on ${x.machine}`, now);
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

/** The brief's last words: the first mirror starts after the agent's echo of them (its banner and the brief are not its words). */
export const BRIEF_END = "what you filed, and what is left.";
export function afterBrief(text: string): string {
  const i = text.lastIndexOf(BRIEF_END);
  return i >= 0 ? text.slice(i + BRIEF_END.length) : text;
}

/** The agent's words without its terminal chrome: rules and boxes, the empty input line, the mode footer, the spinner line. */
export function stripChrome(text: string): string {
  const rule = (l: string | undefined) => /^\s*[─━═]{3,}/.test(l ?? "");
  return text.split("\n")
    // The input box (a line between two rules) holds the user's draft or the agent's ghost suggestion, never its words.
    .filter((l, i, a) => !(/^\s*❯/.test(l) && rule(a[i - 1]) && rule(a[i + 1])))
    .filter((l) => !rule(l) && !/^\s*❯\s*$/.test(l) && !/^\s*⏵⏵/.test(l) && !/^\s*✻ /.test(l))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
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

const WAITING = "It is waiting on a question in its Herdr tab.";

/**
 * Mirror the agent's work into the thread until it finishes: wait, read,
 * append only what is new, and note what it is doing as plain activity lines.
 * A brief that could not go in at launch goes in once the agent is idle. An
 * agent asking something (a menu, a question, Herdr's blocked state) is never
 * done: the task waits as needs-you with the question as one sentence, and a
 * follow-up answers it. Done only when the agent settles with its work
 * finished; the outcome is distilled then. The mirror holds the lease.
 */
export async function mirrorTask(vault: string, id: string, deps: WorkDeps = {}, o: { maxRounds?: number; waitMs?: number } = {}): Promise<WorkTask> {
  const clock = deps.now ?? Date.now;
  const r = readTask(vault, id);
  if (!r?.task.herdr?.agent) throw new Error(`task ${id} has no Herdr agent`);
  const machine = herdrMachine(vault, r.task.machine, deps);
  if (!machine) throw new Error(`${r.task.machine} is not reachable from here`);
  const h = herdrFor(deps, machine);
  const agent = r.task.herdr.agent;
  const pane = r.task.herdr.paneId;
  const until = clock() + 6 * 3_600_000;
  const wait = String(o.waitMs ?? 600_000);
  await withLease(vault, id, deps, async () => {
    for (let round = 0; round < (o.maxRounds ?? 10_000) && clock() < until; round++) {
      const cur = readTask(vault, id)?.task;
      if (!cur || !(cur.status === "running" || cur.status === "needs-you") || cur.herdr?.agent !== agent) break;
      // Waiting on the user: only a change from there wakes it (no spin on a state that stays blocked).
      const waitArgs = cur.status === "needs-you" ? ["--until", "working", "--until", "idle", "--until", "done"] : [];
      try { h(["agent", "wait", agent, ...waitArgs, "--timeout", wait]); } catch { /* a timeout: read what there is */ }
      let text = "";
      let status = "";
      try { text = readText(h(["agent", "read", agent, "--source", "recent-unwrapped", "--lines", "400"])); status = statusOf(h(["agent", "get", agent])); } catch (e) {
        // Herdr will not read the scrollback while the agent works: it is alive, so read on its next pause.
        if (/agent_not_idle/.test((e as Error).message)) continue;
        // The agent is gone (its tab closed by hand): stop mirroring.
        updateTask(vault, id, (x) => { note(x, "mirror ended", (e as Error).message.slice(0, 200), clock()); if (x.status === "running" || x.status === "needs-you") {
          // A closed tab is housekeeping, never an outcome: with no result yet, it asks what to do.
          if (x.outcome) finish(x, "done", x.outcome, clock());
          else { x.status = "needs-you"; x.waiting = "Its Herdr tab closed before a result came back. Should it start again?"; addUpdate(x, "task", x.waiting, clock()); }
        } });
        break;
      }
      // The brief that could not go in at launch: in now that the agent is ready.
      if (cur.herdr?.briefPending) {
        if (status === "idle" || status === "done") {
          try { h(["agent", "prompt", agent, buildBrief(vault, cur)]); } catch { continue; }
          const t = updateTask(vault, id, (x) => { if (x.herdr) { delete x.herdr.briefPending; x.herdr.lastRead = text.slice(-2000); } x.status = "running"; delete x.waiting; note(x, "briefed", undefined, clock()); });
          syncBoard(vault, t);
          continue;
        }
        if (answerDialog(h, pane)) continue;
        if (status === "blocked" && cur.status !== "needs-you") {
          const t = updateTask(vault, id, (x) => { x.status = "needs-you"; x.waiting = WAITING; note(x, "waiting", WAITING, clock()); addUpdate(x, "task", WAITING, clock()); });
          syncBoard(vault, t);
        }
        continue;
      }
      const fresh = (cur.herdr?.lastRead ? newText(cur.herdr.lastRead, text) : afterBrief(text)).trim();
      const words = stripChrome(fresh);
      const all = stripChrome(afterBrief(text));
      const settled = (status === "idle" || status === "done") && (round > 0 || !!words);
      const question = status === "blocked" || settled ? askingQuestion(all) ?? (status === "blocked" ? WAITING : null) : null;
      if (question && status === "blocked" && answerDialog(h, pane)) continue;
      const outcome = settled && !question ? await distilOutcome(all.slice(-4000), deps, cur.text) : "";
      // Still at work: a real milestone from what it just did, a sentence at most and only now and then.
      const milestone = !settled && !question && words && milestoneDue(cur, clock()) ? await distilMilestone(words, deps) : null;
      const t = updateTask(vault, id, (x) => {
        if (words) appendTurn(vault, x, "assistant", words, x.agentKind, clock());
        if (milestone) addMilestone(x, milestone, clock());
        for (const a of activities(words)) if (x.log[x.log.length - 1]?.detail !== a.line) note(x, "activity", a.line, clock(), a.more);
        if (x.herdr) x.herdr.lastRead = text.slice(-2000);
        if (question) {
          if (x.status !== "needs-you" || x.waiting !== question) { note(x, "waiting", question, clock()); addUpdate(x, "task", question, clock()); }
          x.status = "needs-you"; x.waiting = question;
        } else if (status === "working" && x.status === "needs-you") { x.status = "running"; delete x.waiting; }
        else if (settled && (x.status === "running" || x.status === "needs-you")) { delete x.waiting; finish(x, "done", outcome || "Done.", clock()); note(x, "done", undefined, clock()); }
      });
      syncBoard(vault, t);
      if (t.status === "done") break;
    }
  });
  return readTask(vault, id)!.task;
}

/** Send the user's words to the task's agent. A menu it is waiting on is closed first (Esc) so the words land as its answer. */
export function promptHerdr(vault: string, t: WorkTask, text: string, deps: WorkDeps = {}): boolean {
  const ref = t.herdr;
  if (!ref?.agent) return false;
  const machine = herdrMachine(vault, ref.machine, deps);
  if (!machine) return false;
  const h = herdrFor(deps, machine);
  try { h(["agent", "prompt", ref.agent, text]); return true; } catch (e) {
    if (!/blocked/i.test((e as Error).message)) return false;
  }
  try {
    h(["agent", "send-keys", ref.agent, "esc"]);
    (deps.sleep ?? ((ms: number) => Bun.sleepSync(ms)))(400);
    h(["agent", "prompt", ref.agent, text]);
    return true;
  } catch { return false; }
}

/** The task's new name on its Herdr tab, pane and agent. */
export function renameHerdr(vault: string, t: WorkTask, deps: WorkDeps = {}): void {
  const ref = t.herdr;
  if (!ref?.tabId || ref.createdTab === false) return;
  const h = herdrFor(deps, herdrMachine(vault, ref.machine, deps) ?? "local");
  const name = (t.name || t.text).slice(0, 30);
  h(["tab", "rename", ref.tabId, name]);
  if (ref.paneId) { try { h(["pane", "rename", ref.paneId, name]); } catch { /* cosmetic */ } }
  if (ref.agent) { try { h(["agent", "rename", ref.agent, slugName(name)]); } catch { /* cosmetic */ } }
}

/** Bring the task's Herdr tab to the front ("Open in Herdr"). */
export function focusTask(vault: string, id: string, deps: WorkDeps = {}): WorkTask {
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  const ref = r.task.herdr;
  if (!ref?.tabId) throw new Error("its Herdr tab is closed");
  const h = herdrFor(deps, herdrMachine(vault, ref.machine, deps) ?? "local");
  h(["tab", "focus", ref.tabId]);
  if (ref.agent) { try { h(["agent", "focus", ref.agent]); } catch { /* the tab is enough */ } }
  return r.task;
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
    if (left === 0) { try { h(["workspace", "close", ref.workspaceId]); } catch { /* already closed */ } markCreated(vault, ref.machine, ref.workspaceId, false); }
  }
}

/** Close: the Herdr side goes, the task and its history stay (reopen brings it back). */
export function closeTask(vault: string, id: string, deps: WorkDeps = {}): WorkTask {
  const now = (deps.now ?? Date.now)();
  const r = readTask(vault, id);
  if (!r) throw new Error(`no task ${id}`);
  closeHerdr(vault, r.task, deps);
  const t = updateTask(vault, id, (x) => {
    // The tab is gone; what it last said stays on the card (a relaunch starts a fresh ref).
    if (x.herdr) x.herdr = { machine: x.herdr.machine, workspaceLabel: x.herdr.workspaceLabel, ...(x.herdr.workspaceId ? { workspaceId: x.herdr.workspaceId } : {}), ...(x.herdr.createdWorkspace ? { createdWorkspace: true } : {}), ...(x.herdr.lastRead ? { lastRead: x.herdr.lastRead } : {}) };
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

