// What happens after the user answers an engine act in the Inbox (the same
// Allow / Deny as a connector write). A connector act is re-run by the model
// that asked; an engine act is the engine's own, so the engine carries it out
// at once: the Operator's action runs in its own process (it can take
// minutes), behind the broker again; a declined one is marked on its job. An
// MCP mission write (create, status, complete) runs at once, exactly as asked.

import { MISSION_TOOL_PREFIX, OPERATOR_TOOL, type PendingAct } from "./act-gate.ts";

export function isEngineAct(tool: string): boolean {
  return tool === OPERATOR_TOOL || tool.startsWith(MISSION_TOOL_PREFIX);
}

export async function afterActAnswer(vault: string, act: PendingAct, answer: "approved" | "denied"): Promise<{ ran?: string; error?: string }> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(act.argsJson) as Record<string, unknown>; } catch { return { error: "unreadable act" }; }
  if (act.tool === OPERATOR_TOOL) {
    const job = String(args.job ?? "");
    const n = Number(args.n);
    if (!job || !Number.isInteger(n)) return { error: "no job or action number" };
    const jobs = await import("./jobs.ts");
    if (answer === "denied") { await jobs.actOnAction(vault, job, n, { decline: true }); return { ran: "declined" }; }
    const { spawn } = await import("node:child_process");
    const [bin, ...pre] = jobs.selfCommand();
    const child = spawn(bin!, [...pre, "--vault", vault, "job", "act", job, String(n)], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
    return { ran: `job act ${job} ${n}` };
  }
  if (act.tool.startsWith(MISSION_TOOL_PREFIX)) {
    if (answer === "denied") return { ran: "declined" };
    return (await import("./missions-mcp.ts")).runApprovedMissionWrite(vault, act.tool, args);
  }
  return {};
}
