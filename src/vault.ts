import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { vreadFile } from "./vault-session.ts";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isSafeEntryName, resolveSafeChild, validateVaultPath } from "./path-safety.ts";
import { readManifest } from "./manifest.ts";

export type ViewKey = "state" | "loops" | "quickstart" | "prompts" | "skills";

export interface DomainSkill {
  id: string;
  title: string;
  path: string;
}

export interface Domain {
  name: string;
  path: string;
  hasState: boolean;
  openLoopCount: number;
  stateMtime: number | null;
  skills: DomainSkill[];
  // ADDITIVE (Track E1): optional one-line summary lifted from the domain's
  // manifest.json identity, when present. undefined when the domain has no
  // manifest.json or it's unparseable — existing callers that don't read this
  // field are unaffected. The scanner never *creates* a manifest; it only
  // surfaces an existing one's label/summary for the sidebar.
  manifestSummary?: ManifestSummary;
}

// Lightweight projection of manifest.json identity for the sidebar. Kept thin
// (no scoring/heartbeat) so scanVault stays cheap; full reads go through
// manifest.ts readManifest.
export interface ManifestSummary {
  label: string;
  emoji: string;
  summary: string;
  archived: boolean;
}

const NON_DOMAIN_DIRS = new Set([
  "complete",
  "core",
  "scripts",
  ".git",
  ".claude",
  ".claude-plugin",
  "node_modules",
  "_archive",
]);

// Importance order for the LIFE DOMAINS sidebar. Coordinators (chief, council)
// come first, then daily-driver life domains, then periodic/archival domains.
// Anything not in this list falls to the bottom, alphabetically.
const DOMAIN_PRIORITY: readonly string[] = [
  "chief",        // chief of staff — daily brief, cross-domain triage
  "council",      // council of elders — cross-agent coordination
  "vision",       // long-horizon goals & retrospectives
  "wealth",       // money pulse
  "health",       // body pulse
  "tax",          // compliance + deadlines
  "calendar",     // time
  "career",       // primary income (W2)
  "business",     // secondary income (LLCs)
  "estate",       // real estate operations
  "real-estate",  // real estate documents
  "insurance",    // risk management
  "benefits",     // comp & benefits
  "brand",        // personal + biz brand
  "content",      // content production
  "social",       // relationships
  "homestead",    // household
  "learning",     // skill building
  "explore",      // exploration / opportunities
  "intel",        // info gathering
  "records",      // archive
];

function domainRank(name: string): number {
  const idx = DOMAIN_PRIORITY.indexOf(name);
  return idx === -1 ? DOMAIN_PRIORITY.length : idx;
}

// Skill ordering: cadenced operational skills (briefs > weekly > monthly > sync >
// review) outrank utility skills (build/extract/flag) outrank everything else.
// Within a tier, sort alphabetically.
export type SkillGroup = "op" | "flow" | "task" | "other";

// Classify a skill by its <domain>-<group>-<name> convention. Anything that
// doesn't match an explicit group prefix lands in "other" — bare integration
// names (fidelity, notion) and any unconventionally named skills.
export function skillGroup(id: string): SkillGroup {
  const s = id.toLowerCase();
  if (s.includes("-op-") || s.endsWith("-op")) return "op";
  if (s.includes("-flow-") || s.endsWith("-flow")) return "flow";
  if (s.includes("-task-") || s.endsWith("-task")) return "task";
  return "other";
}

const GROUP_OFFSET: Record<SkillGroup, number> = {
  op: 0,
  flow: 1000,
  task: 2000,
  other: 3000,
};

function skillRank(id: string): number {
  const s = id.toLowerCase();
  const base = GROUP_OFFSET[skillGroup(id)];
  // Cadence within group: daily/brief → weekly → monthly → sync → review →
  // build/draft → extract/pull → flag/watch → general → bare integration.
  if (/(^|-)(daily|morning|evening)(-|$)/.test(s)) return base + 0;
  if (s.endsWith("-brief") || s.includes("-brief-")) return base + 1;
  if (s.includes("weekly")) return base + 2;
  if (s.includes("monthly") || s.includes("quarterly") || s.includes("annual")) return base + 3;
  if (s.includes("sync") || s.includes("synthesis")) return base + 4;
  if (s.includes("review") || s.includes("audit") || s.includes("analyze")) return base + 5;
  if (/(^|-)build-/.test(s) || /(^|-)prepare-/.test(s) || /(^|-)calculate-/.test(s) || /(^|-)draft-/.test(s)) return base + 6;
  if (/(^|-)extract-/.test(s) || /(^|-)pull-/.test(s) || /(^|-)check-/.test(s) || /(^|-)log-/.test(s)) return base + 7;
  if (/(^|-)flag-/.test(s) || /(^|-)watch-/.test(s) || /(^|-)track-/.test(s)) return base + 8;
  if (!s.includes("-")) return base + 10;
  return base + 9;
}

export function resolveDefaultVaultPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "..", "..", "fd-apps-prevail-life", "vault-demo");
  return candidate;
}

// ─── v1/v2 layout resolution ────────────────────────────────────────────────
// VAULT-SPEC v2 renamed the canonical per-domain files (state.md → _state.md,
// skills/ → _skills/, decisions.md → _decisions.jsonl, 00_current/01_prior →
// data/, …) and detects a domain by soul.md (declared intent) rather than a
// hand-written state.md. The CLI reads BOTH layouts until every vault migrates.

/** True if a directory is a domain: declared intent (soul.md, v2) OR a snapshot
 *  (state.md v1 / _state.md v2). */
export function isDomainDir(domainPath: string): boolean {
  return existsSync(join(domainPath, "soul.md"))
    || existsSync(join(domainPath, "_state.md"))
    || existsSync(join(domainPath, "state.md"));
}

/** The domain's current-state file: v2 `_state.md`, else v1 `state.md`, else null
 *  (a fresh v2 domain that has intent but no derived state yet). */
export function resolveStatePath(domainPath: string): string | null {
  const v2 = join(domainPath, "_state.md");
  if (existsSync(v2)) return v2;
  const v1 = join(domainPath, "state.md");
  if (existsSync(v1)) return v1;
  return null;
}

/** Strip a leading YAML frontmatter block (v2 `_state.md` carries `derived_from:`
 *  provenance) so previews/extracts see only the body. */
export function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const close = md.indexOf("\n---", 3);
  if (close === -1) return md;
  const nl = md.indexOf("\n", close + 1);
  return nl === -1 ? "" : md.slice(nl + 1);
}

/** Read the domain's state body (v2 `_state.md` || v1 `state.md`), frontmatter
 *  stripped. Returns "" if there's no state yet. */
export function readStateContent(domainPath: string): string {
  const p = resolveStatePath(domainPath);
  if (!p) return "";
  try {
    return stripFrontmatter(vreadFile(p));
  } catch {
    return "";
  }
}

export function scanVault(vaultPath: string): Domain[] {
  // SECURITY: refuse to scan if the configured vault path is catastrophic
  // (/, /etc, /System, ...) — better to surface an empty domain list than
  // start traversing system dirs. Caller can show "vault path looks wrong"
  // when this returns [] for an existsSync path.
  const v = validateVaultPath(vaultPath);
  if (!v.ok) return [];
  if (!existsSync(vaultPath)) return [];
  const entries = readdirSync(vaultPath, { withFileTypes: true });
  const lifePath = resolve(vaultPath, "..");

  const domains: Domain[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (NON_DOMAIN_DIRS.has(entry.name)) continue;
    // SECURITY: belt-and-suspenders entry-name guard (rejects null bytes,
    // control chars, "..", leading-dot hidden dirs, anything over 200
    // chars). readdirSync at the OS level already strips path separators,
    // but explicit validation makes "we never read outside the vault" an
    // enforceable invariant instead of an emergent one.
    if (!isSafeEntryName(entry.name)) continue;
    // SECURITY: confirm the resolved child actually lives under the vault
    // root after symlink resolution. A symlink that escapes the vault
    // (e.g. wealth -> ../../etc) is silently skipped instead of followed.
    if (!resolveSafeChild(vaultPath, entry.name)) continue;

    const domainPath = join(vaultPath, entry.name);
    // v2 detects a domain by soul.md (declared intent); v1 by state.md. The
    // derived _state.md also counts during the transition.
    if (!isDomainDir(domainPath)) continue;
    const statePath = resolveStatePath(domainPath); // _state.md || state.md || null
    const hasState = statePath !== null;

    let openLoopCount = 0;
    if (statePath) {
      try {
        openLoopCount = countOpenItemsInState(stripFrontmatter(vreadFile(statePath)));
      } catch {}
    }
    if (openLoopCount === 0) {
      const loopsPath = join(domainPath, "open-loops.md"); // v1
      const tasksPath = join(domainPath, "_tasks.jsonl"); // v2
      if (existsSync(loopsPath)) {
        try {
          openLoopCount = countUncheckedBoxes(vreadFile(loopsPath));
        } catch {}
      } else if (existsSync(tasksPath)) {
        try {
          openLoopCount = vreadFile(tasksPath)
            .split("\n")
            .filter((l) => l.trim())
            .filter((l) => {
              try {
                const t = JSON.parse(l) as { status?: string };
                return !!t.status && !["done", "dropped"].includes(t.status);
              } catch {
                return false;
              }
            }).length;
        } catch {}
      }
    }

    let stateMtime: number | null = null;
    if (statePath) {
      try {
        stateMtime = statSync(statePath).mtimeMs;
      } catch {}
    }

    // ADDITIVE: surface an existing manifest.json's identity, if any. Never
    // creates one; failures are swallowed so a malformed manifest can't break
    // the scan (the domain still appears on its state.md alone).
    let manifestSummary: ManifestSummary | undefined;
    try {
      const m = readManifest(vaultPath, entry.name);
      if (m) {
        manifestSummary = {
          label: m.identity.label,
          emoji: m.identity.emoji,
          summary: m.identity.summary,
          archived: m.archived,
        };
      }
    } catch {}

    domains.push({
      name: entry.name,
      path: domainPath,
      hasState,
      openLoopCount,
      stateMtime,
      skills: scanSkills(lifePath, vaultPath, entry.name),
      ...(manifestSummary ? { manifestSummary } : {}),
    });
  }

  domains.sort((a, b) => {
    const ra = domainRank(a.name);
    const rb = domainRank(b.name);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
  return domains;
}

function countUncheckedBoxes(content: string): number {
  let count = 0;
  for (const line of content.split("\n")) {
    if (/^\s*[-*]\s*\[\s\]/.test(line)) count++;
  }
  return count;
}

function countOpenItemsInState(content: string): number {
  const lines = content.split("\n");
  let inSection = false;
  let count = 0;
  for (const line of lines) {
    if (/^##\s+Open Items\b/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+\S/.test(line)) break;
    if (inSection && /^\s*[-*]\s*\[\s\]/.test(line)) count++;
  }
  return count;
}

function extractOpenItemsSection(content: string): string | null {
  const lines = content.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Open Items\b/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+\S/.test(line)) break;
    if (inSection) out.push(line);
  }
  const joined = out.join("\n").trim();
  return joined.length > 0 ? joined : null;
}

function scanSkills(lifePath: string, vaultPath: string, domain: string): DomainSkill[] {
  // Try vault-internal layout first (vault-demo/<domain>/skills/), then sibling layout
  // (<lifeRoot>/<domain>/skills/) for compatibility with the original Prevail structure.
  const candidates = [
    join(vaultPath, domain, "skills"),
    join(lifePath, domain, "skills"),
  ];
  for (const skillsRoot of candidates) {
    if (!existsSync(skillsRoot)) continue;
    const out: DomainSkill[] = [];
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(skillsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(skillsRoot, entry.name);
      const skillFile = join(skillPath, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      // Skip connector stubs (SKILL.md with `type: app` in frontmatter).
      // The vault-demo bundles 1password / fidelity / m1-finance / etc.
      // under domain skills folders so they can be discovered, but with
      // apps collapsed out of the UI those entries shouldn't inflate the
      // domain's skill count. Cheap inline scan — only the first ~10
      // lines of SKILL.md matter for the type tag.
      try {
        const head = vreadFile(skillFile).slice(0, 400);
        if (/^\s*type:\s*app\s*$/m.test(head)) continue;
      } catch {
        /* unreadable — treat as a real skill, fall through */
      }
      out.push({
        id: entry.name,
        title: extractSkillTitle(skillFile, entry.name),
        path: skillFile,
      });
    }
    if (out.length > 0) {
      out.sort((a, b) => {
        const ra = skillRank(a.id);
        const rb = skillRank(b.id);
        if (ra !== rb) return ra - rb;
        return a.id.localeCompare(b.id);
      });
      return out;
    }
  }
  return [];
}

function extractSkillTitle(skillFile: string, fallback: string): string {
  try {
    const raw = vreadFile(skillFile);
    const m = raw.match(/^#\s+(.+?)\s*$/m);
    if (m) return m[1].trim();
    const fm = raw.match(/^name:\s*(.+?)\s*$/m);
    if (fm) return fm[1].trim();
  } catch {}
  return fallback;
}

export function readDomainView(domain: Domain, view: ViewKey): string {
  if (view === "skills") return renderSkillsView(domain);
  if (view === "loops") return readOpenItems(domain);
  if (view === "state") {
    const body = readStateContent(domain.path); // _state.md || state.md
    return body || `*No state for ${domain.name}.*`;
  }
  const fileMap: Record<"state" | "quickstart" | "prompts", string> = {
    state: "state.md", // handled above; kept for type completeness
    quickstart: "QUICKSTART.md",
    prompts: "PROMPTS.md",
  };
  // Belt-and-suspenders: if `view` is somehow neither of the early-return
  // keys nor a fileMap key (e.g. an out-of-bounds viewIdx slipping through),
  // fall back to state.md instead of letting join() throw on undefined.
  const filename = fileMap[view] ?? "state.md";
  const file = join(domain.path, filename);
  if (!existsSync(file)) {
    return `*No ${filename} for ${domain.name}.*`;
  }
  try {
    return vreadFile(file);
  } catch (err) {
    return `*Failed to read ${file}: ${(err as Error).message}*`;
  }
}

function readOpenItems(domain: Domain): string {
  const content = readStateContent(domain.path); // _state.md || state.md
  if (content) {
    const section = extractOpenItemsSection(content);
    if (section) return `# ${domain.name} — open items\n\n${section}`;
  }
  const loopsPath = join(domain.path, "open-loops.md");
  if (existsSync(loopsPath)) {
    try {
      return vreadFile(loopsPath);
    } catch {}
  }
  return `*No open items for ${domain.name}.*`;
}

function renderSkillsView(domain: Domain): string {
  if (domain.skills.length === 0) {
    return `*No skills found for ${domain.name}.*`;
  }
  const lines: string[] = [];
  lines.push(`# ${domain.name} skills (${domain.skills.length})`);
  lines.push("");
  for (const skill of domain.skills) {
    lines.push(`- **${skill.id}** — ${skill.title}`);
  }
  return lines.join("\n");
}

export interface DomainContext {
  name: string;
  updatedLabel: string;
  openItems: string[];
  statePreview: string[];
}

export function buildDomainContext(domain: Domain): DomainContext {
  const updatedLabel = formatRelativeTime(domain.stateMtime);
  const raw = readStateContent(domain.path); // _state.md || state.md
  const openItems = extractOpenItems(raw).slice(0, 5);
  const statePreview = extractStateHeadline(raw, 4);
  return {
    name: domain.name,
    updatedLabel,
    openItems,
    statePreview,
  };
}

function extractOpenItems(content: string): string[] {
  const lines = content.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Open Items\b/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+\S/.test(line)) break;
    if (inSection) {
      const m = line.match(/^\s*[-*]\s*\[\s\]\s*(.+)$/);
      if (m) out.push(m[1].trim());
    }
  }
  return out;
}

function extractStateHeadline(content: string, max: number): string[] {
  const lines = content.split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (out.length >= max) break;
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith(">")) continue;
    if (line.startsWith("---")) continue;
    if (line.startsWith("|")) continue;
    out.push(line.replace(/[*_`]/g, ""));
  }
  return out;
}

// AppSkill carries the same Vaultable shape as Domain (path, hasState,
// openLoopCount, stateMtime, skills) plus app-specific metadata. Vault apps
// (<vault>/apps/<id>/) populate hasState=true and a real skill list.
// Community apps populate hasState=false and just point at their SKILL.md.
// An "app" (now also called a "connector") is a third-party integration —
// US Bank, Google Calendar, MyChart, etc — that produces data which one
// or more life domains consume. The shape evolved from "skill bundle that
// happened to be filed under apps/" to a richer record with explicit
// connection metadata + per-connector health.
export interface AppSkill {
  id: string;
  title: string;
  description: string;
  // Life domains that consume this connector's data. A connector can
  // be wired to multiple — US Bank statements feed wealth, tax, and home.
  domains: string[];
  path: string;
  hasState: boolean;
  openLoopCount: number;
  stateMtime: number | null;
  skills: DomainSkill[];
  community: boolean;
  manifestPath?: string;
  // --- new connector fields (all optional so legacy apps keep loading) ---
  // How the connector talks to the third party. "api" = REST/GraphQL with
  // stored key; "oauth" = token-refresh flow; "browser" = playwright/cookie
  // scrape; "mcp" = wrapped via an installed MCP server; "manual" = user
  // drops files in a watched folder.
  integration?: "api" | "oauth" | "browser" | "mcp" | "manual";
  // Free-form human-readable description of HOW the connector connects —
  // rendered in the app detail view's Connection section. Comes from
  // connection.md in the connector folder if present.
  connectionNotes?: string;
  // Current health, derived from connection-status.json. Defaults to
  // "not-configured" when missing.
  status: ConnectorStatus;
  // Last successful action timestamp (ms epoch), null if never run.
  lastSuccessTs: number | null;
  // Human label of the last error, if any.
  lastError?: string;
  // Whether the connector folder contains anything bespoke beyond the
  // bundled manifest (auth files, downloaded data, status file). Used by
  // the sidebar to differentiate "freshly installed, untouched" from
  // "in use" at a glance.
  configured: boolean;
  // Raw auth_check block from manifest.json — defines HOW to test the
  // connector's auth. Read by connector-probe.ts. Opaque object here so
  // we don't have to import the probe module from vault.ts.
  authCheck?: unknown;
  // Raw oauth block from manifest.json — defines the OAuth flow when
  // integration === "oauth". Read by oauth-flow.ts. Opaque here for the
  // same dep-isolation reason.
  oauth?: unknown;
  // --- autonomous-sync fields (manifest-driven; all optional) ---
  // When/how the sync daemon refreshes this connector. `every` accepts
  // "hourly" | "<N>h" | "daily" | "weekly"; `at` an HH:MM; `on` a weekday
  // (weekly only); `skill` names the skill to run (defaults to the first
  // skill whose trigger is "refresh").
  refresh?: AppRefresh;
  // What the connector may DO on the user's behalf. Enforced in the api
  // runner per op class: read ops always allowed; draft ops need >= "draft";
  // send/act ops need "act". Default "read-only".
  autonomy?: AppAutonomy;
  // Human-meaningful account identity for multi-instance connectors
  // (gmail-personal vs gmail-estate): shown in every UI row.
  account?: { label: string; address?: string };
  // Routing: which artifacts/records land in which domain. When absent,
  // one summary intent record goes to every domain in domains[].
  routes?: AppRoute[];
}

export interface AppRefresh {
  every: string; // "hourly" | "2h".."23h" | "daily" | "weekly"
  at?: string;   // "HH:MM"
  on?: string;   // "mon".."sun" (weekly)
  skill?: string;
}

export type AppAutonomy = "read-only" | "draft" | "act";

export interface AppRoute {
  match: string;  // glob-ish path filter under the connector dir, e.g. "data/attachments/**/*.pdf"
  domain: string;
  copy?: boolean; // also copy matched files into <vault>/<domain>/imports/
}

export type ConnectorStatus = "connected" | "not-configured" | "expired" | "error";

export interface CommunityAppManifest {
  id: string;
  name?: string;
  description?: string;
  domains?: string[];
  version?: string;
  homepage?: string;
  // New: integration type metadata (optional). Older manifests without
  // this field default to "manual" at scan time.
  integration?: AppSkill["integration"];
  // New: short description of how the connector connects. Inline
  // alternative to a separate connection.md file.
  connection?: string;
}

function communityAppsDirs(): string[] {
  const dirs: string[] = [];
  // User-installed connectors live here. Anything they add takes precedence.
  dirs.push(join(homedir(), ".prevail", "apps"));
  // Also accept the explicit PREVAIL_APPS_DIR override (useful for
  // development and CI). Keeps the connector discovery hermetic when set.
  if (process.env.PREVAIL_APPS_DIR) dirs.push(process.env.PREVAIL_APPS_DIR);
  // For the compiled binary: execPath is `dist/prevail`, so the bundled
  // community apps live at `dist/../apps/community`. Check both adjacency
  // (dev: running source under bun run) and parent-adjacency (release:
  // running compiled binary out of dist/).
  try {
    const execDir = dirname(process.execPath);
    dirs.push(resolve(execDir, "apps", "community"));
    dirs.push(resolve(execDir, "..", "apps", "community"));
  } catch {}
  if (process.argv[1]) {
    try {
      const argvDir = dirname(process.argv[1]);
      dirs.push(resolve(argvDir, "apps", "community"));
      dirs.push(resolve(argvDir, "..", "apps", "community"));
    } catch {}
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    dirs.push(resolve(here, "..", "apps", "community"));
  } catch {}
  return dirs;
}

// Validate + coerce a parsed manifest.json into a shape that's safe to
// render. Every field has a defensive fallback so a hostile or malformed
// manifest cannot crash the scanner or contaminate the AppSkill list.
const VALID_INTEGRATIONS = new Set([
  "api",
  "oauth",
  "browser",
  "mcp",
  "manual",
]);

interface CoercedManifest {
  id: string;
  name: string;
  description: string;
  domains: string[];
  integration: "api" | "oauth" | "browser" | "mcp" | "manual";
  connection?: string;
  authCheck?: unknown;
  oauth?: unknown;
  refresh?: AppRefresh;
  autonomy?: AppAutonomy;
  account?: { label: string; address?: string };
  routes?: AppRoute[];
}

const VALID_AUTONOMY = new Set(["read-only", "draft", "act"]);

// Defensive coercion for the sync-layer manifest fields. Same philosophy as
// coerceCommunityManifest: a hostile or malformed block degrades to undefined,
// never throws, never escapes its caps.
function coerceRefresh(v: unknown): AppRefresh | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const every = typeof o.every === "string" ? o.every.trim().toLowerCase().slice(0, 16) : "";
  if (!/^(hourly|([2-9]|1[0-9]|2[0-3])h|daily|weekly)$/.test(every)) return undefined;
  const at = typeof o.at === "string" && /^\d{1,2}:\d{2}$/.test(o.at.trim()) ? o.at.trim() : undefined;
  const on = typeof o.on === "string" && /^(mon|tue|wed|thu|fri|sat|sun)$/i.test(o.on.trim()) ? o.on.trim().toLowerCase() : undefined;
  const skill = typeof o.skill === "string" && /^[a-z0-9_-]+$/i.test(o.skill.trim()) ? o.skill.trim() : undefined;
  return { every, at, on, skill };
}

function coerceAutonomy(v: unknown): AppAutonomy | undefined {
  return typeof v === "string" && VALID_AUTONOMY.has(v) ? (v as AppAutonomy) : undefined;
}

function coerceAccount(v: unknown): { label: string; address?: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const label = typeof o.label === "string" ? o.label.trim().slice(0, 48) : "";
  if (!label) return undefined;
  const address = typeof o.address === "string" ? o.address.trim().slice(0, 128) : undefined;
  return { label, address };
}

function coerceRoutes(v: unknown): AppRoute[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: AppRoute[] = [];
  for (const r of v.slice(0, 32)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const match = typeof o.match === "string" ? o.match.trim().slice(0, 256) : "";
    const domain = typeof o.domain === "string" && /^[a-z0-9 _-]+$/i.test(o.domain.trim()) ? o.domain.trim() : "";
    // match must stay inside the connector dir: no absolute paths, no traversal.
    if (!match || !domain || match.startsWith("/") || match.includes("..")) continue;
    out.push({ match, domain, copy: o.copy === true });
  }
  return out.length ? out : undefined;
}

function coerceCommunityManifest(raw: unknown, fallbackId: string): CoercedManifest {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, cap: number, fallback: string): string => {
    if (typeof v !== "string") return fallback;
    const trimmed = v.trim();
    return trimmed.length > cap ? trimmed.slice(0, cap) : trimmed;
  };
  const arrStr = (v: unknown, cap: number): string[] => {
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64)
      .slice(0, cap);
  };
  // ID must match a tight character class so it can't escape the connector
  // directory in any path join downstream. Falls back to the directory
  // name (which we KNOW is safe — it came from readdirSync).
  const idCandidate = str(o.id, 64, "");
  const id = /^[a-z0-9_-]+$/i.test(idCandidate) ? idCandidate : fallbackId;
  const integration = typeof o.integration === "string" && VALID_INTEGRATIONS.has(o.integration)
    ? (o.integration as CoercedManifest["integration"])
    : "manual";
  return {
    id,
    name: str(o.name, 80, fallbackId),
    description: str(o.description, 240, ""),
    domains: arrStr(o.domains, 16),
    integration,
    connection: typeof o.connection === "string" ? str(o.connection, 2000, "") : undefined,
    // SECURITY: validated by connector-probe.ts at probe time. We pass it
    // through opaquely here — coercion in the probe layer is safer because
    // it can validate each kind's specific subfields.
    authCheck: typeof o.auth_check === "object" && o.auth_check !== null ? o.auth_check : undefined,
    oauth: typeof o.oauth === "object" && o.oauth !== null ? o.oauth : undefined,
    refresh: coerceRefresh(o.refresh),
    autonomy: coerceAutonomy(o.autonomy),
    account: coerceAccount(o.account),
    routes: coerceRoutes(o.routes),
  };
}

export function scanCommunityApps(): AppSkill[] {
  const seen = new Set<string>();
  const out: AppSkill[] = [];
  for (const dir of communityAppsDirs()) {
    if (!existsSync(dir)) continue;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (seen.has(e.name)) continue;
      const root = join(dir, e.name);
      const manifestPath = join(root, "manifest.json");
      const skillPath = join(root, "SKILL.md");
      if (!existsSync(manifestPath) || !existsSync(skillPath)) continue;
      let manifestRaw: unknown;
      try {
        manifestRaw = JSON.parse(vreadFile(manifestPath));
      } catch {
        continue;
      }
      // SECURITY: a malformed manifest (wrong types, junk fields, hostile
      // shape) used to bubble a TypeError out of scanCommunityApps and drop
      // every later community app silently — perfect cover for a hostile
      // manifest to neuter the legit ones. Coerce defensively: anything
      // not the expected primitive type falls back to a safe default. Cap
      // string lengths so a single bloated manifest can't OOM the sidebar.
      const m = coerceCommunityManifest(manifestRaw, e.name);
      seen.add(e.name);
      const conn = readConnector(root);
      out.push({
        id: m.id,
        title: m.name,
        description: m.description,
        domains: m.domains,
        path: root,
        hasState: false,
        openLoopCount: 0,
        stateMtime: null,
        skills: scanAppSkills(root),
        community: true,
        manifestPath,
        integration: m.integration,
        connectionNotes: m.connection ?? conn.notes,
        status: conn.status,
        lastSuccessTs: conn.lastSuccessTs,
        lastError: conn.lastError,
        configured: conn.configured,
        authCheck: m.authCheck,
        oauth: m.oauth,
        refresh: m.refresh,
        autonomy: m.autonomy,
        account: m.account,
        routes: m.routes,
      });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// Read the connector-status side-channel files (connection.md and
// connection-status.json) co-located with the connector manifest. All
// fields are optional; defaults assume an untouched, never-run connector.
interface ConnectorState {
  notes: string;
  status: ConnectorStatus;
  lastSuccessTs: number | null;
  lastError?: string;
  configured: boolean;
}
function readConnector(root: string): ConnectorState {
  let notes = "";
  const connectionMd = join(root, "connection.md");
  if (existsSync(connectionMd)) {
    try { notes = vreadFile(connectionMd).trim(); } catch {}
  }
  let status: ConnectorStatus = "not-configured";
  let lastSuccessTs: number | null = null;
  let lastError: string | undefined;
  const statusJson = join(root, "connection-status.json");
  if (existsSync(statusJson)) {
    try {
      const raw = JSON.parse(vreadFile(statusJson));
      if (raw && typeof raw === "object") {
        if (typeof raw.status === "string" &&
            ["connected", "not-configured", "expired", "error"].includes(raw.status)) {
          status = raw.status as ConnectorStatus;
        }
        if (typeof raw.lastSuccessTs === "number") lastSuccessTs = raw.lastSuccessTs;
        if (typeof raw.lastError === "string") lastError = raw.lastError;
      }
    } catch {}
  }
  // "configured" = anything in the auth/ folder OR a non-empty status
  // file. Distinguishes "freshly cloned bundled connector with zero local
  // state" from "user has done at least one thing here".
  const authDir = join(root, "auth");
  const hasAuth = existsSync(authDir);
  const configured = hasAuth || existsSync(statusJson);
  return { notes, status, lastSuccessTs, lastError, configured };
}

// Vault apps live at <vault>/apps/<id>/ and mirror the domain shape exactly:
// state.md, open-loops.md, PROMPTS.md, QUICKSTART.md, skills/<skill-id>/SKILL.md.
function scanVaultApps(vaultPath: string): AppSkill[] {
  const appsRoot = join(vaultPath, "apps");
  if (!existsSync(appsRoot)) return [];
  const out: AppSkill[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(appsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const appPath = join(appsRoot, entry.name);
    const statePath = join(appPath, "state.md");
    const loopsPath = join(appPath, "open-loops.md");
    const hasState = existsSync(statePath);
    let openLoopCount = 0;
    let stateMtime: number | null = null;
    if (hasState) {
      try {
        const content = vreadFile(statePath);
        stateMtime = statSync(statePath).mtimeMs;
        openLoopCount = countOpenItemsInState(content);
      } catch {}
    }
    if (openLoopCount === 0 && existsSync(loopsPath)) {
      try {
        const content = vreadFile(loopsPath);
        openLoopCount = countUncheckedBoxes(content);
      } catch {}
    }
    const conn = readConnector(appPath);
    out.push({
      id: entry.name,
      title: extractAppTitle(appPath, entry.name),
      description: extractAppDescription(appPath),
      domains: extractAppDomains(appPath),
      path: appPath,
      hasState,
      openLoopCount,
      stateMtime,
      skills: scanAppSkills(appPath),
      community: false,
      // Vault apps don't yet ship integration metadata in their state.md
      // frontmatter — leave undefined; the detail view shows "manual"
      // when missing. Future: parse from state.md frontmatter.
      integration: undefined,
      connectionNotes: conn.notes,
      status: conn.status,
      lastSuccessTs: conn.lastSuccessTs,
      lastError: conn.lastError,
      configured: conn.configured || hasState,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function scanAppSkills(appPath: string): DomainSkill[] {
  const skillsRoot = join(appPath, "skills");
  if (!existsSync(skillsRoot)) return [];
  const out: DomainSkill[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsRoot, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    out.push({
      id: entry.name,
      title: extractSkillTitle(skillFile, entry.name),
      path: skillFile,
    });
  }
  out.sort((a, b) => {
    const ra = skillRank(a.id);
    const rb = skillRank(b.id);
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
  return out;
}

function extractAppTitle(appPath: string, fallback: string): string {
  const statePath = join(appPath, "state.md");
  if (existsSync(statePath)) {
    try {
      const content = vreadFile(statePath);
      const m = content.match(/^#\s+(.+?)\s*$/m);
      if (m) return m[1].split("—")[0].trim() || fallback;
    } catch {}
  }
  return fallback;
}

function extractAppDescription(appPath: string): string {
  const statePath = join(appPath, "state.md");
  if (!existsSync(statePath)) return "";
  try {
    const content = vreadFile(statePath);
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("#")) continue;
      if (trimmed.startsWith(">")) continue;
      if (trimmed.startsWith("**")) continue;
      return trimmed.replace(/\s+/g, " ").slice(0, 240);
    }
  } catch {}
  return "";
}

function extractAppDomains(appPath: string): string[] {
  const statePath = join(appPath, "state.md");
  if (!existsSync(statePath)) return [];
  try {
    const content = vreadFile(statePath);
    const m = content.match(/^\*\*Used by domains?:\*\*\s*(.+)$/im);
    if (m) {
      return m[1]
        .split(/[,·]/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
    }
  } catch {}
  return [];
}

export function scanApps(vaultPath: string): AppSkill[] {
  return scanVaultApps(vaultPath);
}

function extractDescription(skillFile: string): string {
  try {
    const raw = vreadFile(skillFile);
    const fm = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fm) return "";
    const block = fm[1];
    const m = block.match(/^description:\s*[>|]?\s*\n?([\s\S]*?)(?=^\w+:|$)/m);
    if (!m) return "";
    return m[1].trim().replace(/\s+/g, " ").slice(0, 240);
  } catch {
    return "";
  }
}

export function readAppSkill(app: AppSkill): string {
  // Community apps have a SKILL.md at the plugin root.
  const skillPath = join(app.path, "SKILL.md");
  if (existsSync(skillPath)) {
    try {
      return vreadFile(skillPath);
    } catch (err) {
      return `*Failed to read ${skillPath}: ${(err as Error).message}*`;
    }
  }
  return `*No SKILL.md for ${app.id}.*`;
}

export function readAppView(app: AppSkill, view: ViewKey): string {
  if (view === "skills") return renderAppSkillsView(app);
  if (view === "loops") return readAppOpenItems(app);
  const fileMap: Record<"state" | "quickstart" | "prompts", string> = {
    state: "state.md",
    quickstart: "QUICKSTART.md",
    prompts: "PROMPTS.md",
  };
  const file = join(app.path, fileMap[view]);
  if (!existsSync(file)) {
    if (app.community && view === "state") {
      return readAppSkill(app);
    }
    return `*No ${fileMap[view]} for ${app.id}.*`;
  }
  try {
    return vreadFile(file);
  } catch (err) {
    return `*Failed to read ${file}: ${(err as Error).message}*`;
  }
}

function readAppOpenItems(app: AppSkill): string {
  const statePath = join(app.path, "state.md");
  if (existsSync(statePath)) {
    try {
      const content = vreadFile(statePath);
      const section = extractOpenItemsSection(content);
      if (section) return `# ${app.id} — open items\n\n${section}`;
    } catch {}
  }
  const loopsPath = join(app.path, "open-loops.md");
  if (existsSync(loopsPath)) {
    try {
      return vreadFile(loopsPath);
    } catch {}
  }
  return `*No open items for ${app.id}.*`;
}

function renderAppSkillsView(app: AppSkill): string {
  if (app.skills.length === 0) {
    return `*No skills found for ${app.id}.*`;
  }
  const lines: string[] = [];
  lines.push(`# ${app.id} skills (${app.skills.length})`);
  lines.push("");
  for (const skill of app.skills) {
    lines.push(`- **${skill.id}** — ${skill.title}`);
  }
  return lines.join("\n");
}

export interface AppContext {
  id: string;
  updatedLabel: string;
  openItems: string[];
  statePreview: string[];
}

export function buildAppContext(app: AppSkill): AppContext {
  const updatedLabel = formatRelativeTime(app.stateMtime);
  const statePath = join(app.path, "state.md");
  let raw = "";
  try {
    raw = vreadFile(statePath);
  } catch {}
  const openItems = extractOpenItems(raw).slice(0, 5);
  const statePreview = extractStateHeadline(raw, 4);
  return { id: app.id, updatedLabel, openItems, statePreview };
}

export function formatRelativeTime(mtimeMs: number | null): string {
  if (mtimeMs === null) return "—";
  const diff = Date.now() - mtimeMs;
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return "today";
  if (diff < 2 * day) return "1d ago";
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}mo ago`;
  return `${Math.floor(diff / (365 * day))}y ago`;
}

// Scaffold a new community app under ~/.prevail/apps/<id>/ from a catalog
// pick: a manifest.json + SKILL.md + connection.md. The app then shows up in
// scanCommunityApps() and the desktop's Connected view, "not-configured" until
// the user authenticates it. Never overwrites an existing app.
export function scaffoldCommunityApp(opts: {
  id: string;
  title: string;
  integration: "api" | "oauth" | "browser" | "mcp" | "cli" | "manual";
  domains: string[];
  connection?: string;
}): { ok: boolean; path?: string; error?: string } {
  const id = opts.id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(id)) {
    return { ok: false, error: `invalid app id "${opts.id}" (use lowercase letters, digits, hyphens)` };
  }
  const base = process.env.PREVAIL_APPS_DIR || join(homedir(), ".prevail", "apps");
  const root = join(base, id);
  if (existsSync(root)) return { ok: false, error: `app "${id}" already exists at ${root}` };
  // Map a connector pattern to the manifest integration vocabulary.
  const integ = opts.integration === "cli" ? "manual" : opts.integration; // cli runs as a skill, not an auth integration
  const domains = (opts.domains ?? []).filter(Boolean);
  try {
    mkdirSync(join(root, "skills"), { recursive: true });
    const manifest = {
      id,
      name: opts.title,
      description: `${opts.title} connector (scaffolded from the catalog).`,
      domains,
      integration: integ,
      connection: opts.connection ?? `Connect ${opts.title}, then this app syncs into ${domains.join(", ") || "its domains"}.`,
      // No auth_check / refresh yet: the user wires those when they connect.
    };
    writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(root, "SKILL.md"), `# ${opts.title}\n\n${manifest.connection}\n`);
    writeFileSync(join(root, "connection.md"), `# Connecting ${opts.title}\n\nIntegration: ${integ}\nDomains: ${domains.join(", ") || "(none yet)"}\n\nAdd an auth_check + refresh block to manifest.json and a skill under skills/ to enable syncing.\n`);
    writeFileSync(join(root, "connection-status.json"), JSON.stringify({ status: "not-configured" }, null, 2));
    return { ok: true, path: root };
  } catch (e) {
    return { ok: false, error: `scaffold failed: ${e}` };
  }
}
