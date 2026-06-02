import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

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
}

const NON_DOMAIN_DIRS = new Set([
  "complete",
  "core",
  "scripts",
  ".git",
  ".claude",
  ".claude-plugin",
  "node_modules",
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
  "home",         // household
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

export function scanVault(vaultPath: string): Domain[] {
  if (!existsSync(vaultPath)) return [];
  const entries = readdirSync(vaultPath, { withFileTypes: true });
  const lifePath = resolve(vaultPath, "..");

  const domains: Domain[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (NON_DOMAIN_DIRS.has(entry.name)) continue;

    const domainPath = join(vaultPath, entry.name);
    const statePath = join(domainPath, "state.md");
    const loopsPath = join(domainPath, "open-loops.md");
    const hasState = existsSync(statePath);
    if (!hasState) continue;

    let openLoopCount = 0;
    try {
      const stateContent = readFileSync(statePath, "utf8");
      openLoopCount = countOpenItemsInState(stateContent);
    } catch {}
    if (openLoopCount === 0 && existsSync(loopsPath)) {
      try {
        const content = readFileSync(loopsPath, "utf8");
        openLoopCount = countUncheckedBoxes(content);
      } catch {}
    }

    let stateMtime: number | null = null;
    try {
      stateMtime = statSync(statePath).mtimeMs;
    } catch {}

    domains.push({
      name: entry.name,
      path: domainPath,
      hasState,
      openLoopCount,
      stateMtime,
      skills: scanSkills(lifePath, vaultPath, entry.name),
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
    const raw = readFileSync(skillFile, "utf8");
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
  const fileMap: Record<"state" | "quickstart" | "prompts", string> = {
    state: "state.md",
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
    return readFileSync(file, "utf8");
  } catch (err) {
    return `*Failed to read ${file}: ${(err as Error).message}*`;
  }
}

function readOpenItems(domain: Domain): string {
  const statePath = join(domain.path, "state.md");
  if (existsSync(statePath)) {
    try {
      const content = readFileSync(statePath, "utf8");
      const section = extractOpenItemsSection(content);
      if (section) return `# ${domain.name} — open items\n\n${section}`;
    } catch {}
  }
  const loopsPath = join(domain.path, "open-loops.md");
  if (existsSync(loopsPath)) {
    try {
      return readFileSync(loopsPath, "utf8");
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
  const statePath = join(domain.path, "state.md");
  let raw = "";
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {}
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
  dirs.push(join(homedir(), ".prevail", "apps"));
  try {
    dirs.push(resolve(dirname(process.execPath), "apps", "community"));
  } catch {}
  if (process.argv[1]) {
    try {
      dirs.push(resolve(dirname(process.argv[1]), "apps", "community"));
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
        manifestRaw = JSON.parse(readFileSync(manifestPath, "utf8"));
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
    try { notes = readFileSync(connectionMd, "utf8").trim(); } catch {}
  }
  let status: ConnectorStatus = "not-configured";
  let lastSuccessTs: number | null = null;
  let lastError: string | undefined;
  const statusJson = join(root, "connection-status.json");
  if (existsSync(statusJson)) {
    try {
      const raw = JSON.parse(readFileSync(statusJson, "utf8"));
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
        const content = readFileSync(statePath, "utf8");
        stateMtime = statSync(statePath).mtimeMs;
        openLoopCount = countOpenItemsInState(content);
      } catch {}
    }
    if (openLoopCount === 0 && existsSync(loopsPath)) {
      try {
        const content = readFileSync(loopsPath, "utf8");
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
      const content = readFileSync(statePath, "utf8");
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
    const content = readFileSync(statePath, "utf8");
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
    const content = readFileSync(statePath, "utf8");
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
    const raw = readFileSync(skillFile, "utf8");
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
      return readFileSync(skillPath, "utf8");
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
    return readFileSync(file, "utf8");
  } catch (err) {
    return `*Failed to read ${file}: ${(err as Error).message}*`;
  }
}

function readAppOpenItems(app: AppSkill): string {
  const statePath = join(app.path, "state.md");
  if (existsSync(statePath)) {
    try {
      const content = readFileSync(statePath, "utf8");
      const section = extractOpenItemsSection(content);
      if (section) return `# ${app.id} — open items\n\n${section}`;
    } catch {}
  }
  const loopsPath = join(app.path, "open-loops.md");
  if (existsSync(loopsPath)) {
    try {
      return readFileSync(loopsPath, "utf8");
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
    raw = readFileSync(statePath, "utf8");
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
