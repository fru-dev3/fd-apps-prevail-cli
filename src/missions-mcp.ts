// Missions MS5: writes over MCP behind approval. Any AI tool can read
// missions (list_missions, read_mission, mission_context); creating one,
// changing its status and completing it are writes another agent asks for,
// so each is queued in the same Inbox as a connector write (an engine act)
// and runs only after the user's Allow, at once and exactly as asked. A retry
// of a write that already ran answers "already done" instead of queueing it
// again. The app itself never comes through here (it uses the CLI).

import { gateEngineAct, MISSION_TOOL_PREFIX } from "./act-gate.ts";

export type MissionWrite = "create_mission" | "set_mission_status" | "complete_mission";
const OPS = ["pause", "resume", "archive", "reopen"] as const;
const RESULTS = ["met", "partly", "not-met", "changed"] as const;

function clean(args: Record<string, unknown>, tool: MissionWrite): Record<string, unknown> {
  const s = (k: string, n = 200) => (typeof args[k] === "string" ? String(args[k]).replace(/\s+/g, " ").trim().slice(0, n) : "");
  if (tool === "create_mission") {
    const list = (k: string) => (Array.isArray(args[k]) ? (args[k] as unknown[]).map(String).filter((x) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(x)).slice(0, 4) : []);
    return { name: s("name", 120), ...(s("outcome", 300) ? { outcome: s("outcome", 300) } : {}), ...(/^\d{4}-\d{2}-\d{2}$/.test(s("target")) ? { target: s("target") } : {}), ...(s("owner") ? { owner: s("owner", 40) } : {}), consult: list("consult"), inform: list("inform") };
  }
  if (tool === "set_mission_status") return { mission: s("mission", 80), op: s("op", 10) };
  return { mission: s("mission", 80), result: s("result", 10) || "met", ...(s("note", 200) ? { note: s("note", 200) } : {}) };
}

/** What the Inbox shows for the request: plain, and for a close-out, what it would file. */
async function summaryOf(vault: string, tool: MissionWrite, a: Record<string, unknown>): Promise<string> {
  if (tool === "create_mission") return `Start the project "${a.name}"${a.outcome ? `: ${a.outcome}` : ""}${a.target ? `, by ${a.target}` : ""}`;
  if (tool === "set_mission_status") return `${String(a.op).charAt(0).toUpperCase()}${String(a.op).slice(1)} the project ${a.mission}`;
  try {
    const { planCloseout } = await import("./closeout.ts");
    const plan = planCloseout(vault, String(a.mission), { result: a.result as (typeof RESULTS)[number] });
    const kept = plan.filings.filter((f) => f.apply);
    return `Complete the project ${plan.name} (${a.result}): files ${kept.length} line${kept.length === 1 ? "" : "s"} into ${[...new Set(kept.map((f) => f.domain))].join(", ") || "nothing"}, each with Undo for 7 days`;
  } catch { return `Complete the project ${a.mission} (${a.result})`; }
}

/** Is this write already done (so a retry after the Allow does not queue it again)? */
async function alreadyDone(vault: string, tool: MissionWrite, a: Record<string, unknown>): Promise<string | null> {
  const m = await import("./missions.ts");
  if (tool === "create_mission") { const slug = m.missionSlugify(String(a.name)); return slug && m.missionExists(vault, slug) ? `The project mission/${slug} exists.` : null; }
  const cur = m.readMission(vault, String(a.mission));
  if (!cur) return null;
  if (tool === "complete_mission") return cur.status === "completed" ? `The project ${cur.name} is completed.` : null;
  const to = { pause: "paused", resume: "active", archive: "archived", reopen: "active" }[String(a.op) as (typeof OPS)[number]];
  return to && cur.status === to && String(a.op) !== "reopen" ? `The project ${cur.name} is ${cur.status}.` : null;
}

function validate(tool: MissionWrite, a: Record<string, unknown>): string | null {
  if (tool === "create_mission" && !a.name) return "a project needs a name";
  if (tool !== "create_mission" && !a.mission) return "which project? (a slug from list_missions)";
  if (tool === "set_mission_status" && !(OPS as readonly string[]).includes(String(a.op))) return "op is pause, resume, archive or reopen";
  if (tool === "complete_mission" && !(RESULTS as readonly string[]).includes(String(a.result))) return "result is met, partly, not-met or changed";
  return null;
}

/** The MCP tool: validate, then run only under the user's Allow; otherwise queue it in the Inbox. */
export async function missionWriteTool(vault: string, tool: MissionWrite, raw: Record<string, unknown>): Promise<string> {
  const a = clean(raw, tool);
  const bad = validate(tool, a);
  if (bad) throw new Error(bad);
  const done = await alreadyDone(vault, tool, a);
  if (done) return `Already done: ${done}`;
  const g = gateEngineAct(vault, "general", `${MISSION_TOOL_PREFIX}${tool}`, a, await summaryOf(vault, tool, a));
  if (g.state === "declined") return "The user declined this. It was not done; do not ask again right away.";
  if (g.state === "queued") return `Not done yet: this waits for the user's approval in Prevail's Inbox (id ${g.id}). Once they allow it, Prevail does it at once; you do not need to call again.`;
  return run(vault, tool, a);
}

async function run(vault: string, tool: MissionWrite, a: Record<string, unknown>): Promise<string> {
  const m = await import("./missions.ts");
  if (tool === "create_mission") {
    const domains = [...(a.owner ? [{ slug: String(a.owner), role: "owner" as const }] : []), ...((a.consult as string[]) ?? []).map((slug) => ({ slug, role: "consulted" as const })), ...((a.inform as string[]) ?? []).map((slug) => ({ slug, role: "informed" as const }))];
    const v = m.createMission(vault, { name: String(a.name), ...(a.outcome ? { outcome: String(a.outcome) } : {}), ...(a.target ? { target: String(a.target) } : {}), ...(domains.length ? { domains } : {}), from: "mcp (approved)" });
    return `Started the project ${v.name} (mission/${v.slug}), target ${v.target}.`;
  }
  if (tool === "set_mission_status") { const v = m.transition(vault, String(a.mission), String(a.op) as (typeof OPS)[number]); return `The project ${v.name} is ${v.status}.`; }
  const { applyCloseout, planCloseout } = await import("./closeout.ts");
  const plan = planCloseout(vault, String(a.mission), { result: a.result as (typeof RESULTS)[number], ...(a.note ? { resultNote: String(a.note) } : {}) });
  const r = applyCloseout(vault, plan);
  return `Completed the project ${r.mission.name}: ${r.receipts.length} line${r.receipts.length === 1 ? "" : "s"} filed, each with Undo for 7 days.`;
}

/** After the user's Allow in the Inbox: the grant minted by the approval is consumed and the write runs now. */
export async function runApprovedMissionWrite(vault: string, tool: string, args: Record<string, unknown>): Promise<{ ran?: string; error?: string }> {
  const name = tool.slice(MISSION_TOOL_PREFIX.length) as MissionWrite;
  if (!["create_mission", "set_mission_status", "complete_mission"].includes(name)) return { error: `unknown project write ${name}` };
  const done = await alreadyDone(vault, name, args);
  if (done) return { ran: done };
  const g = gateEngineAct(vault, "general", tool, args, await summaryOf(vault, name, args));
  if (g.state !== "allow") return { error: "no approval found for this exact request" };
  try { return { ran: await run(vault, name, args) }; } catch (e) { return { error: (e as Error).message }; }
}
