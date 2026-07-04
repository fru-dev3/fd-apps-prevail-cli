// Learned/personalized router store (v1) — the local, privacy-preserving memory
// that lets the "Auto" router improve from the user's OWN accept/override history.
//
// When Auto picks a model and the user overrides it via the routing chip, the
// desktop records one line here: { ts, domain, band, fromModel, toModel }. On the
// next auto turn in the SAME bucket (domain + difficulty band), chooseModel reads
// this store and, if the user has settled on a model there, honors it (only among
// currently-available candidates). Nothing but difficulty band, domain, and model
// ids is stored — no prompt text, no PII.
//
// One append-only JSONL at <vault>/build/_meta/route-learning.jsonl (via the
// canonical runtime path helper, so it follows the migrated vault layout). Writes
// are encryption-aware (vappendLine) and best-effort: logging must never break a
// turn. Reads tolerate a missing file and skip malformed lines. Empty/missing
// store => the router behaves EXACTLY like today's heuristic+classifier pick.
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { runtimePath } from "./path-safety.ts";
import { vappendLine, vreadFile, vrotateLedgerPrefix } from "./vault-session.ts";

// Difficulty band = the coarse bucketing dimension (alongside domain). Matches
// the router's own "light / moderate / hard" language so the store, the reason
// string, and the heuristic all speak the same three bands.
export type DifficultyBand = "light" | "moderate" | "hard";

export function difficultyBand(difficulty: number): DifficultyBand {
  const d = Number.isFinite(difficulty) ? difficulty : 3;
  if (d <= 2) return "light";
  if (d === 3) return "moderate";
  return "hard";
}

// Normalize the bucket domain so "" / null / "general" all map to one key (the
// engine treats an empty domain as General, so the learning bucket must too).
function normDomain(d: string | null | undefined): string {
  const s = (d ?? "").trim();
  return s || "general";
}

// The bucket key a preference is learned against: domain + difficulty band.
export function bucketKey(domain: string | null | undefined, band: DifficultyBand): string {
  return `${normDomain(domain)}::${band}`;
}

export interface RouteOverride {
  ts: number;
  domain: string;
  band: DifficultyBand;
  fromModel: string; // what Auto picked
  toModel: string;   // what the user chose instead (or confirmed)
}

// Retention: keep the live ledger small (this is low-frequency, one line per
// override). Past the cap, roll the head into an archive and keep a recent tail.
const ROUTE_LEARN_MAX_BYTES = 200_000;
const ROUTE_LEARN_KEEP_TAIL_BYTES = 80_000;

export function routeLearningFile(vaultRoot: string): string {
  return join(runtimePath(vaultRoot, "_meta"), "route-learning.jsonl");
}

// Append one override record. Best-effort — swallows every error so a failed log
// can never break the chat turn that produced it.
export function recordRouteOverride(
  vaultRoot: string,
  rec: Omit<RouteOverride, "ts"> & { ts?: number },
): void {
  try {
    const to = (rec.toModel ?? "").trim();
    if (!to) return; // nothing to learn without a chosen model
    const band = normBand(rec.band);
    if (!band) return;
    const dir = runtimePath(vaultRoot, "_meta");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const full: RouteOverride = {
      ts: rec.ts ?? Date.now(),
      domain: normDomain(rec.domain),
      band,
      fromModel: (rec.fromModel ?? "").trim(),
      toModel: to,
    };
    const file = routeLearningFile(vaultRoot);
    vappendLine(file, JSON.stringify(full) + "\n");
    try {
      if (statSync(file).size > ROUTE_LEARN_MAX_BYTES) {
        vrotateLedgerPrefix(file, join(dir, "route-learning.archive.jsonl"), ROUTE_LEARN_MAX_BYTES, ROUTE_LEARN_KEEP_TAIL_BYTES);
      }
    } catch { /* rotation is best-effort */ }
  } catch {
    /* best effort — learning must never break the producer */
  }
}

// Read all override records, newest-or-oldest order preserved. Tolerates a
// missing file (=> []) and skips malformed / incomplete lines.
export function readRouteOverrides(vaultRoot: string): RouteOverride[] {
  try {
    const f = routeLearningFile(vaultRoot);
    if (!existsSync(f)) return [];
    const raw = vreadFile(f);
    const out: RouteOverride[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as Partial<RouteOverride>;
        const band = normBand(o?.band);
        const to = typeof o?.toModel === "string" ? o.toModel.trim() : "";
        if (!band || !to) continue; // incomplete record — skip
        out.push({
          ts: typeof o.ts === "number" ? o.ts : 0,
          domain: normDomain(o.domain),
          band,
          fromModel: typeof o.fromModel === "string" ? o.fromModel : "",
          toModel: to,
        });
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// PURE. The model the user has settled on for this bucket, or null. A model must
// reach `threshold` overrides in the (domain, band) bucket to win. Deterministic:
// highest count wins; ties broken by most-recent override, then by model id. No
// IO, so it is exhaustively testable and safe to call from the pure router.
export function learnedPreference(
  overrides: RouteOverride[],
  domain: string | null | undefined,
  band: DifficultyBand,
  threshold = 2,
): string | null {
  if (!overrides || overrides.length === 0) return null;
  const dom = normDomain(domain);
  const counts = new Map<string, { n: number; lastTs: number }>();
  for (const o of overrides) {
    if (!o || normBand(o.band) !== band || normDomain(o.domain) !== dom) continue;
    const m = (o.toModel ?? "").trim();
    if (!m) continue;
    const cur = counts.get(m) ?? { n: 0, lastTs: 0 };
    cur.n += 1;
    cur.lastTs = Math.max(cur.lastTs, typeof o.ts === "number" ? o.ts : 0);
    counts.set(m, cur);
  }
  const ranked = [...counts.entries()]
    .filter(([, v]) => v.n >= threshold)
    .sort((a, b) =>
      (b[1].n - a[1].n) ||
      (b[1].lastTs - a[1].lastTs) ||
      (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
  return ranked.length ? ranked[0]![0]! : null;
}

// Coerce an arbitrary string to a valid band, or null.
function normBand(b: string | null | undefined): DifficultyBand | null {
  const s = (b ?? "").trim().toLowerCase();
  return s === "light" || s === "moderate" || s === "hard" ? s : null;
}

// `prevail route-learn record --domain D --band B --from F --to T [--vault V]`.
// The single write path the desktop calls (via a Tauri command) to persist one
// override. Returns a process exit code. Kept tiny and dependency-light so the
// index dispatcher can lazy-import it.
export function routeLearnCommand(args: string[], vaultOverride: string | null): number {
  let sub = "";
  let domain = "";
  let band = "";
  let from = "";
  let to = "";
  let vaultPath = vaultOverride ?? "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = args[i + 1];
    if (i === 0 && !a.startsWith("-")) { sub = a; continue; }
    if (a === "--domain") { domain = next ?? ""; i++; }
    else if (a.startsWith("--domain=")) domain = a.slice("--domain=".length);
    else if (a === "--band") { band = next ?? ""; i++; }
    else if (a.startsWith("--band=")) band = a.slice("--band=".length);
    else if (a === "--from") { from = next ?? ""; i++; }
    else if (a.startsWith("--from=")) from = a.slice("--from=".length);
    else if (a === "--to") { to = next ?? ""; i++; }
    else if (a.startsWith("--to=")) to = a.slice("--to=".length);
    else if (a === "--vault") { vaultPath = resolve(process.cwd(), next ?? ""); i++; }
    else if (a.startsWith("--vault=")) vaultPath = resolve(process.cwd(), a.slice("--vault=".length));
  }
  if (sub !== "record") { console.error("route-learn: unknown subcommand (expected: record)"); return 1; }
  if (!vaultPath) { console.error("route-learn: no vault path"); return 1; }
  const b = normBand(band);
  if (!b) { console.error("route-learn: --band must be light|moderate|hard"); return 1; }
  if (!to.trim()) { console.error("route-learn: --to <model> is required"); return 1; }
  recordRouteOverride(vaultPath, { domain, band: b, fromModel: from, toModel: to });
  return 0;
}
