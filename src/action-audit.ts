// action-audit — append-only ledger of consequential agent actions (C1 / O94).
//
// The first concrete piece of the Action Authorization story: a durable, redacted
// record of every consequential action the agent takes on the user's behalf —
// what was requested, the outcome, and a scrubbed summary of what happened — so
// the user (or a future policy/UI layer) can reconstruct it. Encryption-aware
// (vappendLine) and secret-redacted before write.
//
// Lives at <vault>/_log/action-audit.jsonl, one JSON object per line.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { vappendLine } from "./vault-session.ts";
import { redact } from "./privacy.ts";

export type ActionOutcome = "executed" | "no_connector" | "error" | "proposed";

export interface ActionAuditEntry {
  ts: number;
  domain: string;
  action: string;
  outcome: ActionOutcome;
  provider?: string;
  model?: string;
  report?: string;
}

export function actionAuditPath(vaultRoot: string): string {
  return join(vaultRoot, "_log", "action-audit.jsonl");
}

/// Append one redacted audit record. Best-effort: auditing must never block or
/// fail the action path.
export function auditAction(vaultRoot: string, entry: ActionAuditEntry): void {
  try {
    const logDir = join(vaultRoot, "_log");
    mkdirSync(logDir, { recursive: true });
    const safe: ActionAuditEntry = {
      ...entry,
      action: redact(entry.action).slice(0, 300),
      report: entry.report ? redact(entry.report).slice(0, 500) : undefined,
    };
    vappendLine(actionAuditPath(vaultRoot), `${JSON.stringify(safe)}\n`);
  } catch {
    /* best-effort */
  }
}
