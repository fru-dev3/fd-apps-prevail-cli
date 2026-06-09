// Decision log — the engine's twin of the desktop's `_decisions.jsonl` store
// (fd-apps-prevail-desktop: src-tauri/src/lib.rs decision_append/decisions_read/
// decision_feedback). A DECISION is a durable, provenance-tagged record: a
// council verdict, an accepted recommendation, or a user-stated preference.
// It is the spine of self-learning — `recall()` (memory.ts) and the distiller
// read it back as context on the next question.
//
// Storage: append-only JSONL at `<domain>/_decisions.jsonl` (vault root for the
// domainless "General" space). One JSON object per line. Newest is last on
// disk; readers return newest-first. The exact path + record shape match the
// desktop byte-for-byte so the CLI, the TUI, and the desktop app all read and
// write the SAME file interchangeably.

import { appendFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

import { vreadFile } from "./vault-session.ts";
import { join, resolve } from "node:path";

// A domain name is "safe" if it's a single path segment with no traversal.
// Anything else (empty, "general", "..", contains a slash) resolves to the
// vault root — the General space — mirroring the desktop's domain_dir().
function isSafeDomain(d: string): boolean {
  return d.length > 0 && d !== "general" && d !== "__general__" && !d.includes("/") && !d.includes("\\") && d !== ".." && d !== ".";
}

// Resolve the directory a domain's curated files live in. General → vault root.
export function domainDir(vaultPath: string, domain: string | null | undefined): string {
  const v = resolve(vaultPath);
  return domain && isSafeDomain(domain) ? join(v, domain) : v;
}

export function decisionsFile(vaultPath: string, domain: string | null | undefined): string {
  return join(domainDir(vaultPath, domain), "_decisions.jsonl");
}

export interface DecisionFeedback {
  rating: "up" | "down";
  note?: string | null;
}

// One decision record. Open-ended (extra keys are preserved on read/rewrite)
// but these are the fields the council writer + learning loop rely on.
export interface DecisionRecord {
  id: string;
  ts: number; // epoch ms
  type: string; // "council_verdict" | "recommendation" | "preference" | …
  domain?: string | null;
  prompt?: string;
  verdict?: string;
  chair?: string;
  panel?: { cli: string; model: string; lens: string | null; ok: boolean; ms: number }[];
  degraded?: boolean;
  source?: string; // "cli" | "desktop" | "tui"
  feedback?: DecisionFeedback;
  [key: string]: unknown;
}

// Mint a short, unique, sortable-ish decision id. Mirrors session.makeTurnId's
// style (timestamp36 + random) so ids are greppable and collision-resistant.
export function makeDecisionId(): string {
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Append a decision to the domain's log. Creates the directory + file on first
// use. Returns the (possibly id-filled) record actually written.
export function appendDecision(
  vaultPath: string,
  domain: string | null | undefined,
  record: Partial<DecisionRecord>,
): DecisionRecord {
  const dir = domainDir(vaultPath, domain);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const full: DecisionRecord = {
    id: record.id ?? makeDecisionId(),
    ts: record.ts ?? Date.now(),
    type: record.type ?? "decision",
    ...record,
  };
  appendFileSync(decisionsFile(vaultPath, domain), `${JSON.stringify(full)}\n`);
  return full;
}

// Read the decision log newest-first, optionally capped at `limit`.
export function readDecisions(
  vaultPath: string,
  domain: string | null | undefined,
  limit?: number,
): DecisionRecord[] {
  const file = decisionsFile(vaultPath, domain);
  if (!existsSync(file)) return [];
  let text = "";
  try {
    text = vreadFile(file);
  } catch {
    return [];
  }
  const out: DecisionRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as DecisionRecord);
    } catch {
      /* skip malformed line */
    }
  }
  out.reverse(); // newest first
  return typeof limit === "number" && limit >= 0 ? out.slice(0, limit) : out;
}

// Attach (or clear) a thumbs up/down + note on a recorded decision, keyed by id.
// Rewrites the JSONL in place. Returns true if a matching record was found.
export function setDecisionFeedback(
  vaultPath: string,
  domain: string | null | undefined,
  id: string,
  rating: "up" | "down" | "clear",
  note?: string | null,
): boolean {
  const file = decisionsFile(vaultPath, domain);
  if (!existsSync(file)) return false;
  const records: DecisionRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      records.push(JSON.parse(t) as DecisionRecord);
    } catch {
      /* skip */
    }
  }
  let found = false;
  for (const rec of records) {
    if (rec.id === id) {
      if (rating === "clear") delete rec.feedback;
      else rec.feedback = { rating, note: note ?? null };
      found = true;
      break;
    }
  }
  if (!found) return false;
  // Preserve on-disk order (oldest → newest).
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return true;
}
