// Ideal-state alignment scoring.
//
// Answers "how close is life to the defined ideal state, and what's pulling
// toward or away" by scoring each real DOMAIN (one with a manifest or an
// ideal) against the constitution, the domain's own ideal and its goals.
//
// Two methods, tagged on the report so callers never mistake one for the other:
//   - "model"  : the default. An LLM reads ideal-state.md and, per domain, its
//                goals, ideal and state, and returns a 0-100 fit score and a
//                rationale per domain (the real judgment). At most one model
//                call a day: a report is reused while it is under a day old,
//                or while nothing it read has changed (CACHE_* below).
//   - "signal" : a deterministic fallback from context-score + open-loop
//                pressure when no model is available or the LLM output won't
//                parse. This is a READINESS proxy, NOT semantic ideal-state fit.
//
// Output is written to <vault>/_meta/alignment.json (+ a history line) so the
// home indicator and the weekly brief can read the latest delta.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDomainGoalsText } from "./goals.ts";
import { scanVault } from "./vault.ts";
import { computeContextScore } from "./score.ts";
import { vreadFile, vappendLine } from "./vault-session.ts";
import { buildRoot, runtimePath } from "./path-safety.ts";

export interface PillarScore {
  pillar: string;
  score: number; // 0-100, higher = closer to ideal
  trend: "up" | "down" | "flat";
  rationale: string;
  domains: string[];
}
export interface AlignmentReport {
  ts: number;
  method: "model" | "signal";
  // Hash of everything the model read; a report whose inputs are unchanged is reused.
  inputs?: string;
  // When a model run was last tried and failed (the signal stood in). The
  // model is not tried again within CACHE_MIN_MS of a failure either.
  modelTriedAt?: number;
  overall: number;
  pillars: PillarScore[];
  actions: string[];
}

// A report is reused instead of calling the model again while it is younger
// than CACHE_MIN_MS, or younger than CACHE_MAX_MS when nothing it read
// (constitution, goals, ideals, states) has changed. A cost ceiling, in code.
export const CACHE_MIN_MS = 24 * 3600_000;
export const CACHE_MAX_MS = 7 * 24 * 3600_000;
// Each domain's slice of the prompt.
const GOALS_CHARS = 600;
const IDEAL_CHARS = 500;
const STATE_CHARS = 700;
const MAX_DOMAINS = 30;

function readIdealState(vaultPath: string): string | null {
  for (const p of [join(buildRoot(vaultPath), "ideal-state.md"), join(vaultPath, "ideal-state.md"), join(homedir(), ".prevail", "ideal-state.md")]) {
    if (!existsSync(p)) continue;
    try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { /* skip */ } }
  }
  return null;
}

/** The life domains a report scores: real domain folders, not internal ones. */
export function lifeDomains(vaultPath: string): { name: string; path: string; openLoopCount: number }[] {
  return scanVault(vaultPath).filter((d) =>
    !d.name.startsWith("_") && !d.name.startsWith(".") &&
    (existsSync(join(d.path, "manifest.json")) || existsSync(join(d.path, "ideal-state.md"))));
}

function readHead(p: string, max: number): string {
  if (!existsSync(p)) return "";
  try { return vreadFile(p).trim().slice(0, max); } catch { try { return readFileSync(p, "utf8").trim().slice(0, max); } catch { return ""; } }
}

/** What the model reads for one domain: its active goals, its ideal and its state. */
export function domainDigest(dir: string): string {
  const goals = readDomainGoalsText(dir)
    .split("\n").filter((l) => /^\s*[-*]\s+\[ \]/.test(l) && !/~status:(archived|done|released)/.test(l))
    .map((l) => l.replace(/\s~[a-z_]+:\S+/g, "").trim()).join("\n").slice(0, GOALS_CHARS);
  const ideal = readHead(join(dir, "ideal-state.md"), IDEAL_CHARS);
  const state = readHead(join(dir, "memory", "state.md"), STATE_CHARS) || readHead(join(dir, "_state.md"), STATE_CHARS);
  return [goals && `Goals:\n${goals}`, ideal && `Ideal:\n${ideal}`, state && `State:\n${state}`].filter(Boolean).join("\n");
}

/** Build the LLM prompt: ideal state + a compact per-domain digest. */
export function buildAlignmentPrompt(idealState: string, domainDigests: { domain: string; digest: string }[]): string {
  const blocks = domainDigests.map((d) => `### ${d.domain}\n${d.digest.slice(0, GOALS_CHARS + IDEAL_CHARS + STATE_CHARS + 40)}`).join("\n\n");
  const names = domainDigests.map((d) => d.domain).join(", ");
  return [
    "You score how closely the user's life matches their stated IDEAL STATE and their goals.",
    "You are an advisor, not a cheerleader: a domain whose goals show no movement scores low and says so.",
    "",
    "## IDEAL STATE (their constitution)",
    idealState.slice(0, 4000),
    "",
    "## EACH DOMAIN: its goals, its own ideal and its current state",
    blocks || "(no domain state yet)",
    "",
    "Return ONLY JSON of this shape (no prose):",
    `{"pillars":[{"pillar":"<domain>","score":0-100,"trend":"up|down|flat","rationale":"<=160 chars"}],"actions":["<=120 chars", "..."]}`,
    `One entry per domain, named exactly: ${names}. score = how close that domain is to the ideal and its goals (100 = fully aligned). actions = the top 1-3 corrective moves.`,
  ].join("\n");
}

/** Extract the first balanced JSON object from a model response. */
export function parseAlignmentJson(raw: string): { pillars: Omit<PillarScore, "domains">[]; actions: string[] } | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          const o = JSON.parse(raw.slice(start, i + 1));
          if (!Array.isArray(o.pillars)) return null;
          const pillars = o.pillars
            .filter((p: unknown): p is { pillar: string; score: number } => !!p && typeof (p as { pillar?: unknown }).pillar === "string")
            .map((p: { pillar: string; score?: number; trend?: string; rationale?: string }) => ({
              pillar: p.pillar,
              score: Math.max(0, Math.min(100, Math.round(Number(p.score) || 0))),
              trend: (p.trend === "up" || p.trend === "down" ? p.trend : "flat") as PillarScore["trend"],
              rationale: typeof p.rationale === "string" ? p.rationale.slice(0, 160) : "",
            }));
          const actions = Array.isArray(o.actions) ? o.actions.filter((a: unknown) => typeof a === "string").slice(0, 3) : [];
          return { pillars, actions };
        } catch { return null; }
      }
    }
  }
  return null;
}

/** Deterministic readiness proxy from context completeness + open loops. */
export function signalAlignment(vaultPath: string): AlignmentReport {
  const domains = lifeDomains(vaultPath);
  const byPillar: Record<string, { domains: string[]; scores: number[]; openLoops: number }> = {};
  for (const d of domains) {
    const pillar = d.name;
    const bucket = (byPillar[pillar] ??= { domains: [], scores: [], openLoops: 0 });
    bucket.domains.push(d.name);
    bucket.openLoops += d.openLoopCount;
    try {
      const cs = computeContextScore(vaultPath, d.name) as { score?: number };
      if (typeof cs.score === "number") bucket.scores.push(cs.score);
    } catch { /* skip */ }
  }
  const pillars: PillarScore[] = Object.entries(byPillar).map(([pillar, b]) => {
    const base = b.scores.length ? Math.round(b.scores.reduce((a, x) => a + x, 0) / b.scores.length) : 0;
    // Open loops pull the readiness signal down a little (capped).
    const score = Math.max(0, Math.min(100, base - Math.min(20, b.openLoops * 2)));
    return { pillar, score, trend: "flat", rationale: `context ${base}/100, ${b.openLoops} open ${b.openLoops === 1 ? "loop" : "loops"}`, domains: b.domains };
  });
  const overall = pillars.length ? Math.round(pillars.reduce((a, p) => a + p.score, 0) / pillars.length) : 0;
  const actions = pillars.filter((p) => p.score < 60).sort((a, b) => a.score - b.score).slice(0, 3)
    .map((p) => `Strengthen ${p.pillar}: ${p.rationale}`);
  return { ts: 0, method: "signal", overall, pillars, actions };
}

function writeReport(vaultPath: string, report: AlignmentReport): void {
  const dir = runtimePath(vaultPath, "_meta");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "alignment.json"), JSON.stringify(report, null, 2));
    vappendLine(join(dir, "alignment-history.jsonl"), JSON.stringify({ ts: report.ts, overall: report.overall, method: report.method }) + "\n");
  } catch { /* best-effort */ }
}

export function readAlignment(vaultPath: string): AlignmentReport | null {
  const p = join(runtimePath(vaultPath, "_meta"), "alignment.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(vreadFile(p)); } catch { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
}

/** Compute alignment. Uses the model when `opts.run` is provided and an ideal
 *  state exists; otherwise falls back to the deterministic signal. A recent
 *  model report is reused (see CACHE_*) unless `force`. `nowTs` is injected so
 *  the function stays pure/testable (no Date.now in the core). */
export async function computeAlignment(
  vaultPath: string,
  nowTs: number,
  opts?: { run?: (prompt: string) => Promise<string>; force?: boolean },
): Promise<AlignmentReport> {
  const ideal = readIdealState(vaultPath);
  let report: AlignmentReport;
  if (opts?.run && ideal) {
    const domains = lifeDomains(vaultPath).slice(0, MAX_DOMAINS);
    const digests = domains.map((d) => ({ domain: d.name, digest: domainDigest(d.path) }));
    const inputs = createHash("sha1").update(JSON.stringify([ideal, digests])).digest("hex").slice(0, 16);
    const last = readAlignment(vaultPath);
    if (!opts.force && last?.method === "model" && typeof last.ts === "number") {
      const age = nowTs - last.ts;
      if (age >= 0 && (age < CACHE_MIN_MS || (age < CACHE_MAX_MS && last.inputs === inputs))) return last;
    }
    if (!opts.force && last?.modelTriedAt && nowTs - last.modelTriedAt >= 0 && nowTs - last.modelTriedAt < CACHE_MIN_MS) {
      report = { ...signalAlignment(vaultPath), ts: nowTs, modelTriedAt: last.modelTriedAt };
      writeReport(vaultPath, report);
      return report;
    }
    try {
      const raw = await opts.run(buildAlignmentPrompt(ideal, digests));
      const parsed = parseAlignmentJson(raw);
      const known = new Set(domains.map((d) => d.name));
      const rows = parsed?.pillars.filter((p) => known.has(p.pillar)) ?? [];
      if (rows.length) {
        report = {
          ts: nowTs, method: "model", inputs,
          overall: Math.round(rows.reduce((a, p) => a + p.score, 0) / rows.length),
          pillars: rows.map((p) => ({ ...p, domains: [p.pillar] })),
          actions: parsed!.actions,
        };
      } else {
        report = { ...signalAlignment(vaultPath), ts: nowTs, modelTriedAt: nowTs };
      }
    } catch {
      report = { ...signalAlignment(vaultPath), ts: nowTs, modelTriedAt: nowTs };
    }
  } else {
    report = { ...signalAlignment(vaultPath), ts: nowTs };
  }
  writeReport(vaultPath, report);
  return report;
}
