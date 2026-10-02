// Projects became Missions (missions-plan.md). The entity kind project/<slug>
// is retired: `prevail missions migrate` (run by groom) carries old project
// pages into data/missions/<slug>/, and every old id, command and export here
// resolves to the mission. Prompt groups (prompt-projects.ts) are a
// different thing and keep their names.
//
// Goals link to a mission with `~mission:<slug>` (or the older `~project:<slug>`)
// on their line in any domain's source/goals.md.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { readIndex, slugify } from "./entities.ts";
import { createMission, missionView, parseDomainArg, readMission, setMission, transition, type MissionView } from "./missions.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { resolveDomainDir } from "./path-safety.ts";
import { vreadFile } from "./vault-session.ts";

export interface ProjectGoal { title: string; status: string; domain: string; id?: string }
export type ProjectDetail = MissionView & { goals: ProjectGoal[] };

export interface ProjectPatch { status?: string; outcome?: string; target?: string; domains?: string[] }
export interface CreateProjectInput extends Omit<ProjectPatch, "status"> { name: string; fromIntent?: string; now?: number }

export const RENAMED_NOTE = "entity projects are now Projects: use `prevail projects`";

/** Alias: creates a mission (first domain owns it, the rest are consulted). */
export function createProject(vault: string, i: CreateProjectInput): ProjectDetail {
  const domains = (i.domains ?? []).map((d, n) => parseDomainArg(d, n === 0 ? "owner" : "consulted"));
  const v = createMission(vault, { name: i.name, outcome: i.outcome, target: i.target, domains, promptProjects: i.fromIntent ? [i.fromIntent] : [], from: i.fromIntent ? `from the prompt project ${i.fromIntent}` : undefined, now: i.now });
  return { ...v, goals: projectGoals(vault, v.slug) };
}

/** Alias: status active|paused|archived moves the mission; done asks for the close-out. */
export function setProject(vault: string, id: string, patch: ProjectPatch, o: { now?: number } = {}): ProjectDetail {
  const now = o.now ?? Date.now();
  const m = readMission(vault, id);
  if (!m) throw new Error(`no project "${id}"`);
  if (patch.status && patch.status !== m.status) {
    const s = patch.status === "done" ? "completed" : patch.status;
    if (s === "completed") throw new Error("complete a project with its close-out: prevail projects complete <slug>");
    const op = s === "paused" ? "pause" : s === "archived" ? "archive" : m.status === "paused" ? "resume" : "reopen";
    transition(vault, m.slug, op, { now });
  }
  if (patch.outcome !== undefined || patch.target !== undefined) setMission(vault, m.slug, { outcome: patch.outcome, target: patch.target }, now);
  return projectDetail(vault, m.slug)!;
}

/** A mission with its goals, or null. Takes mission/<slug>, project/<slug> or a slug. */
export function projectDetail(vault: string, id: string): ProjectDetail | null {
  const v = missionView(vault, id);
  return v ? { ...v, goals: projectGoals(vault, v.slug) } : null;
}

// ── Goals ───────────────────────────────────────────────────────────────

const GOAL_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/;

/** One source/goals.md line: its title, status and ~key:value tokens. Null when not a goal. */
export function parseGoalLine(line: string): { title: string; status: string; tokens: Record<string, string> } | null {
  const m = line.match(GOAL_RE);
  if (!m) return null;
  const tokens: Record<string, string> = {};
  const title = m[2].replace(/(^|\s)~([a-z_]+):(\S+)/g, (_x, _s, k: string, v: string) => { tokens[k] = v; return ""; }).replace(/\s+/g, " ").trim();
  return { title, status: tokens.status || (m[1].toLowerCase() === "x" ? "done" : "active"), tokens };
}

/** Every goal, in any domain, whose line carries `~mission:<slug>` or `~project:<slug>` (merged slugs count for their keeper). */
export function projectGoals(vault: string, slug: string): ProjectGoal[] {
  const merged = readIndex(vault).merged ?? {};
  const out: ProjectGoal[] = [];
  for (const domain of listDomainDirs(vault)) {
    const dir = resolveDomainDir(vault, domain);
    const path = [join(dir, "source", "goals.md"), join(dir, "goals.md")].find((p) => existsSync(p));
    if (!path) continue;
    let text = "";
    try { text = vreadFile(path); } catch { continue; }
    for (const line of text.split("\n")) {
      const g = parseGoalLine(line);
      const tag = g?.tokens.mission || g?.tokens.project ? slugify(g.tokens.mission ?? g.tokens.project!) : "";
      if (!g || !tag) continue;
      const into = merged[`project/${tag}`];
      if ((into ? into.slice(into.indexOf("/") + 1) : tag) !== slug) continue;
      out.push({ title: g.title, status: g.status, domain, ...(g.tokens.id ? { id: g.tokens.id } : {}) });
    }
  }
  return out;
}

// ── CLI aliases: prevail projects create | set | show project/<slug> ──────

/**
 * The old `prevail projects create|set|show project/<slug>` commands, kept as
 * aliases of `prevail missions`. Returns the exit code, or null when the
 * subcommand belongs to prompt groups.
 */
export async function projectsEntityCommand(a: string[], vault: string): Promise<number | null> {
  const sub = a[0];
  const pos = a.filter((x, i) => !x.startsWith("--") && !(i > 0 && a[i - 1]!.startsWith("--") && !["--json"].includes(a[i - 1]!)));
  if (sub !== "create" && sub !== "set" && !(sub === "show" && pos[1]?.startsWith("project/"))) return null;
  // New-style calls go straight to the missions command; only the old flags need mapping.
  const old = a.some((x) => ["--domain", "--domains", "--from-intent", "--status"].includes(x)) || !!pos[1]?.startsWith("project/");
  if (!old) return null;
  process.stderr.write(`prevail projects ${sub}: ${RENAMED_NOTE}\n`);
  const { missionsCommand } = await import("./missions-cli.ts");
  const rest = a.slice(1).map((x) => (x === "--from-intent" ? "--from-prompt-project" : x === "--domain" ? "--owner" : x));
  if (sub === "create") {
    // The first --domain owns it; any more are consulted.
    let seen = false;
    const fixed = rest.map((x) => { if (x === "--owner") { if (seen) return "--consult"; seen = true; } return x; });
    return missionsCommand(["create", ...fixed], vault);
  }
  if (sub === "set") {
    const st = a.indexOf("--status");
    const status = st >= 0 ? a[st + 1] : undefined;
    const id = pos[1] ?? "";
    if (status) {
      const op = status === "paused" ? "pause" : status === "archived" ? "archive" : status === "done" || status === "completed" ? "complete" : "resume";
      if (op !== "complete") { const c = await missionsCommand([op, id, ...(a.includes("--json") ? ["--json"] : [])], vault); if (c !== 0) return c; }
    }
    return missionsCommand(["set", id, ...rest.filter((x, i) => x !== "--status" && rest[i - 1] !== "--status" && x !== id)], vault);
  }
  return missionsCommand(["show", pos[1]!, ...(a.includes("--json") ? ["--json"] : [])], vault);
}
