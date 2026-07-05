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
import { vreadFile } from "./vault-session.ts";
import { appendLedger, readLedgerAll } from "./ledger.ts";
import { shardPathFor, shardPaths } from "./ledger-shard.ts";
import { redact } from "./privacy.ts";
import { classifyAction, type ActionClass } from "./action-policy.ts";

export type ActionOutcome = "executed" | "no_connector" | "error" | "proposed" | "blocked_by_email_policy" | "blocked_by_egress_guard";

export interface ActionAuditEntry {
  ts: number;
  domain: string;
  action: string;
  outcome: ActionOutcome;
  cls?: ActionClass; // risk class — derived in auditAction if absent
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
      cls: entry.cls ?? classifyAction(entry.action),
      action: redact(entry.action).slice(0, 300),
      report: entry.report ? redact(entry.report).slice(0, 500) : undefined,
    };
    // Per-host shard (G4): this machine appends to action-audit.<host>.jsonl,
    // so a two-way file sync never has two writers for one file. Readers merge.
    appendLedger(shardPathFor(actionAuditPath(vaultRoot)), JSON.stringify(safe), Date.now());
  } catch {
    /* best-effort */
  }
}

/** Read the whole audit ledger across ALL host shards (+ any legacy single
 *  file), newest-last by ts. Encryption-aware per shard. */
export function readActionAudit(vaultRoot: string): ActionAuditEntry[] {
  const out: ActionAuditEntry[] = [];
  for (const path of shardPaths(actionAuditPath(vaultRoot))) {
    // Each host shard's live tail PLUS its archived months.
    for (const rec of readLedgerAll<ActionAuditEntry>(path)) out.push(rec);
  }
  return out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}
