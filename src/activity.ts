// System Activity log — the persistent record of everything Prevail does on its
// own, so the desktop's Automation tab can show a full history (not just the
// ephemeral "running now" indicator). One append-only JSONL at
// <vault>/_meta/activity.jsonl; every autonomous producer (loop runs, action
// executions, tasks filed by loops, briefings, app syncs) appends one line.
//
// Append is encryption-aware (vappendLine) so it stays consistent with the rest
// of the vault. Best-effort: logging never throws into a producer's hot path —
// observability must not break the thing being observed.
import { join } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { runtimePath } from "./path-safety.ts";
import { vappendLine, vreadFile, vrotateLedgerPrefix } from "./vault-session.ts";

// Retention: the activity ledger is append-only and, unlike _intents.jsonl, was
// never rotated — so it grew unbounded and got slower to read as a vault aged.
// Once it passes ACTIVITY_MAX_BYTES, roll the oldest records into
// activity.archive.jsonl (retrievable, never deleted), keeping a recent tail.
const ACTIVITY_MAX_BYTES = 1_000_000;   // ~1 MB before we rotate
const ACTIVITY_KEEP_TAIL_BYTES = 400_000; // keep the most recent ~400 KB live

export type ActivityType =
  | "loop_run"     // a loop evaluated on its cadence or via Run-now
  | "loop_exec"    // an approved action was executed for real via connectors
  | "task_filed"   // a loop filed a concrete task
  | "briefing"     // a briefing was synthesized + delivered
  | "sync"         // a connected app was refreshed
  | "nudge"        // a proactive nudge/prompt fired
  | "playbook"     // a multi-step orchestrator run (cross-app/cross-domain)
  | "playbook_step" // one step within a playbook run
  | "other";

export interface ActivityEvent {
  ts: number;
  type: ActivityType;
  domain?: string;
  title: string;            // one-line, human-readable summary
  detail?: string;          // optional longer note (the loop's read, a result, etc.)
  status?: "ok" | "error" | "pending";
  ref?: string;             // loop id / skill id / task text — to jump to the source
}

export function activityFile(vaultRoot: string): string {
  return join(runtimePath(vaultRoot, "_meta"), "activity.jsonl");
}

// Append one event. Swallows all errors — a failed log must never fail the run.
export function logActivity(vaultRoot: string, ev: Omit<ActivityEvent, "ts"> & { ts?: number }): void {
  try {
    const dir = runtimePath(vaultRoot, "_meta");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const full: ActivityEvent = {
      ts: ev.ts ?? Date.now(),
      type: ev.type,
      title: ev.title,
      ...(ev.domain ? { domain: ev.domain } : {}),
      ...(ev.detail ? { detail: ev.detail } : {}),
      ...(ev.status ? { status: ev.status } : {}),
      ...(ev.ref ? { ref: ev.ref } : {}),
    };
    const file = activityFile(vaultRoot);
    vappendLine(file, JSON.stringify(full) + "\n");
    // Cheap size check on each append (activity events are low-frequency); rotate
    // the head into the archive once the live file grows past the cap.
    try {
      if (statSync(file).size > ACTIVITY_MAX_BYTES) {
        vrotateLedgerPrefix(file, join(dir, "activity.archive.jsonl"), ACTIVITY_MAX_BYTES, ACTIVITY_KEEP_TAIL_BYTES);
      }
    } catch { /* rotation is best-effort */ }
  } catch {
    /* best effort — observability must not break the producer */
  }
}

// Read the most recent events, newest first. Tolerates malformed lines. Reads
// the whole file (encryption-aware) then slices — fine at v1 volumes; if the log
// ever grows huge we'd tail it instead.
export function readActivity(vaultRoot: string, limit = 200): ActivityEvent[] {
  try {
    const f = activityFile(vaultRoot);
    if (!existsSync(f)) return [];
    const raw = vreadFile(f);
    const out: ActivityEvent[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const ev = JSON.parse(t) as ActivityEvent;
        if (ev && typeof ev.ts === "number" && typeof ev.title === "string") out.push(ev);
      } catch { /* skip malformed */ }
    }
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}
