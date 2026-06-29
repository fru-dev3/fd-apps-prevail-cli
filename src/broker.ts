// broker — the single policy decision for the autonomous daemon: may it ACT on an
// action now, or must it propose it for approval? (C1 / A-05 / O5). Consolidates
// the action taxonomy (classifyAction) and the autonomy gate (isConsequential +
// opt-in) so every caller asks one question instead of re-deriving the rule.

import { classifyAction, isConsequential, type ActionClass } from "./action-policy.ts";
import { isPaused, policyFor } from "./autonomy.ts";

export interface ActionDecision {
  cls: ActionClass;
  /** True ONLY when autonomy is opted in AND the action isn't consequential. */
  mayAutoExecute: boolean;
}

export function decideAction(action: string, opts: { autonomousActs: boolean }): ActionDecision {
  const cls = classifyAction(action);
  return { cls, mayAutoExecute: opts.autonomousActs === true && !isConsequential(cls) };
}

// The full gate, layering the user's global brake + pre-emptive policy on top of
// the autonomy opt-in. Every autonomous actor (orchestrator, loop daemon, agent
// computer-use) asks THIS so the rules live in one place:
//   - global pause         → block everything
//   - policy[class]=never  → hard block
//   - policy[class]=ask    → route to the Decision Inbox
//   - policy[class]=allow  → auto-run IF global autonomy is opted in, else ask
export type GateDecision = "auto" | "ask" | "block";
export interface ActionGate {
  cls: ActionClass;
  decision: GateDecision;
  reason?: string;
}

export function gateAction(
  action: string,
  opts: { vault: string; autonomousActs: boolean },
): ActionGate {
  const cls = classifyAction(action);
  if (isPaused(opts.vault)) return { cls, decision: "block", reason: "autonomy is globally paused" };
  const pol = policyFor(opts.vault, cls);
  if (pol === "never") return { cls, decision: "block", reason: `policy: "${cls}" actions are never allowed` };
  if (pol === "ask") return { cls, decision: "ask", reason: `policy: "${cls}" actions need approval` };
  // pol === "allow": still requires the global autonomy opt-in to run unattended.
  return {
    cls,
    decision: opts.autonomousActs ? "auto" : "ask",
    reason: opts.autonomousActs ? undefined : "autonomy not enabled — approve to run",
  };
}
