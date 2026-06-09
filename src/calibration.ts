import { readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { vreadFile, vwriteFile } from "./vault-session.ts";

// Calibration loop — "council vs. yourself". Before fanning out to the
// panel, the user records their gut take in one line. The log entry stores
// gut + verdict + a retrospective_due date (90 days out). On or after that
// date, prevAIl asks "how did that actually play out?" — the answer feeds
// a running calibration score per domain.
//
// All persistence is markdown. Per-entry metadata lives in an HTML comment
// block at the top of each log section (invisible in rendered markdown,
// trivial to grep, no YAML parser needed):
//
//   ## 14:32  ·  ⚖ council  ·  🔀 disagreement
//   <!-- prevail-meta: id=20260603-1432 | gut=prepay — guaranteed return
//     | retro_due=2026-09-01 | outcome= -->
//
//   **Q:** should I prepay the mortgage or invest the cash?
//   **A:** ...
//
// The running scoreboard lives at <domain>/_calibration.md as a markdown
// table. Computed lazily — pure derived state from the _log/*.md files.

export interface LogEntryMeta {
  id: string;                // YYYYMMDD-HHMM (matches the time header)
  domain: string;
  gut?: string;              // user's pre-council guess
  verdict?: string;          // chair's verdict
  retroDue?: string;         // YYYY-MM-DD when we should ask "how'd it go?"
  outcome?: string;          // user's retrospective ("right" / "wrong" / "partial" / freeform)
  ts: number;
  file: string;              // absolute path to the _log file holding this entry
}

const META_PREFIX = "<!-- prevail-meta:";
const META_SUFFIX = "-->";

// Encode a metadata object into the inline comment form. Pipe-separated
// because HTML comments forbid `--` sequences and we want a single line.
export function encodeMeta(m: Partial<LogEntryMeta>): string {
  const parts: string[] = [];
  if (m.id) parts.push(`id=${m.id}`);
  if (m.gut !== undefined) parts.push(`gut=${escapeMeta(m.gut)}`);
  if (m.verdict !== undefined) parts.push(`verdict=${escapeMeta(m.verdict)}`);
  if (m.retroDue) parts.push(`retro_due=${m.retroDue}`);
  if (m.outcome !== undefined) parts.push(`outcome=${escapeMeta(m.outcome)}`);
  return `${META_PREFIX} ${parts.join(" | ")} ${META_SUFFIX}`;
}

// Decode a single metadata line. Returns null for non-matching strings.
export function decodeMeta(line: string): Partial<LogEntryMeta> | null {
  const t = line.trim();
  if (!t.startsWith(META_PREFIX) || !t.endsWith(META_SUFFIX)) return null;
  const body = t.slice(META_PREFIX.length, -META_SUFFIX.length).trim();
  const out: Partial<LogEntryMeta> = {};
  for (const part of body.split("|").map((s) => s.trim())) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const val = unescapeMeta(part.slice(eq + 1).trim());
    if (key === "id") out.id = val;
    else if (key === "gut") out.gut = val;
    else if (key === "verdict") out.verdict = val;
    else if (key === "retro_due") out.retroDue = val;
    else if (key === "outcome") out.outcome = val || undefined;
  }
  return out;
}

function escapeMeta(s: string): string {
  // Pipes and angle brackets break the format; collapse newlines.
  return s.replace(/\s+/g, " ").replace(/\|/g, "/").replace(/-->/g, "—>").trim();
}

function unescapeMeta(s: string): string {
  return s;
}

// Default look-ahead for retrospective_due — 90 days. Most decisions show
// their fruit within a quarter; longer windows mean too many decisions get
// forgotten before retrospective.
export const DEFAULT_RETRO_DAYS = 90;

export function defaultRetroDue(now = Date.now(), days = DEFAULT_RETRO_DAYS): string {
  const d = new Date(now + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// Scan every _log/*.md under <domainPath>, parse meta blocks, return entries
// whose retroDue date has passed AND don't yet have an outcome recorded.
export function listPendingRetrospectives(domainPath: string, now = Date.now()): LogEntryMeta[] {
  const dir = join(domainPath, "_log");
  if (!existsSync(dir)) return [];
  const today = new Date(now).toISOString().slice(0, 10);
  const out: LogEntryMeta[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const file = join(dir, name);
    let content: string;
    try {
      content = vreadFile(file);
    } catch {
      continue;
    }
    // Walk lines; whenever we hit a meta line, decode and check.
    for (const line of content.split("\n")) {
      const decoded = decodeMeta(line);
      if (!decoded || !decoded.retroDue) continue;
      if (decoded.outcome && decoded.outcome.length > 0) continue;
      if (decoded.retroDue > today) continue;
      out.push({
        id: decoded.id ?? "",
        domain: domainPath.split("/").pop() ?? "",
        gut: decoded.gut,
        verdict: decoded.verdict,
        retroDue: decoded.retroDue,
        outcome: decoded.outcome,
        ts: 0,
        file,
      });
    }
  }
  return out;
}

// Find a log entry by its id (YYYYMMDD-HHMM) and update its outcome.
// Rewrites the meta line in place. Returns true if found and updated.
export function recordOutcome(domainPath: string, id: string, outcome: string): boolean {
  const dir = join(domainPath, "_log");
  if (!existsSync(dir)) return false;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const file = join(dir, name);
    let content: string;
    try {
      content = vreadFile(file);
    } catch {
      continue;
    }
    const lines = content.split("\n");
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const decoded = decodeMeta(lines[i]!);
      if (!decoded || decoded.id !== id) continue;
      lines[i] = encodeMeta({ ...decoded, outcome });
      changed = true;
      break;
    }
    if (changed) {
      vwriteFile(file, lines.join("\n"));
      return true;
    }
  }
  return false;
}

// Recompute and write the per-domain calibration scoreboard. Pure derived
// state from the _log/*.md frontmatter, so safe to regenerate any time —
// the file is meant to be read, not edited by hand.
export interface CalibrationStats {
  total: number;       // decisions with both gut + outcome
  agreed: number;      // gut matched council verdict before outcome
  rightOnAgreement: number;
  rightOnDisagreement: number;
  pending: number;     // retrospectives still owed
}

export function computeCalibration(domainPath: string): CalibrationStats {
  const dir = join(domainPath, "_log");
  const stats: CalibrationStats = { total: 0, agreed: 0, rightOnAgreement: 0, rightOnDisagreement: 0, pending: 0 };
  if (!existsSync(dir)) return stats;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    let content: string;
    try {
      content = vreadFile(join(dir, name));
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const m = decodeMeta(line);
      if (!m || !m.gut) continue;
      if (!m.outcome) {
        if (m.retroDue) stats.pending++;
        continue;
      }
      stats.total++;
      const gutVsVerdict = looselyAgrees(m.gut, m.verdict ?? "");
      if (gutVsVerdict) stats.agreed++;
      const outcomeRight = /\b(right|correct|yes|hit|win|good)\b/i.test(m.outcome);
      if (outcomeRight) {
        if (gutVsVerdict) stats.rightOnAgreement++;
        else stats.rightOnDisagreement++;
      }
    }
  }
  return stats;
}

// Quick & dirty agreement heuristic — exact match would never fire because
// gut is one line and verdict is two. We tokenize and check whether the
// gut's significant words show up in the verdict. False positives are OK
// (this is for self-tracking, not science).
function looselyAgrees(gut: string, verdict: string): boolean {
  const g = gut.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3);
  if (g.length === 0) return false;
  const v = verdict.toLowerCase();
  const hits = g.filter((w) => v.includes(w)).length;
  return hits / g.length >= 0.5;
}

// Write the per-domain scoreboard. Safe to call after every outcome record;
// the file is regenerable from the log entries.
export function writeCalibrationReport(domainPath: string): void {
  const stats = computeCalibration(domainPath);
  const file = join(domainPath, "_calibration.md");
  if (!existsSync(domainPath)) return;
  const pctAgree = stats.total > 0 ? Math.round((stats.agreed / stats.total) * 100) : 0;
  const agreedOutcomes = stats.agreed;
  const pctRightOnAgreement = agreedOutcomes > 0 ? Math.round((stats.rightOnAgreement / agreedOutcomes) * 100) : 0;
  const disagreed = stats.total - stats.agreed;
  const pctRightOnDisagreement = disagreed > 0 ? Math.round((stats.rightOnDisagreement / disagreed) * 100) : 0;
  const body = [
    `# Calibration · ${domainPath.split("/").pop()}`,
    "",
    `_auto-generated from \`_log/*.md\`. Edit the log to change these numbers; this file is regenerable._`,
    "",
    `## Score`,
    "",
    `| metric | value |`,
    `| --- | --- |`,
    `| decisions with outcome | ${stats.total} |`,
    `| gut agreed with verdict | ${stats.agreed} (${pctAgree}%) |`,
    `| right when gut agreed with council | ${stats.rightOnAgreement} / ${agreedOutcomes} (${pctRightOnAgreement}%) |`,
    `| right when gut disagreed with council | ${stats.rightOnDisagreement} / ${disagreed} (${pctRightOnDisagreement}%) |`,
    `| retrospectives still pending | ${stats.pending} |`,
    "",
    `## What this means`,
    "",
    pctAgree >= 70
      ? `You and the council usually agree (${pctAgree}%). Disagreements are the interesting cases — track them.`
      : `You and the council disagree often (${100 - pctAgree}% of decisions). Watch the right-on-disagreement number — if it climbs, your gut is well-calibrated for this domain. If it drops, defer to council.`,
    "",
    `## Pending`,
    "",
    stats.pending === 0
      ? `No retrospectives owed.`
      : `${stats.pending} decision${stats.pending === 1 ? "" : "s"} past their 90-day mark. Run \`/calibration pending\` to record outcomes.`,
  ].join("\n");
  if (!existsSync(domainPath)) mkdirSync(domainPath, { recursive: true });
  vwriteFile(file, body);
}
