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
  "chief",
  "complete",
  "core",
  "scripts",
  ".git",
  ".claude",
  ".claude-plugin",
  "node_modules",
]);

export function resolveDefaultVaultPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "..", "..", "fd-apps-aireadyu-life", "vault-demo");
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

  domains.sort((a, b) => a.name.localeCompare(b.name));
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
  // (<lifeRoot>/<domain>/skills/) for compatibility with the original AIReadyU structure.
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
      out.sort((a, b) => a.id.localeCompare(b.id));
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
  const file = join(domain.path, fileMap[view]);
  if (!existsSync(file)) {
    return `*No ${fileMap[view]} for ${domain.name}.*`;
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

export interface AppSkill {
  id: string;
  title: string;
  description: string;
  domains: string[];
  paths: string[];
  community?: boolean;
  manifestPath?: string;
}

export interface CommunityAppManifest {
  id: string;
  name?: string;
  description?: string;
  domains?: string[];
  version?: string;
  homepage?: string;
}

function communityAppsDirs(): string[] {
  const dirs: string[] = [];
  dirs.push(join(homedir(), ".aireadyu", "apps"));
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
      let manifest: CommunityAppManifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CommunityAppManifest;
      } catch {
        continue;
      }
      seen.add(e.name);
      out.push({
        id: manifest.id || e.name,
        title: manifest.name || e.name,
        description: (manifest.description || "").trim().slice(0, 240),
        domains: manifest.domains || [],
        paths: [skillPath],
        community: true,
        manifestPath,
      });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export function scanApps(vaultPath: string): AppSkill[] {
  if (!existsSync(vaultPath)) return [];
  const lifePath = resolve(vaultPath, "..");
  const out = new Map<string, AppSkill>();
  const entries = readdirSync(vaultPath, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (NON_DOMAIN_DIRS.has(e.name)) continue;
    const skillsRoot = [
      join(vaultPath, e.name, "skills"),
      join(lifePath, e.name, "skills"),
    ].find((p) => existsSync(p));
    if (!skillsRoot) continue;
    let skillDirs: import("node:fs").Dirent[] = [];
    try {
      skillDirs = readdirSync(skillsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of skillDirs) {
      if (!s.isDirectory()) continue;
      if (s.name.startsWith(`${e.name}-`)) continue;
      const skillFile = join(skillsRoot, s.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const existing = out.get(s.name);
      if (existing) {
        if (!existing.domains.includes(e.name)) existing.domains.push(e.name);
        existing.paths.push(skillFile);
      } else {
        out.set(s.name, {
          id: s.name,
          title: extractSkillTitle(skillFile, s.name),
          description: extractDescription(skillFile),
          domains: [e.name],
          paths: [skillFile],
        });
      }
    }
  }
  const sorted = Array.from(out.values());
  for (const app of sorted) app.domains.sort();
  sorted.sort((a, b) => a.id.localeCompare(b.id));
  return sorted;
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
  const primary = app.paths[0];
  if (!primary) return `*No SKILL.md for ${app.id}.*`;
  try {
    return readFileSync(primary, "utf8");
  } catch (err) {
    return `*Failed to read ${primary}: ${(err as Error).message}*`;
  }
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
