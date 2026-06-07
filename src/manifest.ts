import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { CliKind } from "./config.ts";
import { isCliKind } from "./config.ts";
import { isSafeEntryName, resolveSafeChild, validateVaultPath } from "./path-safety.ts";

// =============================================================================
// DomainManifest — the optional per-domain machine-config file (manifest.json).
//
// FROZEN CONTRACT: this interface mirrors docs/schemas/DomainManifest.json
// field-for-field. The writer emits ONLY these fields (the schema is
// additionalProperties:false). Absence of manifest.json means "manifest
// features off" — the domain still works on state.md alone.
//
// Schema versioning follows the same convention as src/config.ts
// migrateLegacyCliKind: readers migrate forward, persist-on-write, bump
// `schema` only on breaking changes. See VAULT-SPEC.md §5.
// =============================================================================

/** Current manifest schema version. Bump only on breaking changes. */
export const MANIFEST_SCHEMA_VERSION = 1;

// --- ContextScore embed (mirrors docs/schemas/ContextScore.json) ------------
// Embedded so the UI/offline tools can render a domain's last score without
// recomputing. null until first scored. Kept structurally minimal here — the
// scoring track owns the producer; manifest.ts only stores/round-trips it.

export interface ScoreDimension {
  score: number;
  detail: string;
}

export interface ScoreBreakdown {
  coverage: ScoreDimension;
  density: ScoreDimension;
  freshness: ScoreDimension;
  structure: ScoreDimension;
  activity: ScoreDimension;
  config_completeness: ScoreDimension;
}

export interface MissingItem {
  label: string;
  severity: string;
  kind: string;
}

// --- Domain relevance (mirrors docs/schemas/ContextScore.json#relevance) -----
// The domain-intelligent half of the score: how much of the context that
// actually matters for THIS domain (a recent tax return, a health insurance
// card, …) is present and fresh. Additive — null for domains with no rubric.
// The producer lives in src/rubrics.ts; manifest.ts only stores/round-trips it.

export interface RelevanceItem {
  id: string;
  label: string;
  present: boolean;
  stale: boolean;
  severity: string;
  detail: string;
  recommend: string;
}

export interface DomainRelevance {
  matched: string;
  score: number;
  detail: string;
  items: RelevanceItem[];
}

export interface ContextScore {
  domain: string;
  score: number;
  breakdown: ScoreBreakdown;
  /** Domain-intelligent relevance layer; null when no rubric matches. */
  relevance: DomainRelevance | null;
  missing: MissingItem[];
  freshness_secs: number;
  assessment: string | null;
  audit_source: string | null;
  computed_at: string;
  audited_at: number | null;
}

export interface ManifestIdentity {
  /** Canonical domain key — matches the directory name. Immutable once set. */
  name: string;
  /** Human display name, e.g. 'Wealth'. */
  label: string;
  /** Single emoji shown in the sidebar. */
  emoji: string;
  /** One-line description of what this domain is for. */
  summary: string;
  /** ISO-8601 creation timestamp. */
  created: string;
}

export interface ManifestConfig {
  /** Default engine for chat in this domain. */
  cli: CliKind;
  /** Default model id for the chosen CLI. Empty string = CLI's own default. */
  model: string;
  /** Default response framework id (BLUF, SCQA, ...) or null for none. */
  framework: string | null;
  /** Default analytical lens id or null for none. */
  lens: string | null;
  /** Skill ids enabled in this domain (skills/<name>/SKILL.md). */
  skills: string[];
  /** When true, chat turns auto-distill into state.md / decisions.md. */
  autoState: boolean;
}

export interface HeartbeatRoutine {
  id: string;
  schedule: string;
  enabled?: boolean;
}

export interface ManifestHeartbeat {
  enabled: boolean;
  routines: HeartbeatRoutine[];
}

export interface ManifestRouting {
  keywords: string[];
  channels: string[];
  default: boolean;
}

export interface ManifestSandbox {
  mode: "open" | "locked";
}

export interface ManifestPrivacy {
  localOnly: boolean;
}

export interface DomainManifest {
  schema: number;
  identity: ManifestIdentity;
  config: ManifestConfig;
  context_score: ContextScore | null;
  goals: string[];
  heartbeat: ManifestHeartbeat;
  routing: ManifestRouting;
  sandbox: ManifestSandbox;
  privacy: ManifestPrivacy;
  archived: boolean;
  archived_at: string | null;
}

// =============================================================================
// Path helpers — every manifest path is validated against the same vault
// invariants the scanner uses (validateVaultPath + isSafeEntryName +
// resolveSafeChild) so manifest.ts can never read/write outside the vault.
// =============================================================================

function domainDir(vaultPath: string, domain: string): string {
  const v = validateVaultPath(vaultPath);
  if (!v.ok) throw new Error(`invalid vault path: ${v.reason}`);
  if (!isSafeEntryName(domain)) throw new Error(`unsafe domain name: ${domain}`);
  return join(vaultPath, domain);
}

function manifestPath(vaultPath: string, domain: string): string {
  return join(domainDir(vaultPath, domain), "manifest.json");
}

// =============================================================================
// Immutable-zone guard (write permission contract — VAULT-SPEC.md §3).
//
// _drop/ and 01_prior/ are READ-ONLY to agents. assertWritable throws if a
// relative path targets either zone. Other zones (state.md, MEMORY.md,
// manifest.json, 00_current/, 02_briefs/, _log/, _threads/, _journal*) are
// agent-writable and pass through. config.md / QUICKSTART.md / PROMPTS.md are
// the human's but not *immutable* — this guard only blocks the two hard
// read-only zones, matching the spec's "tighten via sandbox.mode, never
// loosen these defaults" framing.
// =============================================================================

const IMMUTABLE_ZONE_PREFIXES = ["_drop", "01_prior"] as const;

export function assertWritable(vaultPath: string, relPath: string): void {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("assertWritable: relPath is empty");
  }
  if (relPath.includes("\0")) {
    throw new Error("assertWritable: relPath contains null bytes");
  }
  // Normalize separators and strip any leading "./" so "_drop/x",
  // "./_drop/x" and "_drop\\x" all resolve to the same first segment.
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const firstSegment = normalized.split("/")[0];
  for (const zone of IMMUTABLE_ZONE_PREFIXES) {
    if (firstSegment === zone) {
      throw new Error(
        `assertWritable: '${relPath}' is inside the immutable zone '${zone}/' — agents may read but never write here`,
      );
    }
  }
}

// =============================================================================
// Forward-migration shim — keyed on the integer `schema`. Mirrors the
// migrateLegacyCliKind pattern in config.ts: a reader that supports version N
// accepts any manifest with schema <= N, upgrading older shapes in memory.
// Migrations are idempotent and persisted on the next write.
// =============================================================================

function migrateManifest(raw: Record<string, unknown>): Record<string, unknown> {
  const m = { ...raw };
  let v = typeof m.schema === "number" && Number.isFinite(m.schema) ? Math.floor(m.schema) : 0;

  // schema 0 (or missing) → 1: legacy manifests written before the version
  // line existed. Nothing structural changed yet; stamp the version so the
  // forward-migrate loop is exercised and future steps have a clean base.
  if (v < 1) {
    m.schema = 1;
    v = 1;
  }

  // Future steps go here, each guarded by `if (v < N)` and bumping v.
  // e.g. if (v < 2) { /* rename a field */ m.schema = 2; v = 2; }

  return m;
}

// =============================================================================
// Coercion — turn an arbitrary parsed JSON value into a well-formed
// DomainManifest, applying sane defaults for anything missing/malformed. This
// is defensive (a hostile or hand-edited manifest must never crash a reader)
// and is also how forward-migration output gets normalized into the typed
// shape. Unknown fields are tolerated on read (dropped here) per VAULT-SPEC §5.
// =============================================================================

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function coerceDimension(v: unknown): ScoreDimension {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    score: typeof o.score === "number" ? o.score : 0,
    detail: str(o.detail, ""),
  };
}

function coerceContextScore(v: unknown): ContextScore | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const b = (o.breakdown && typeof o.breakdown === "object" ? o.breakdown : {}) as Record<
    string,
    unknown
  >;
  return {
    domain: str(o.domain, ""),
    score: typeof o.score === "number" ? o.score : 0,
    breakdown: {
      coverage: coerceDimension(b.coverage),
      density: coerceDimension(b.density),
      freshness: coerceDimension(b.freshness),
      structure: coerceDimension(b.structure),
      activity: coerceDimension(b.activity),
      config_completeness: coerceDimension(b.config_completeness),
    },
    missing: Array.isArray(o.missing)
      ? o.missing
          .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
          .map((x) => ({
            label: str(x.label, ""),
            severity: str(x.severity, "info"),
            kind: str(x.kind, "file"),
          }))
      : [],
    relevance: coerceRelevance(o.relevance),
    freshness_secs: typeof o.freshness_secs === "number" ? o.freshness_secs : 0,
    assessment: strOrNull(o.assessment),
    audit_source: strOrNull(o.audit_source),
    computed_at: str(o.computed_at, new Date().toISOString()),
    audited_at: typeof o.audited_at === "number" ? o.audited_at : null,
  };
}

function coerceRelevance(v: unknown): DomainRelevance | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const items = Array.isArray(o.items)
    ? o.items
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          id: str(x.id, ""),
          label: str(x.label, ""),
          present: x.present === true,
          stale: x.stale === true,
          severity: str(x.severity, "info"),
          detail: str(x.detail, ""),
          recommend: str(x.recommend, ""),
        }))
    : [];
  return {
    matched: str(o.matched, ""),
    score: typeof o.score === "number" ? o.score : 0,
    detail: str(o.detail, ""),
    items,
  };
}

function coerceManifest(raw: unknown, domain: string): DomainManifest {
  const migrated = migrateManifest((raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>);
  const o = migrated;

  const idRaw = (o.identity && typeof o.identity === "object" ? o.identity : {}) as Record<
    string,
    unknown
  >;
  const cfgRaw = (o.config && typeof o.config === "object" ? o.config : {}) as Record<
    string,
    unknown
  >;
  const hbRaw = (o.heartbeat && typeof o.heartbeat === "object" ? o.heartbeat : {}) as Record<
    string,
    unknown
  >;
  const routeRaw = (o.routing && typeof o.routing === "object" ? o.routing : {}) as Record<
    string,
    unknown
  >;
  const sbRaw = (o.sandbox && typeof o.sandbox === "object" ? o.sandbox : {}) as Record<
    string,
    unknown
  >;
  const privRaw = (o.privacy && typeof o.privacy === "object" ? o.privacy : {}) as Record<
    string,
    unknown
  >;

  const cli = isCliKind(str(cfgRaw.cli, "")) ? (cfgRaw.cli as CliKind) : "claude";
  const mode = sbRaw.mode === "locked" ? "locked" : "open";

  const routines: HeartbeatRoutine[] = Array.isArray(hbRaw.routines)
    ? hbRaw.routines
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .filter((r) => typeof r.id === "string" && typeof r.schedule === "string")
        .map((r) => {
          const out: HeartbeatRoutine = { id: r.id as string, schedule: r.schedule as string };
          if (typeof r.enabled === "boolean") out.enabled = r.enabled;
          return out;
        })
    : [];

  return {
    schema: typeof o.schema === "number" ? Math.floor(o.schema) : MANIFEST_SCHEMA_VERSION,
    identity: {
      name: str(idRaw.name, domain),
      label: str(idRaw.label, defaultLabel(domain)),
      emoji: str(idRaw.emoji, ""),
      summary: str(idRaw.summary, ""),
      created: str(idRaw.created, new Date().toISOString()),
    },
    config: {
      cli,
      model: str(cfgRaw.model, ""),
      framework: strOrNull(cfgRaw.framework),
      lens: strOrNull(cfgRaw.lens),
      skills: strArray(cfgRaw.skills),
      autoState: bool(cfgRaw.autoState, false),
    },
    context_score: coerceContextScore(o.context_score),
    goals: strArray(o.goals),
    heartbeat: {
      enabled: bool(hbRaw.enabled, false),
      routines,
    },
    routing: {
      keywords: strArray(routeRaw.keywords),
      channels: strArray(routeRaw.channels),
      default: bool(routeRaw.default, false),
    },
    sandbox: { mode },
    privacy: { localOnly: bool(privRaw.localOnly, false) },
    archived: bool(o.archived, false),
    archived_at: strOrNull(o.archived_at),
  };
}

// =============================================================================
// Identity synthesis from config.md + folder name. config.md is a loose
// "## Section" + "key: value" markdown file (see vault-demo/*/config.md). We
// pull a human label/summary heuristically; anything absent falls back to a
// derived default. This is best-effort — config.md is the human's file and may
// be blank.
// =============================================================================

/** "real-estate" → "Real Estate", "wealth" → "Wealth". */
function defaultLabel(domain: string): string {
  return domain
    .split(/[-_]/)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

interface ConfigMdHints {
  label?: string;
  summary?: string;
}

function readConfigMdHints(dir: string): ConfigMdHints {
  const file = join(dir, "config.md");
  if (!existsSync(file)) return {};
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const hints: ConfigMdHints = {};
  // The H1 title in vault-demo configs is "AI Ready Life: <Label> — Config".
  // Pull the middle segment as a display label when present.
  const h1 = raw.match(/^#\s+(.+?)\s*$/m);
  if (h1) {
    const title = h1[1];
    const m = title.match(/:\s*(.+?)\s*(?:[—-]\s*Config)?\s*$/);
    if (m && m[1].trim().length > 0) hints.label = m[1].trim();
  }
  // A `summary:` or `description:` key, if the human filled one in.
  const sum = raw.match(/^\s*(?:summary|description)\s*:\s*(.+?)\s*$/im);
  if (sum && sum[1].trim().length > 0) hints.summary = sum[1].trim();
  return hints;
}

function defaultManifest(vaultPath: string, domain: string): DomainManifest {
  const dir = domainDir(vaultPath, domain);
  const hints = readConfigMdHints(dir);
  return {
    schema: MANIFEST_SCHEMA_VERSION,
    identity: {
      name: domain,
      label: hints.label ?? defaultLabel(domain),
      emoji: "",
      summary: hints.summary ?? "",
      created: new Date().toISOString(),
    },
    config: {
      cli: "claude",
      model: "",
      framework: null,
      lens: null,
      skills: [],
      autoState: false,
    },
    context_score: null,
    goals: [],
    heartbeat: { enabled: false, routines: [] },
    routing: { keywords: [], channels: [], default: false },
    sandbox: { mode: "open" },
    privacy: { localOnly: false },
    archived: false,
    archived_at: null,
  };
}

// =============================================================================
// Public API (FROZEN signatures — all tracks compose against these).
// =============================================================================

/** Read manifest.json for a domain, migrating older schema versions forward
 *  in memory. Returns null if the file is absent or unparseable. */
export function readManifest(vaultPath: string, domain: string): DomainManifest | null {
  const file = manifestPath(vaultPath, domain);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  return coerceManifest(raw, domain);
}

/** Atomically write a pretty-printed manifest.json. Writes to a temp sibling
 *  then rename(2)s over the target (atomic on same-FS APFS/ext4). */
export function writeManifest(vaultPath: string, domain: string, m: DomainManifest): void {
  const file = manifestPath(vaultPath, domain);
  // Honor the immutable-zone contract: manifest.json itself is agent-writable,
  // but route through assertWritable so the rule is enforced from one place.
  assertWritable(vaultPath, "manifest.json");
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Re-coerce on write so we never persist junk and the schema is stamped.
  const normalized = coerceManifest(m as unknown, domain);
  const json = `${JSON.stringify(normalized, null, 2)}\n`;
  const tmp = join(dir, `.manifest.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, json);
  try {
    chmodSync(tmp, 0o644);
  } catch {
    /* best effort */
  }
  renameSync(tmp, file);
}

/** Create a manifest from config.md + defaults if missing; also seed an empty
 *  MEMORY.md if absent. Idempotent — returns the existing manifest unchanged
 *  (after forward-migration) when one is already present, but always ensures
 *  MEMORY.md exists. */
export function ensureManifest(vaultPath: string, domain: string): DomainManifest {
  const dir = domainDir(vaultPath, domain);
  // SECURITY: confirm the domain dir actually resolves under the vault root
  // (symlink-escape guard). resolveSafeChild returns null when the dir
  // doesn't exist yet — that's fine for a brand-new domain, so only refuse
  // when it exists AND escapes.
  if (existsSync(dir) && resolveSafeChild(vaultPath, domain) === null) {
    throw new Error(`ensureManifest: domain '${domain}' escapes the vault root`);
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  seedMemory(vaultPath, domain);

  const existing = readManifest(vaultPath, domain);
  if (existing) {
    // Idempotent: persist the forward-migrated shape only if it changed on
    // disk (schema bump or normalization). Cheap compare via serialization.
    const onDisk = readFileSync(manifestPath(vaultPath, domain), "utf8");
    const normalized = `${JSON.stringify(existing, null, 2)}\n`;
    if (onDisk !== normalized) writeManifest(vaultPath, domain, existing);
    return existing;
  }

  const created = defaultManifest(vaultPath, domain);
  writeManifest(vaultPath, domain, created);
  return created;
}

/** Seed an empty MEMORY.md (durable per-domain facts) if absent. MEMORY.md is
 *  an agent-writable zone. No-op if it already exists. */
function seedMemory(vaultPath: string, domain: string): void {
  const dir = domainDir(vaultPath, domain);
  assertWritable(vaultPath, "MEMORY.md");
  const file = join(dir, "MEMORY.md");
  if (existsSync(file)) return;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const label = defaultLabel(domain);
  const body = [
    `# ${label} — Memory`,
    "",
    "> Durable facts that outlive any single chat turn — account names, allocations,",
    "> standing preferences. Agents read this for context and append new durable facts here.",
    "",
  ].join("\n");
  writeFileSync(file, body);
}
