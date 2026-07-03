// broker — the single policy decision for the autonomous daemon: may it ACT on an
// action now, or must it propose it for approval? (C1 / A-05 / O5). Consolidates
// the action taxonomy (classifyAction) and the autonomy gate (isConsequential +
// opt-in) so every caller asks one question instead of re-deriving the rule.

import { classifyAction, isConsequential, type ActionClass } from "./action-policy.ts";
import { isPaused, policyFor, getMonthlyFinancialCap, monthSpendUsd } from "./autonomy.ts";

// Best-effort dollar amount from an action's text ("pay the $1,200.50 invoice" → 1200.5).
export function parseAmountUsd(text: string): number | null {
  const m = /\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/.exec(text ?? "");
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

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
  let decision: GateDecision = opts.autonomousActs ? "auto" : "ask";
  // Spend cap: even an allowed+auto financial action is downgraded to "ask" when
  // it would push this month's executed spend past the user's monthly cap.
  if (decision === "auto" && cls === "financial") {
    const cap = getMonthlyFinancialCap(opts.vault);
    if (cap != null) {
      const amount = parseAmountUsd(action);
      const spent = monthSpendUsd(opts.vault);
      // When the amount can't be read from the action text, we can't prove it
      // fits under the cap - so require approval instead of silently treating it
      // as $0 (which would let an unbounded spend bypass the cap entirely).
      if (amount == null) {
        return { cls, decision: "ask", reason: `monthly financial cap is set ($${cap}) but this action's amount is unknown — approve to run` };
      }
      if (spent + amount > cap) {
        return { cls, decision: "ask", reason: `monthly financial cap $${cap} would be exceeded (spent $${spent.toFixed(2)} this month)` };
      }
    }
  }
  return { cls, decision, reason: decision === "ask" ? "autonomy not enabled — approve to run" : undefined };
}
