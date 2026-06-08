// score — the context-readiness scoring engine for `prevail score`.
//
// Produces a ContextScore (docs/schemas/ContextScore.json) for a domain from a
// FROZEN, deterministic 6-dimension rubric, optionally augmented by a one-shot
// LLM coverage audit. Two halves:
//
//   1. computeContextScore(vaultPath, domain) — pure heuristic, no network.
//      Reads the domain's files, scores each dimension 0-100, weights them into
//      the headline 0-100 score, and builds a deterministic missing[] list.
//
//   2. auditContextScore(vaultPath, domain, score) — optional LLM pass. Calls
//      cli-bridge runChatTurn ONCE with a checklist source, tolerant-parses
//      ONLY-JSON {assessment, missing:[{label,severity}]}, and merges the
//      result into the ContextScore (assessment + audit_source + audited_at,
//      plus audit-kind missing items). Honors --local-only (ollama).
//
// Persistence (writeManifest from manifest.ts + an append-only score.jsonl):
//   - context_score is written into the domain manifest.
//   - {ts, score} is appended to <vault>/<domain>/_log/score.jsonl (history).
//
// Roll-up:
//   - aggregateLifeReadiness(vaultPath) → { lifeReadiness, domains } — the mean
//     of the deterministic per-domain scores.
//
// FROZEN CONTRACT: the six dimensions and their order match
// docs/schemas/ContextScore.json#ScoreBreakdown exactly — never add, remove, or
// rename one without a schema-version bump. The weights below are the rubric.

import {
  existsSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  readManifest,
  writeManifest,
  ensureManifest,
  assertWritable,
  type ContextScore,
  type ScoreDimension,
  type ScoreBreakdown,
  type MissingItem,
  type DomainManifest,
} from "./manifest.ts";
import { scanVault, resolveStatePath, stripFrontmatter } from "./vault.ts";
import { evaluateRelevance } from "./rubrics.ts";
import {
  detectClis,
  defaultModelFor,
  runChatTurn,
  type AvailableCli,
} from "./cli-bridge.ts";

// =============================================================================
// Rubric constants — the dimension weights (sum = 100) and time thresholds.
// These ARE the scoring contract; changing a weight changes every score, so
// keep them here, named, and documented.
// =============================================================================

const WEIGHTS = {
  coverage: 25,
  density: 20,
  freshness: 20,
  structure: 15,
  activity: 10,
  config_completeness: 10,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// density saturates at this many words across state+decisions+config.
const DENSITY_TARGET_WORDS = 800;

// Headline blend when a domain rubric matches: 65% structural readiness, 35%
// domain relevance. Domains with no rubric keep the pure structural score.
const STRUCTURAL_BLEND = 0.65;
const RELEVANCE_BLEND = 0.35;

// =============================================================================
// Small file helpers — all swallow errors and degrade to "absent/empty" so a
// single unreadable file can never throw out of the scorer.
// =============================================================================

function domainPath(vaultPath: string, domain: string): string {
  return join(vaultPath, domain);
}

function exists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function readText(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function mtimeMs(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function countWords(s: string): number {
  const t = s.trim();
  if (!t) return 0;
  return t.split(/\s+/).filter((w) => w.length > 0).length;
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// List files in a directory (one level), returning [] on any error. Used for
// _log and _threads enumeration.
function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// =============================================================================
// Snapshot — one cheap pass over the domain's filesystem so every dimension
// reads from the same in-memory view (no double-stat'ing). Resolves the
// _journal single-file-or-directory ambiguity (VAULT-SPEC §2: never both).
// =============================================================================

interface DomainSnapshot {
  dir: string;
  // canonical knowledge files
  hasState: boolean;
  hasConfig: boolean;
  hasDecisions: boolean;
  // journal: single file OR directory
  hasJournal: boolean;
  // logs
  logFiles: string[]; // _log/*.md
  hasAnyLog: boolean;
  // threads
  threadFiles: string[]; // _threads/*
  // artifact-kind directories
  hasSkills: boolean;
  hasThreads: boolean;
  hasPrior: boolean; // 01_prior
  hasCurrent: boolean; // 00_current
  hasBriefs: boolean; // 02_briefs
  // raw content (for density / structure / config-completeness)
  stateText: string;
  configText: string;
  decisionsText: string;
  // freshness inputs (ms, or null)
  stateMtime: number | null;
  decisionsMtime: number | null;
  newestLogMtime: number | null;
  newestJournalMtime: number | null;
}

function buildSnapshot(vaultPath: string, domain: string): DomainSnapshot {
  const dir = domainPath(vaultPath, domain);

  // v2-aware paths (fall back to v1): _state.md || state.md;
  // _decisions.jsonl || decisions.md. config.md stays at root in both.
  const statePath = resolveStatePath(dir) ?? join(dir, "state.md");
  const configPath = join(dir, "config.md");
  const decisionsV2 = join(dir, "_decisions.jsonl");
  const decisionsPath = exists(decisionsV2) ? decisionsV2 : join(dir, "decisions.md");

  const journalFile = join(dir, "_journal.md");
  const journalDir = join(dir, "_journal");
  const hasJournalFile = exists(journalFile);
  const hasJournalDir = exists(journalDir);
  const hasJournal = hasJournalFile || hasJournalDir;

  const logDir = join(dir, "_log");
  const logFiles = listFiles(logDir).filter((f) => f.endsWith(".md"));
  const hasAnyLog = logFiles.length >= 1;

  const threadDir = join(dir, "_threads");
  const threadFiles = listFiles(threadDir).filter(
    (f) => f.endsWith(".md") || f.endsWith(".jsonl"),
  );

  // newest log mtime
  let newestLogMtime: number | null = null;
  for (const f of logFiles) {
    const m = mtimeMs(join(logDir, f));
    if (m !== null && (newestLogMtime === null || m > newestLogMtime)) newestLogMtime = m;
  }

  // newest journal mtime (file, or any file inside the journal dir)
  let newestJournalMtime: number | null = null;
  if (hasJournalFile) {
    newestJournalMtime = mtimeMs(journalFile);
  }
  if (hasJournalDir) {
    for (const f of listFiles(journalDir)) {
      const m = mtimeMs(join(journalDir, f));
      if (m !== null && (newestJournalMtime === null || m > newestJournalMtime)) {
        newestJournalMtime = m;
      }
    }
  }

  return {
    dir,
    hasState: exists(statePath),
    hasConfig: exists(configPath),
    hasDecisions: exists(decisionsPath),
    hasJournal,
    logFiles,
    hasAnyLog,
    threadFiles,
    // v2: _skills/; v1: skills/.
    hasSkills: listDirs(join(dir, "_skills")).length > 0 || listDirs(join(dir, "skills")).length > 0,
    hasThreads: threadFiles.length > 0,
    // v2 moved the recency tiers under data/ and briefs into _artifacts/.
    hasPrior: exists(join(dir, "data", "01_prior")) || exists(join(dir, "01_prior")),
    hasCurrent: exists(join(dir, "data", "00_current")) || exists(join(dir, "00_current")),
    hasBriefs:
      exists(join(dir, "02_briefs")) ||
      listFiles(join(dir, "_artifacts")).some((f) => f !== ".gitkeep"),
    stateText: stripFrontmatter(readText(statePath)),
    configText: readText(configPath),
    decisionsText: readText(decisionsPath),
    stateMtime: mtimeMs(statePath),
    decisionsMtime: mtimeMs(decisionsPath),
    newestLogMtime,
    newestJournalMtime,
  };
}

// =============================================================================
// Dimension scorers — each returns a ScoreDimension (0-100 + human detail).
// =============================================================================

// coverage(25): five canonical slots × 20 each.
//   state.md, config.md, decisions.md, _journal(.md or /), >=1 _log/*.md
function scoreCoverage(s: DomainSnapshot): { dim: ScoreDimension; present: number; total: number } {
  const slots: Array<{ ok: boolean; name: string }> = [
    { ok: s.hasState, name: "state.md" },
    { ok: s.hasConfig, name: "config.md" },
    { ok: s.hasDecisions, name: "decisions.md" },
    { ok: s.hasJournal, name: "_journal" },
    { ok: s.hasAnyLog, name: "_log/*.md" },
  ];
  const present = slots.filter((x) => x.ok).length;
  const total = slots.length;
  const score = clamp((present / total) * 100);
  const missing = slots.filter((x) => !x.ok).map((x) => x.name);
  const detail =
    missing.length === 0
      ? `all ${total} canonical files present`
      : `${present} of ${total} canonical files present; missing ${missing.join(", ")}`;
  return { dim: { score, detail }, present, total };
}

// density(20): word count across state+decisions+config → min(100, 100*words/800)
function scoreDensity(s: DomainSnapshot): ScoreDimension {
  const words =
    countWords(s.stateText) + countWords(s.decisionsText) + countWords(s.configText);
  const score = clamp(Math.min(100, (100 * words) / DENSITY_TARGET_WORDS));
  const detail = `${words} words across state/decisions/config (target ${DENSITY_TARGET_WORDS} for full marks)`;
  return { score, detail };
}

// freshness(20): newest mtime among state/_log/_journal/decisions.
//   <=7d=100, <=30d=80, <=90d=50, <=180d=25, else 10. No files at all = 0.
function scoreFreshness(s: DomainSnapshot): { dim: ScoreDimension; freshnessSecs: number } {
  const candidates = [
    s.stateMtime,
    s.newestLogMtime,
    s.newestJournalMtime,
    s.decisionsMtime,
  ].filter((m): m is number => typeof m === "number");

  if (candidates.length === 0) {
    return {
      dim: { score: 0, detail: "no writable knowledge files to date" },
      freshnessSecs: 0,
    };
  }
  const newest = Math.max(...candidates);
  const ageMs = Math.max(0, Date.now() - newest);
  const freshnessSecs = Math.floor(ageMs / 1000);
  const ageDays = ageMs / DAY_MS;

  let score: number;
  if (ageDays <= 7) score = 100;
  else if (ageDays <= 30) score = 80;
  else if (ageDays <= 90) score = 50;
  else if (ageDays <= 180) score = 25;
  else score = 10;

  const detail = `newest knowledge file updated ${describeAge(ageMs)}`;
  return { dim: { score, detail }, freshnessSecs };
}

function describeAge(ageMs: number): string {
  const d = Math.floor(ageMs / DAY_MS);
  if (d < 1) return "today";
  if (d === 1) return "1 day ago";
  if (d < 30) return `${d} days ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = Math.floor(d / 365);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

// structure(15): distinct artifact kinds present / 10 * 100.
//   state, config, decisions, journal, logs, threads, skills, briefs, prior, current
function scoreStructure(s: DomainSnapshot): ScoreDimension {
  const kinds: Array<{ ok: boolean; name: string }> = [
    { ok: s.hasState, name: "state" },
    { ok: s.hasConfig, name: "config" },
    { ok: s.hasDecisions, name: "decisions" },
    { ok: s.hasJournal, name: "journal" },
    { ok: s.hasAnyLog, name: "logs" },
    { ok: s.hasThreads, name: "threads" },
    { ok: s.hasSkills, name: "skills" },
    { ok: s.hasBriefs, name: "briefs" },
    { ok: s.hasPrior, name: "prior" },
    { ok: s.hasCurrent, name: "current" },
  ];
  const present = kinds.filter((k) => k.ok).length;
  const total = kinds.length; // 10
  const score = clamp((present / total) * 100);
  const detail = `${present} of ${total} artifact kinds present (${kinds
    .filter((k) => k.ok)
    .map((k) => k.name)
    .join(", ") || "none"})`;
  return { score, detail };
}

// activity(10): # _log sessions (saturate at 10) blended with # _threads.
//   Reuse watcher-style signal: more recorded activity = higher readiness. We
//   blend the two saturating ratios 50/50 so a domain with logs OR threads
//   still scores, and one with both scores best.
function scoreActivity(s: DomainSnapshot): ScoreDimension {
  const logCount = s.logFiles.length;
  const threadCount = s.threadFiles.length;
  const logRatio = Math.min(1, logCount / 10);
  const threadRatio = Math.min(1, threadCount / 10);
  const score = clamp(100 * (0.5 * logRatio + 0.5 * threadRatio));
  const detail = `${logCount} log session${logCount === 1 ? "" : "s"}, ${threadCount} thread${threadCount === 1 ? "" : "s"} (saturate at 10 each)`;
  return { score, detail };
}

// config_completeness(10): filled key:value lines in config.md / total.
//   A line "key: value" counts as filled iff value is non-empty AND not a
//   placeholder ((none) / TODO / <...>). "key:" with nothing after = empty.
function scoreConfigCompleteness(s: DomainSnapshot): ScoreDimension {
  if (!s.hasConfig) {
    return { score: 0, detail: "no config.md" };
  }
  let total = 0;
  let filled = 0;
  for (const rawLine of s.configText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(">")) continue;
    // key: value — key is a bareword (no spaces) before the first colon.
    const m = line.match(/^([A-Za-z0-9_][A-Za-z0-9_ -]*?)\s*:\s*(.*)$/);
    if (!m) continue;
    total++;
    if (isFilledConfigValue(m[2])) filled++;
  }
  if (total === 0) {
    return { score: 0, detail: "config.md has no key:value fields" };
  }
  const score = clamp((filled / total) * 100);
  const detail = `${filled} of ${total} config.md fields filled in`;
  return { score, detail };
}

function isFilledConfigValue(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  const low = v.toLowerCase();
  if (low === "(none)" || low === "none" || low === "todo" || low === "tbd") return false;
  // Pure placeholder angle-bracket token like <your name> or <...>.
  if (/^<[^>]*>$/.test(v)) return false;
  return true;
}

// =============================================================================
// Deterministic missing[] builder. Severity reflects how much a gap hurts.
// kinds match docs/schemas/MissingItem.json#kind enum.
// =============================================================================

function buildMissing(s: DomainSnapshot, breakdown: ScoreBreakdown): MissingItem[] {
  const out: MissingItem[] = [];

  // Canonical files (coverage). Phrased as plain, actionable coaching — what to
  // DO, not the file mechanics. Severity/kind drive the UI and are unchanged.
  if (!s.hasState) {
    out.push({ label: "This folder isn't an active domain yet — add a state.md to turn it on", severity: "critical", kind: "file" });
  }
  if (!s.hasConfig) {
    out.push({ label: "Capture the key facts for this area — accounts, targets, contacts, dates", severity: "warn", kind: "file" });
  }
  if (!s.hasDecisions) {
    out.push({ label: "No decisions recorded yet — log the choices you make so they stick and shape future advice", severity: "warn", kind: "file" });
  }
  if (!s.hasJournal) {
    out.push({ label: "No journal yet — it builds itself as you chat (turn on Memory & Context)", severity: "info", kind: "file" });
  }
  if (!s.hasAnyLog) {
    out.push({ label: "No saved sessions yet — your conversations will build a history here", severity: "info", kind: "file" });
  }

  // density
  if (breakdown.density.score < 40) {
    out.push({ label: "Thin on real content — add your actual documents (statements, records, plans) so advice can be specific", severity: "warn", kind: "section" });
  }

  // freshness
  if (breakdown.freshness.score <= 25) {
    out.push({ label: `Out of date — ${breakdown.freshness.detail}; add or refresh something recent`, severity: "warn", kind: "freshness" });
  }

  // structure
  if (!s.hasSkills) {
    out.push({ label: "No reusable skills yet — Prevail will suggest some as patterns emerge", severity: "info", kind: "skill" });
  }
  if (!s.hasThreads) {
    out.push({ label: "No conversations yet — start a chat to build real context", severity: "info", kind: "structure" });
  }

  // config completeness
  if (s.hasConfig && breakdown.config_completeness.score < 50) {
    out.push({ label: `Key details still missing — ${breakdown.config_completeness.detail}; fill in the important fields`, severity: "info", kind: "config" });
  }

  return out;
}

// =============================================================================
// computeContextScore — the deterministic, network-free score.
// =============================================================================

export function computeContextScore(vaultPath: string, domain: string): ContextScore {
  const root = resolve(vaultPath);
  const s = buildSnapshot(root, domain);

  const coverage = scoreCoverage(s);
  const density = scoreDensity(s);
  const freshness = scoreFreshness(s);
  const structure = scoreStructure(s);
  const activity = scoreActivity(s);
  const config_completeness = scoreConfigCompleteness(s);

  const breakdown: ScoreBreakdown = {
    coverage: coverage.dim,
    density,
    freshness: freshness.dim,
    structure,
    activity,
    config_completeness,
  };

  // Weighted roll-up: sum(dim.score * weight) / 100, rounded. This is the
  // STRUCTURAL score — domain-agnostic readiness.
  const weighted =
    breakdown.coverage.score * WEIGHTS.coverage +
    breakdown.density.score * WEIGHTS.density +
    breakdown.freshness.score * WEIGHTS.freshness +
    breakdown.structure.score * WEIGHTS.structure +
    breakdown.activity.score * WEIGHTS.activity +
    breakdown.config_completeness.score * WEIGHTS.config_completeness;
  const structural = clamp(weighted / 100);

  // Domain intelligence: blend in how much of THIS domain's relevant context
  // (a recent tax return, a health insurance card, …) is present and fresh.
  // Only applies when a rubric matches — custom/unknown domains (and the
  // golden-test fixtures) keep the pure structural score.
  const textMtime = [s.stateMtime, s.newestLogMtime, s.newestJournalMtime, s.decisionsMtime]
    .filter((m): m is number => typeof m === "number")
    .reduce((a, b) => Math.max(a, b), 0);
  const relevance = evaluateRelevance({
    domain,
    dir: s.dir,
    stateText: s.stateText,
    configText: s.configText,
    textMtime: textMtime > 0 ? textMtime : null,
  });
  const score = relevance
    ? clamp(STRUCTURAL_BLEND * structural + RELEVANCE_BLEND * relevance.score)
    : structural;

  const missing = buildMissing(s, breakdown);

  return {
    domain,
    score,
    breakdown,
    relevance,
    missing,
    freshness_secs: freshness.freshnessSecs,
    assessment: null,
    audit_source: null,
    computed_at: new Date().toISOString(),
    audited_at: null,
  };
}

// =============================================================================
// auditContextScore — optional one-shot LLM coverage audit.
//
// Checklist source resolution (best → fallback):
//   1. A skills/*/SKILL.md whose frontmatter has `type: assessment`.
//   2. A score.md at the domain root.
//   3. Nothing — the LLM infers a generic readiness checklist.
//
// Calls runChatTurn ONCE asking for ONLY JSON {assessment, missing:[{label,
// severity}]}, tolerant-parses, and merges into a NEW ContextScore (does not
// mutate the input). Honors --local-only by forcing the ollama engine.
// On any failure the original score is returned UNCHANGED (audit is additive).
// =============================================================================

export interface AuditOptions {
  localOnly?: boolean;
  // Override engine selection (tests). When absent, detectClis() is used.
  available?: AvailableCli[];
  // Injectable runner (tests) — defaults to cli-bridge runChatTurn.
  runner?: typeof runChatTurn;
}

function findAssessmentChecklist(dir: string): string | null {
  // 1. skills/*/SKILL.md with type: assessment
  const skillsRoot = join(dir, "skills");
  for (const name of listDirs(skillsRoot)) {
    const skillFile = join(skillsRoot, name, "SKILL.md");
    if (!exists(skillFile)) continue;
    const head = readText(skillFile).slice(0, 600);
    if (/^\s*type:\s*assessment\s*$/m.test(head)) {
      return readText(skillFile);
    }
  }
  // 2. score.md at domain root
  const scoreMd = join(dir, "score.md");
  if (exists(scoreMd)) return readText(scoreMd);
  // 3. none — LLM infers
  return null;
}

function buildAuditPrompt(domain: string, score: ContextScore, checklist: string | null): string {
  const checklistBlock = checklist
    ? `Use this domain-specific readiness checklist as your rubric:\n<checklist>\n${checklist.slice(0, 4000)}\n</checklist>`
    : `No domain-specific checklist was provided. Infer a sensible readiness checklist for a "${domain}" life/work domain (what a well-formed knowledge base for this area SHOULD contain).`;

  return [
    `You are auditing the context-readiness of the "${domain}" domain in a personal knowledge vault.`,
    `Read state.md, config.md, decisions.md and any other files in this directory for context.`,
    ``,
    `A deterministic scorer already rated it ${score.score}/100 with this breakdown:`,
    `- coverage ${score.breakdown.coverage.score}: ${score.breakdown.coverage.detail}`,
    `- density ${score.breakdown.density.score}: ${score.breakdown.density.detail}`,
    `- freshness ${score.breakdown.freshness.score}: ${score.breakdown.freshness.detail}`,
    `- structure ${score.breakdown.structure.score}: ${score.breakdown.structure.detail}`,
    `- activity ${score.breakdown.activity.score}: ${score.breakdown.activity.detail}`,
    `- config_completeness ${score.breakdown.config_completeness.score}: ${score.breakdown.config_completeness.detail}`,
    ``,
    checklistBlock,
    ``,
    `Write a short narrative assessment (2-4 sentences) of how ready this domain is and the single highest-leverage thing to improve.`,
    `Then list concrete gaps the deterministic scorer can't see (missing substance, not just missing files).`,
    ``,
    `Respond with ONLY a JSON object, no prose, no markdown fences:`,
    `{"assessment": "<2-4 sentence narrative>", "missing": [{"label": "<gap>", "severity": "info|warn|critical"}]}`,
  ].join("\n");
}

// Tolerant JSON extraction: strips ```json fences, then takes the first
// balanced {...} block. Returns null if nothing parseable is found.
function tolerantParseJson(raw: string): unknown {
  if (!raw) return null;
  let text = raw.trim();
  // strip code fences
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // direct parse first
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to brace-scan */
  }
  // find first balanced top-level object
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const AUDIT_SEVERITIES = new Set(["info", "warn", "critical"]);

function coerceAuditMissing(v: unknown): MissingItem[] {
  if (!Array.isArray(v)) return [];
  const out: MissingItem[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label.trim() : "";
    if (!label) continue;
    const sevRaw = typeof o.severity === "string" ? o.severity.trim().toLowerCase() : "info";
    const severity = AUDIT_SEVERITIES.has(sevRaw) ? sevRaw : "info";
    out.push({ label: label.slice(0, 200), severity, kind: "audit" });
  }
  return out;
}

export async function auditContextScore(
  vaultPath: string,
  domain: string,
  score: ContextScore,
  opts: AuditOptions = {},
): Promise<ContextScore> {
  const root = resolve(vaultPath);
  const dir = domainPath(root, domain);

  // Engine selection — under --local-only only ollama is permitted.
  const available = opts.available ?? (await detectClis());
  const pool = opts.localOnly ? available.filter((c) => c.kind === "ollama") : available;
  const cli = pool[0];
  if (!cli) {
    // No engine — audit is additive, so return the heuristic score unchanged.
    return score;
  }

  const checklist = findAssessmentChecklist(dir);
  const prompt = buildAuditPrompt(domain, score, checklist);
  const runner = opts.runner ?? runChatTurn;

  let reply = "";
  try {
    reply = await runner({
      prompt,
      cwd: dir,
      cli,
      model: "",
      isFirst: true,
      bare: true,
      maxOutputChars: 8000,
    });
  } catch {
    return score;
  }

  const parsed = tolerantParseJson(reply);
  if (!parsed || typeof parsed !== "object") return score;
  const o = parsed as Record<string, unknown>;
  const assessment = typeof o.assessment === "string" && o.assessment.trim().length > 0
    ? o.assessment.trim().slice(0, 4000)
    : null;
  const auditMissing = coerceAuditMissing(o.missing);

  // Merge: keep deterministic missing[] first, append audit-kind items.
  return {
    ...score,
    missing: [...score.missing, ...auditMissing],
    assessment,
    audit_source: `${cli.kind}:${defaultModelFor(cli.kind)}`,
    audited_at: Date.now(),
  };
}

// =============================================================================
// Persistence — write the score into the manifest AND append history.
// =============================================================================

const SCORE_LOG_REL = "_log/score.jsonl";

export interface ScoreHistoryPoint {
  ts: number;
  score: number;
}

// Append {ts, score} to <vault>/<domain>/_log/score.jsonl (creating _log/ if
// needed). Honors the immutable-zone contract via assertWritable.
export function appendScoreHistory(vaultPath: string, domain: string, score: ContextScore): void {
  const root = resolve(vaultPath);
  assertWritable(root, SCORE_LOG_REL);
  const logDir = join(root, domain, "_log");
  try {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const point: ScoreHistoryPoint = { ts: Date.now(), score: score.score };
    appendFileSync(join(root, domain, SCORE_LOG_REL), `${JSON.stringify(point)}\n`);
  } catch {
    /* history is best-effort — never fail a score on a log-write error */
  }
}

// Read the score history (oldest → newest) from _log/score.jsonl. Returns []
// when the file is absent or unreadable.
export function readScoreHistory(vaultPath: string, domain: string): ScoreHistoryPoint[] {
  const root = resolve(vaultPath);
  const file = join(root, domain, SCORE_LOG_REL);
  if (!exists(file)) return [];
  const out: ScoreHistoryPoint[] = [];
  for (const line of readText(file).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (typeof o.ts === "number" && typeof o.score === "number") {
        out.push({ ts: o.ts, score: o.score });
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

// Write the ContextScore into the domain manifest (context_score field) using
// the existing manifest API. ensureManifest creates a default manifest if the
// domain has none yet, so persistence always succeeds for a real domain.
export function persistScore(vaultPath: string, domain: string, score: ContextScore): DomainManifest {
  const root = resolve(vaultPath);
  const manifest = ensureManifest(root, domain);
  const updated: DomainManifest = { ...manifest, context_score: score };
  writeManifest(root, domain, updated);
  return updated;
}

// One-shot convenience: compute (+ optional audit), persist into the manifest,
// and append history. Returns the final ContextScore. This is what the command
// handlers call.
export async function scoreDomain(
  vaultPath: string,
  domain: string,
  opts: { audit?: boolean; localOnly?: boolean } = {},
): Promise<ContextScore> {
  const root = resolve(vaultPath);
  let score = computeContextScore(root, domain);
  if (opts.audit) {
    score = await auditContextScore(root, domain, score, { localOnly: opts.localOnly });
  }
  persistScore(root, domain, score);
  appendScoreHistory(root, domain, score);
  return score;
}

// =============================================================================
// aggregateLifeReadiness — mean of the deterministic per-domain scores.
//
// NOTE: uses the deterministic score only (no audit) so the roll-up is stable
// and cheap. Each domain is also persisted (manifest + history) as a side
// effect, matching `score --all` semantics in the JSON API.
// =============================================================================

export interface LifeReadiness {
  lifeReadiness: number;
  domains: ContextScore[];
}

export function aggregateLifeReadiness(vaultPath: string): LifeReadiness {
  const root = resolve(vaultPath);
  const domains = scanVault(root);
  const scores: ContextScore[] = [];
  for (const d of domains) {
    const sc = computeContextScore(root, d.name);
    try {
      persistScore(root, d.name, sc);
      appendScoreHistory(root, d.name, sc);
    } catch {
      /* persistence best-effort; the roll-up still reports the score */
    }
    scores.push(sc);
  }
  const lifeReadiness =
    scores.length === 0
      ? 0
      : clamp(scores.reduce((acc, s) => acc + s.score, 0) / scores.length);
  return { lifeReadiness, domains: scores };
}

// =============================================================================
// Command handlers — exported for the index command dispatcher to wire up.
// Each emits the frozen JSON API shape on stdout and the error envelope on
// failure. Mirrors the manifest/vault command pattern in src/index.tsx.
// =============================================================================

function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitScoreError(message: string, code: string): number {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message, code })}\n`);
  return 1;
}

export interface ScoreCommandOptions {
  vaultPath: string;
  audit?: boolean;
  localOnly?: boolean;
}

// `prevail score <domain> [--audit] --json`
export async function handleScoreDomain(
  domain: string,
  opts: ScoreCommandOptions,
): Promise<number> {
  const root = resolve(opts.vaultPath);
  if (!existsSync(root)) return emitScoreError(`vault path not found: ${root}`, "VAULT_NOT_FOUND");
  if (!domain) return emitScoreError("missing required argument: <domain>", "MISSING_ARG");
  const found = scanVault(root).some((d) => d.name === domain);
  if (!found) return emitScoreError(`unknown domain: ${domain}`, "UNKNOWN_DOMAIN");
  try {
    const score = await scoreDomain(root, domain, { audit: opts.audit, localOnly: opts.localOnly });
    emitJson(score);
    return 0;
  } catch (err) {
    return emitScoreError((err as Error).message, "SCORE_FAILED");
  }
}

// `prevail score --all --json`
export async function handleScoreAll(opts: ScoreCommandOptions): Promise<number> {
  const root = resolve(opts.vaultPath);
  if (!existsSync(root)) return emitScoreError(`vault path not found: ${root}`, "VAULT_NOT_FOUND");
  try {
    const result = aggregateLifeReadiness(root);
    // --audit on --all: layer audits onto each domain (best-effort, sequential
    // so we never fan out N concurrent LLM calls).
    if (opts.audit) {
      const audited: ContextScore[] = [];
      for (const sc of result.domains) {
        const a = await auditContextScore(root, sc.domain, sc, { localOnly: opts.localOnly });
        persistScore(root, sc.domain, a);
        audited.push(a);
      }
      result.domains = audited;
    }
    emitJson(result);
    return 0;
  } catch (err) {
    return emitScoreError((err as Error).message, "SCORE_ALL_FAILED");
  }
}

// `prevail score history <domain> --json`
export function handleScoreHistory(domain: string, opts: ScoreCommandOptions): number {
  const root = resolve(opts.vaultPath);
  if (!existsSync(root)) return emitScoreError(`vault path not found: ${root}`, "VAULT_NOT_FOUND");
  if (!domain) return emitScoreError("missing required argument: <domain>", "MISSING_ARG");
  try {
    emitJson(readScoreHistory(root, domain));
    return 0;
  } catch (err) {
    return emitScoreError((err as Error).message, "SCORE_HISTORY_FAILED");
  }
}

// Top-level argv dispatcher for the `score` command family. The index command
// router calls this with the post-`score` args and the resolved vault override.
//   score <domain> [--audit]
//   score --all [--audit]
//   score history <domain>
export async function scoreCommand(args: string[], vaultPath: string): Promise<number> {
  let audit = false;
  let localOnly = false;
  let all = false;
  let history = false;
  const positionals: string[] = [];

  for (const a of args) {
    if (a === "--audit") audit = true;
    else if (a === "--local-only") localOnly = true;
    else if (a === "--all") all = true;
    else if (a === "--json") continue; // implied by these handlers
    else if (a === "history") history = true;
    else if (!a.startsWith("-")) positionals.push(a);
  }

  const opts: ScoreCommandOptions = { vaultPath, audit, localOnly };

  if (all) return handleScoreAll(opts);
  if (history) return handleScoreHistory(positionals[0] ?? "", opts);
  return handleScoreDomain(positionals[0] ?? "", opts);
}
