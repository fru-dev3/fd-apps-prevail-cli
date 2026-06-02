import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppSkill, Domain } from "./vault.ts";
import { buildDomainHeatmap } from "./heatmap.ts";

const DATA_DIR = join(homedir(), ".aireadyu");
const WATCHER_LOG = join(DATA_DIR, "watcher.jsonl");

export type ObservationKind =
  | "stale-state"
  | "loops-spike"
  | "domain-cold"
  | "app-cold";

export interface Observation {
  ts: number;
  kind: ObservationKind;
  severity: "info" | "warn" | "critical";
  target: string;
  message: string;
}

// Run one pass of the watcher. Stateless beyond what's in the vault + the
// JSONL log itself — the heuristics deliberately don't carry hidden state, so
// findings re-emerge if the user ignores them (and disappear when the
// underlying signal goes away). Returns only NEW observations not seen in the
// last 24h of log entries.
export function runWatcher(domains: Domain[], apps: AppSkill[]): Observation[] {
  const findings: Observation[] = [];
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  for (const d of domains) {
    const ageMs = d.stateMtime ? now - d.stateMtime : null;
    if (ageMs !== null && ageMs > 14 * day) {
      const days = Math.floor(ageMs / day);
      findings.push({
        ts: now,
        kind: "stale-state",
        severity: days > 60 ? "critical" : "warn",
        target: d.name,
        message: `${d.name}/state.md hasn't changed in ${days}d — sync or archive`,
      });
    }
    if (d.openLoopCount >= 8) {
      findings.push({
        ts: now,
        kind: "loops-spike",
        severity: d.openLoopCount >= 15 ? "critical" : "warn",
        target: d.name,
        message: `${d.name} has ${d.openLoopCount} open items — consider a triage chat`,
      });
    }
  }

  // Heatmap-driven cold detection: domains with zero chat activity in 30d but
  // a present state.md (so the user does care, just isn't engaging).
  try {
    const heat = buildDomainHeatmap(
      30,
      domains.map((d) => d.name),
    );
    for (const row of heat) {
      if (row.total === 0) {
        const dom = domains.find((dd) => dd.name === row.domain);
        if (dom?.hasState) {
          findings.push({
            ts: now,
            kind: "domain-cold",
            severity: "info",
            target: row.domain,
            message: `${row.domain} has no chats in 30d — still relevant?`,
          });
        }
      }
    }
  } catch {}

  for (const a of apps) {
    if (!a.community && a.hasState && a.openLoopCount >= 5) {
      findings.push({
        ts: now,
        kind: "loops-spike",
        severity: "warn",
        target: a.id,
        message: `app ${a.id} has ${a.openLoopCount} open items`,
      });
    }
  }

  return dedupAgainstRecent(findings);
}

// Drop findings already logged within the last 24h. Reading the log is cheap
// (typically <1KB) and gives us simple monotonic suppression without an
// additional in-memory state cache.
function dedupAgainstRecent(findings: Observation[]): Observation[] {
  if (!existsSync(WATCHER_LOG)) return findings;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  try {
    const raw = readFileSync(WATCHER_LOG, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as Observation;
        if (o.ts >= cutoff) seen.add(`${o.kind}::${o.target}`);
      } catch {}
    }
  } catch {
    return findings;
  }
  return findings.filter((f) => !seen.has(`${f.kind}::${f.target}`));
}

export function recordObservations(obs: Observation[]): void {
  if (obs.length === 0) return;
  try {
    const blob = obs.map((o) => JSON.stringify(o)).join("\n") + "\n";
    appendFileSync(WATCHER_LOG, blob);
  } catch {}
}

export function readRecentObservations(limit = 20): Observation[] {
  if (!existsSync(WATCHER_LOG)) return [];
  try {
    const raw = readFileSync(WATCHER_LOG, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const tail = lines.slice(-Math.max(limit, 1));
    const out: Observation[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as Observation);
      } catch {}
    }
    return out.reverse();
  } catch {
    return [];
  }
}

export function renderObservationsText(obs: Observation[]): string {
  if (obs.length === 0) {
    return "watcher has nothing to flag right now — your vault is in good shape.";
  }
  const lines: string[] = [];
  lines.push(`watcher · last ${obs.length} observation${obs.length === 1 ? "" : "s"} (newest first):`);
  for (const o of obs) {
    const when = formatRelative(o.ts);
    const sev = o.severity === "critical" ? "‼" : o.severity === "warn" ? "▲" : "·";
    lines.push(`  ${sev} ${when}  ${o.message}`);
  }
  return lines.join("\n");
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
