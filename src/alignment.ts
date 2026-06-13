// Ideal-state alignment scoring.
//
// Answers "how close is life to the defined ideal state, and what's pulling
// toward or away" by scoring each life PILLAR against ideal-state.md.
//
// Two methods, tagged on the report so callers never mistake one for the other:
//   - "model"  : an LLM reads ideal-state.md + each domain's state and returns
//                a 0-100 fit score + rationale per pillar (the real judgment).
//   - "signal" : a deterministic fallback from context-score + open-loop
//                pressure when no model is available or the LLM output won't
//                parse. This is a READINESS proxy, NOT semantic ideal-state fit.
//
// Output is written to <vault>/_meta/alignment.json (+ a history line) so the
// home indicator and the weekly brief can read the latest delta.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { scanVault } from "./vault.ts";
import { computeContextScore } from "./score.ts";
import { vreadFile, vappendLine } from "./vault-session.ts";

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
  overall: number;
  pillars: PillarScore[];
  actions: string[];
}

// Which domains roll up into each life pillar. Unmapped domains with state
// land in "other" so nothing is silently dropped.
const PILLAR_MAP: Record<string, string[]> = {
  wealth: ["wealth", "tax", "insurance", "benefits", "estate", "real-estate"],
  revenue: ["business", "career", "content", "brand"],
  health: ["health"],
  living: ["homestead", "calendar", "learning", "explore"],
  relationships: ["social"],
};

function readIdealState(vaultPath: string): string | null {
  for (const p of [join(vaultPath, "ideal-state.md"), join(homedir(), ".prevail", "ideal-state.md")]) {
    if (!existsSync(p)) continue;
    try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { /* skip */ } }
  }
  return null;
}

function pillarOf(domain: string): string {
  for (const [pillar, doms] of Object.entries(PILLAR_MAP)) if (doms.includes(domain)) return pillar;
  return "other";
}

/** Build the LLM prompt: ideal state + a compact per-domain state digest. */
export function buildAlignmentPrompt(idealState: string, domainDigests: { domain: string; digest: string }[]): string {
  const blocks = domainDigests.map((d) => `### ${d.domain}\n${d.digest.slice(0, 1200)}`).join("\n\n");
  return [
    "You score how closely the user's life matches their stated IDEAL STATE.",
    "",
    "## IDEAL STATE (their constitution)",
    idealState.slice(0, 4000),
    "",
    "## CURRENT STATE BY DOMAIN",
    blocks || "(no domain state yet)",
    "",
    "Return ONLY JSON of this shape (no prose):",
    `{"pillars":[{"pillar":"wealth","score":0-100,"trend":"up|down|flat","rationale":"<=160 chars"}],"actions":["<=120 chars", "..."]}`,
    "Pillars: wealth, revenue, health, living, relationships. score = how close to ideal (100 = fully aligned). actions = the top 1-3 corrective moves.",
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
  const domains = scanVault(vaultPath);
  const byPillar: Record<string, { domains: string[]; scores: number[]; openLoops: number }> = {};
  for (const d of domains) {
    const pillar = pillarOf(d.name);
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
    return { pillar, score, trend: "flat", rationale: `context ${base}/100, ${b.openLoops} open loop(s)`, domains: b.domains };
  });
  const overall = pillars.length ? Math.round(pillars.reduce((a, p) => a + p.score, 0) / pillars.length) : 0;
  const actions = pillars.filter((p) => p.score < 60).sort((a, b) => a.score - b.score).slice(0, 3)
    .map((p) => `Strengthen ${p.pillar}: ${p.rationale}`);
  return { ts: 0, method: "signal", overall, pillars, actions };
}

function writeReport(vaultPath: string, report: AlignmentReport): void {
  const dir = join(vaultPath, "_meta");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "alignment.json"), JSON.stringify(report, null, 2));
    vappendLine(join(dir, "alignment-history.jsonl"), JSON.stringify({ ts: report.ts, overall: report.overall, method: report.method }) + "\n");
  } catch { /* best-effort */ }
}

export function readAlignment(vaultPath: string): AlignmentReport | null {
  const p = join(vaultPath, "_meta", "alignment.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(vreadFile(p)); } catch { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
}

/** Compute alignment. Uses the model when `opts.run` is provided and an ideal
 *  state exists; otherwise falls back to the deterministic signal. `nowTs` is
 *  injected so the function stays pure/testable (no Date.now in the core). */
export async function computeAlignment(
  vaultPath: string,
  nowTs: number,
  opts?: { run?: (prompt: string) => Promise<string> },
): Promise<AlignmentReport> {
  const ideal = readIdealState(vaultPath);
  let report: AlignmentReport;
  if (opts?.run && ideal) {
    const domains = scanVault(vaultPath);
    const digests = domains.map((d) => ({ domain: d.name, digest: (() => { try { return vreadFile(join(d.path, "_state.md")); } catch { return ""; } })() }));
    try {
      const raw = await opts.run(buildAlignmentPrompt(ideal, digests));
      const parsed = parseAlignmentJson(raw);
      if (parsed && parsed.pillars.length) {
        const dmap: Record<string, string[]> = {};
        for (const d of domains) (dmap[pillarOf(d.name)] ??= []).push(d.name);
        report = {
          ts: nowTs, method: "model",
          overall: Math.round(parsed.pillars.reduce((a, p) => a + p.score, 0) / parsed.pillars.length),
          pillars: parsed.pillars.map((p) => ({ ...p, domains: dmap[p.pillar] ?? [] })),
          actions: parsed.actions,
        };
      } else {
        report = { ...signalAlignment(vaultPath), ts: nowTs };
      }
    } catch {
      report = { ...signalAlignment(vaultPath), ts: nowTs };
    }
  } else {
    report = { ...signalAlignment(vaultPath), ts: nowTs };
  }
  writeReport(vaultPath, report);
  return report;
}
