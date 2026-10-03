// prevail spaces: one herdr tab per Prevail domain (agent-mesh plan, Step 3).
//
// The generic layout engine (machines, roots, herdr workspaces and tabs,
// naming) is `glyph spaces`; aidev folded into glyph on 2026-10-02 and its
// map lives in the vault at build/.ai/glyph/spaces, reached through
// ~/.config/glyph/spaces (or GLYPH_SPACES). This module is the Prevail half:
// - a space file with `"source": "prevail domains"` is DERIVED: its tabs are
//   rewritten from Prevail's own domain list (never `ls`), ordered by context
//   score plus open tasks, pins first, archived and claimed domains out;
// - every domain gets a tab in its own folder; only pinned domains carry an
//   agent, whose engine and model come from the manifest;
// - `start <domain>` wakes a sleeping tab in place, `sleep <domain>` has the
//   agent file its conclusions in its own folder and drops back to a shell;
// - `tidy` sleeps unpinned agents after an idle limit or when memory is low,
//   and holds each open tab's domain lock on the hub.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { readManifest } from "./manifest.ts";
import { resolveDomainDir } from "./path-safety.ts";

export const DERIVED_SOURCE = "prevail domains";

export interface SpaceTab {
  label: string;
  mark: string;
  path: string;
  agent?: string;
  previous?: string[];
}

export interface SpaceFile {
  id: string;
  space: string;
  profiles?: string[];
  source?: string;
  pins?: string[];
  exclude?: string[];
  tabs: SpaceTab[];
  [k: string]: unknown;
}

export interface DomainFacts {
  name: string;
  pinned: boolean;
  archived: boolean;
  score: number;
  openTasks: number;
}

export function mapDir(env: Record<string, string | undefined> = process.env): string {
  return env.GLYPH_SPACES?.trim() || join(homedir(), ".config", "glyph", "spaces");
}

const DOMAIN_PATH_RE = /^\{vault\}\/data\/domains\/([^/]+)\/?$/;

/** The command a tab's agent runs: glyph adds the mark, which the trailing # swallows. */
export function agentField(domain: string): string {
  return `eval "$(prevail spaces cmd ${domain})"`;
}

/**
 * The tabs of a derived space. A domain another space already opens stays
 * there; pins come first in pin order, the rest by context score plus open
 * tasks; earlier tab names carry over so glyph renames in place.
 */
export function deriveTabs(space: SpaceFile, domains: DomainFacts[], claimed: Set<string>): SpaceTab[] {
  const exclude = new Set(space.exclude ?? []);
  const pins = space.pins ?? [];
  const prior = new Map(space.tabs.map((t) => [t.label, t]));
  const live = domains.filter((d) => !d.archived && !exclude.has(d.name) && !claimed.has(d.name));
  const rank = (d: DomainFacts) => (pins.includes(d.name) ? -1e9 + pins.indexOf(d.name) : -(d.score + d.openTasks));
  return live
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((d) => {
      const t: SpaceTab = { label: d.name, mark: `${space.space}-${d.name}`, path: `{vault}/data/domains/${d.name}` };
      if (d.pinned) t.agent = agentField(d.name);
      const prev = prior.get(d.name)?.previous;
      if (prev?.length) t.previous = prev;
      return t;
    });
}

export function domainFacts(vault: string): DomainFacts[] {
  return listDomainDirs(vault).map((name) => {
    const m = readManifest(vault, name);
    let openTasks = 0;
    try {
      // Count open lines on the board without pulling in the task engine.
      for (const f of ["memory/tasks.md", "_tasks.md"]) {
        const p = join(resolveDomainDir(vault, name), f);
        if (existsSync(p)) { openTasks = (readFileSync(p, "utf8").match(/^- \[ \]/gm) ?? []).length; break; }
      }
    } catch { /* zero */ }
    return { name, pinned: !!m?.config.pinned, archived: !!m?.archived, score: m?.context_score?.score ?? 0, openTasks };
  });
}

export function readSpaces(dir = mapDir()): { file: string; space: SpaceFile }[] {
  const sd = join(dir, "spaces");
  if (!existsSync(sd)) return [];
  const out: { file: string; space: SpaceFile }[] = [];
  for (const f of readdirSync(sd).filter((x) => x.endsWith(".json")).sort()) {
    try { out.push({ file: join(sd, f), space: JSON.parse(readFileSync(join(sd, f), "utf8")) as SpaceFile }); } catch { /* not ours to fix */ }
  }
  return out;
}

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Rewrite every derived space from the vault. Returns what changed. */
export function deriveAll(vault: string, dir = mapDir(), opts: { dryRun?: boolean; today?: string } = {}): { id: string; tabs: number; agents: number; changed: boolean }[] {
  const all = readSpaces(dir);
  const facts = domainFacts(vault);
  const res: { id: string; tabs: number; agents: number; changed: boolean }[] = [];
  for (const { file, space } of all) {
    if (space.source !== DERIVED_SOURCE) continue;
    const claimed = new Set<string>();
    for (const o of all) {
      if (o.space === space) continue;
      for (const t of o.space.tabs ?? []) { const m = DOMAIN_PATH_RE.exec(t.path); if (m) claimed.add(m[1]!); }
    }
    const tabs = deriveTabs(space, facts, claimed);
    const next = `${JSON.stringify({ ...space, tabs }, null, 2)}\n`;
    const cur = readFileSync(file, "utf8");
    const changed = next !== cur;
    if (changed && !opts.dryRun) {
      // Never lose a hand-kept layout: one dated copy per day of change.
      const bak = `${file}.pre-derive-${opts.today ?? localDay()}`;
      if (!existsSync(bak)) writeFileSync(bak, cur);
      writeFileSync(file, next);
    }
    res.push({ id: space.id, tabs: tabs.length, agents: tabs.filter((t) => t.agent).length, changed });
  }
  return res;
}

// ── Launch ───────────────────────────────────────────────────────────────

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The shell line that starts a domain's agent through glyph (which names the
 * session): the engine and model from the manifest, PREVAIL_DOMAIN so the
 * Prevail MCP server scopes the session, and for Claude Code the act-gate
 * hook that keeps writes inside the domain's folder.
 */
export function launchLine(domain: string, mark: string, cli: string, model: string, settingsPath?: string): string {
  const env = `PREVAIL_DOMAIN=${domain}`;
  if (cli === "codex") return `${env} codex ${mark}${model ? ` -m ${q(model)}` : ""}`;
  if (cli === "antigravity") return `${env} agy ${mark}${model ? ` --model ${q(model)}` : ""}`;
  if (cli === "claude" || !cli) return `${env} claude ${mark}${model ? ` --model ${q(model)}` : ""}${settingsPath ? ` --settings ${q(settingsPath)}` : ""}`;
  return `${env} ${cli} ${mark}`;
}

export async function commandFor(vault: string, domain: string, mark?: string): Promise<string> {
  if (!listDomainDirs(vault).includes(domain)) throw new Error(`no domain "${domain}"`);
  const m = readManifest(vault, domain);
  const cli = m?.config.cli ?? "claude";
  let settings: string | undefined;
  if (cli === "claude") {
    const { actGateSettingsPath } = await import("./act-gate.ts");
    const { vaultLockActive } = await import("./config.ts");
    settings = actGateSettingsPath(vault, domain, vaultLockActive());
  }
  const space = readSpaces().find((s) => s.space.tabs?.some((t) => t.label === domain));
  return launchLine(domain, mark ?? space?.space.tabs.find((t) => t.label === domain)?.mark ?? domain, cli, m?.config.model ?? "", settings);
}

// ── herdr ────────────────────────────────────────────────────────────────

export interface Pane {
  pane_id: string;
  cwd?: string;
  agent?: string;
  agent_status?: string;
}

export type Herdr = (args: string[]) => unknown;

export const realHerdr: Herdr = (args) => {
  const r = spawnSync("herdr", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`herdr ${args.join(" ")} failed: ${(r.stderr || r.error?.message || "").trim()}`);
  try { return (JSON.parse(r.stdout) as { result?: unknown }).result; } catch { return r.stdout; }
};

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

/** Panes sitting in a domain's folder, by domain. */
export function domainPanes(vault: string, herdr: Herdr): Map<string, Pane> {
  const dirs = new Map(listDomainDirs(vault).map((d) => [real(resolveDomainDir(vault, d)), d]));
  const out = new Map<string, Pane>();
  const panes = ((herdr(["pane", "list"]) as { panes?: Pane[] })?.panes ?? []);
  for (const p of panes) {
    const d = p.cwd ? dirs.get(real(p.cwd)) : undefined;
    if (!d) continue;
    const have = out.get(d);
    if (!have || (!have.agent && p.agent)) out.set(d, p);
  }
  return out;
}

const awake = (p?: Pane) => !!p?.agent;

export async function wake(vault: string, domain: string, herdr: Herdr = realHerdr): Promise<string> {
  const p = domainPanes(vault, herdr).get(domain);
  if (!p) return `${domain} has no tab here; run prevail spaces apply first`;
  if (awake(p)) return `${domain} is already awake (${p.agent}, ${p.agent_status ?? "unknown"})`;
  const line = await commandFor(vault, domain);
  herdr(["pane", "run", p.pane_id, `cd ${q(resolveDomainDir(vault, domain))} && ${line}`]);
  return `woke ${domain} in its tab`;
}

export const FLUSH_TEXT =
  "Before this session ends: write what this session concluded that is not yet in this folder into memory/memory.md under today's date, and open items into the task board. Write only inside this folder. Reply DONE when filed.";

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** File the session's conclusions, then drop the tab back to a shell. */
export async function sleepDomain(vault: string, domain: string, herdr: Herdr = realHerdr, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<string> {
  const p = domainPanes(vault, herdr).get(domain);
  if (!awake(p)) return `${domain} is not awake`;
  const timeout = opts.timeoutMs ?? 180_000;
  const poll = opts.pollMs ?? 3_000;
  const status = () => domainPanes(vault, herdr).get(domain);
  herdr(["pane", "send-text", p!.pane_id, FLUSH_TEXT]);
  herdr(["pane", "send-keys", p!.pane_id, "Enter"]);
  const start = Date.now();
  await sleepMs(poll);
  while (Date.now() - start < timeout) {
    const s = status();
    if (!awake(s) || s!.agent_status === "idle" || s!.agent_status === "done") break;
    await sleepMs(poll);
  }
  const still = status();
  if (still?.agent && still.agent_status === "working") return `${domain} is still filing after ${Math.round(timeout / 1000)}s; left awake`;
  if (awake(still)) {
    herdr(["pane", "send-text", still!.pane_id, still!.agent === "codex" ? "/quit" : "/exit"]);
    herdr(["pane", "send-keys", still!.pane_id, "Enter"]);
  }
  return `${domain} filed its conclusions and is asleep`;
}

// ── Idle and memory policy ───────────────────────────────────────────────

export interface Policy { idleMinutes: number; floorGb: number }
export const DEFAULT_POLICY: Policy = { idleMinutes: 45, floorGb: 2 };

/**
 * Which unpinned agents to put to sleep: those idle past the limit, and when
 * free memory is under the floor, enough of the longest-idle others to get
 * back over it (about 0.5 GB per session). Pinned agents never.
 */
export function planSleeps(agents: { domain: string; pinned: boolean; idleSince: number | null }[], now: number, freeGb: number, policy: Policy = DEFAULT_POLICY): string[] {
  const out: string[] = [];
  const idle = agents.filter((a) => !a.pinned && a.idleSince != null).sort((a, b) => a.idleSince! - b.idleSince!);
  for (const a of idle) if (now - a.idleSince! >= policy.idleMinutes * 60_000) out.push(a.domain);
  let free = freeGb + out.length * 0.5;
  for (const a of idle) {
    if (free >= policy.floorGb) break;
    if (!out.includes(a.domain)) { out.push(a.domain); free += 0.5; }
  }
  return out;
}

/** Free plus inactive memory on macOS, in GB (what a new session can take). */
export function freeGb(): number {
  const r = spawnSync("vm_stat", { encoding: "utf8" });
  if (r.status !== 0) return Infinity;
  const size = Number(/page size of (\d+)/.exec(r.stdout)?.[1] ?? 16384);
  const pages = ["Pages free", "Pages inactive", "Pages speculative"].reduce((n, k) => n + Number(new RegExp(`${k}:\\s+(\\d+)`).exec(r.stdout)?.[1] ?? 0), 0);
  return (pages * size) / 1024 ** 3;
}

function idleStatePath(): string {
  return join(process.env.PREVAIL_CONFIG_DIR || join(homedir(), ".prevail"), "spaces-idle.json");
}

export interface TidyDeps {
  herdr?: Herdr;
  now?: number;
  freeGb?: number;
  policy?: Policy;
  /** Hold or drop each domain's lock on the hub (Step 4); absent = no hub. */
  presence?: (held: { domain: string; pane: string }[]) => Promise<void>;
  sleep?: (domain: string) => Promise<string>;
  dryRun?: boolean;
}

export async function tidy(vault: string, deps: TidyDeps = {}): Promise<{ awake: string[]; slept: string[] }> {
  const herdr = deps.herdr ?? realHerdr;
  const now = deps.now ?? Date.now();
  const panes = domainPanes(vault, herdr);
  const statePath = idleStatePath();
  let state: Record<string, number> = {};
  try { state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, number>; } catch { /* first run */ }
  const agents: { domain: string; pinned: boolean; idleSince: number | null }[] = [];
  const next: Record<string, number> = {};
  for (const [domain, p] of panes) {
    if (!p.agent) continue;
    const isIdle = p.agent_status === "idle" || p.agent_status === "done";
    if (isIdle) next[domain] = state[domain] ?? now;
    agents.push({ domain, pinned: !!readManifest(vault, domain)?.config.pinned, idleSince: isIdle ? next[domain]! : null });
  }
  const slept = planSleeps(agents, now, deps.freeGb ?? freeGb(), deps.policy ?? DEFAULT_POLICY);
  if (!deps.dryRun) {
    for (const d of slept) { await (deps.sleep ?? ((x) => sleepDomain(vault, x, herdr)))(d); delete next[d]; }
    try { mkdirSync(join(statePath, ".."), { recursive: true }); writeFileSync(statePath, JSON.stringify(next)); } catch { /* best effort */ }
    const held = agents.filter((a) => !slept.includes(a.domain)).map((a) => ({ domain: a.domain, pane: panes.get(a.domain)!.pane_id }));
    if (deps.presence) await deps.presence(held);
  }
  return { awake: agents.map((a) => a.domain).filter((d) => !slept.includes(d)), slept };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function glyphSpaces(args: string[]): number {
  const r = spawnSync("glyph-spaces", args, { stdio: "inherit" });
  if (r.error) { console.error("glyph-spaces is not on PATH: install glyph (its install.sh links glyph-spaces into ~/.local/bin)"); return 127; }
  return r.status ?? 1;
}

export async function spacesCommand(args: string[], vault: string): Promise<number> {
  const { parseModArgs } = await import("./cli-args.ts");
  const a = parseModArgs(args);
  const sub = a.pos[0] ?? "list";
  const say = (o: unknown, text: string) => process.stdout.write(a.json ? `${JSON.stringify(o, null, 2)}\n` : `${text}\n`);
  try {
    if (sub === "derive") {
      const r = deriveAll(vault, mapDir(), { dryRun: a.has("dry-run") });
      say(r, r.length ? r.map((x) => `${x.id}: ${x.tabs} tabs, ${x.agents} with an agent${x.changed ? (a.has("dry-run") ? ", would change" : ", updated") : ", unchanged"}`).join("\n") : `no space in ${mapDir()} has "source": "${DERIVED_SOURCE}"`);
      return 0;
    }
    if (sub === "cmd") {
      // Printed for eval; the trailing # swallows the mark glyph appends.
      process.stdout.write(`${await commandFor(vault, a.pos[1] ?? "", a.get("mark"))} #\n`);
      return 0;
    }
    if (sub === "start" && a.pos[1]) { say({ ok: true }, await wake(vault, a.pos[1])); return 0; }
    if (sub === "sleep" && a.pos[1]) { say({ ok: true }, await sleepDomain(vault, a.pos[1])); return 0; }
    if (sub === "tidy") {
      const policy = { idleMinutes: Number(a.get("idle-minutes") ?? DEFAULT_POLICY.idleMinutes), floorGb: Number(a.get("floor-gb") ?? DEFAULT_POLICY.floorGb) };
      const { hubPresence } = await import("./hub.ts");
      const r = await tidy(vault, { policy, dryRun: a.has("dry-run"), presence: hubPresence() ?? undefined });
      say(r, `awake: ${r.awake.join(", ") || "none"}; ${a.has("dry-run") ? "would sleep" : "slept"}: ${r.slept.join(", ") || "none"}`);
      return 0;
    }
    if (sub === "list") {
      let panes = new Map<string, Pane>();
      try { panes = domainPanes(vault, realHerdr); } catch { /* no herdr here */ }
      const rows = domainFacts(vault).filter((d) => !d.archived).map((d) => ({ ...d, tab: panes.has(d.name), agent: panes.get(d.name)?.agent ?? null, status: panes.get(d.name)?.agent_status ?? null }));
      say(rows, rows.map((r) => `${r.name.padEnd(14)} ${r.pinned ? "pinned" : "      "} ${r.tab ? (r.agent ? `${r.agent} ${r.status}` : "shell") : "no tab"}`).join("\n"));
      return 0;
    }
    if (["apply", "check", "names", "start", "remark"].includes(sub)) {
      if (sub !== "remark") deriveAll(vault);
      // glyph has no --vault; it reads the map, not the vault.
      const pass = args.filter((x, i) => x !== "--vault" && args[i - 1] !== "--vault" && !x.startsWith("--vault=") && x !== "--json");
      return glyphSpaces(pass);
    }
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  console.error("usage: prevail spaces list|derive [--dry-run]|apply|check|names|start [<domain>]|sleep <domain>|tidy [--idle-minutes N] [--floor-gb G] [--dry-run]|remark|cmd <domain>  (aidev is an alias)");
  return 1;
}
