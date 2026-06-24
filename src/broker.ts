// broker — the single policy decision for the autonomous daemon: may it ACT on an
// action now, or must it propose it for approval? (C1 / A-05 / O5). Consolidates
// the action taxonomy (classifyAction) and the autonomy gate (isConsequential +
// opt-in) so every caller asks one question instead of re-deriving the rule.

import { classifyAction, isConsequential, type ActionClass } from "./action-policy.ts";

export interface ActionDecision {
  cls: ActionClass;
  /** True ONLY when autonomy is opted in AND the action isn't consequential. */
  mayAutoExecute: boolean;
}

export function decideAction(action: string, opts: { autonomousActs: boolean }): ActionDecision {
  const cls = classifyAction(action);
  return { cls, mayAutoExecute: opts.autonomousActs === true && !isConsequential(cls) };
}
