import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import type { FrameworkId } from "./framework.ts";

export type CliKind = "claude" | "codex" | "gemini";

export const ALL_CLI_KINDS: readonly CliKind[] = ["claude", "codex", "gemini"];

export function isCliKind(s: string): s is CliKind {
  return s === "claude" || s === "codex" || s === "gemini";
}

export interface UserConfig {
  vaultPath: string;
  createdAt: string;
  // Global toggle: when "deny", the AGENTS-operating preamble injected into
  // every CLI launch explicitly forbids WebSearch / WebFetch / network tools.
  // Default (when missing) is "allow" — so existing configs keep working.
  webAccess?: "allow" | "deny";
  // /council panel — which CLIs participate (default: all detected) and which
  // models to run per CLI (default: each CLI's default). councilModels became
  // string[] in v0.3 so you can compare Claude Opus 4.7 vs 4.8 in the same
  // panel; pre-v0.3 single-string values are still read and auto-upgraded.
  councilClis?: CliKind[];
  councilModels?: Partial<Record<CliKind, string[] | string>>;
  // Optional chair pin: who synthesizes the verdict. null/missing = use
  // the first panelist that successfully replied (round-robin in practice).
  councilChair?: { cli: CliKind; model?: string };
  // Optional response framework — when set, prepended as an instruction to
  // every CLI prompt so the model structures its answer in that style
  // (BLUF, WIN, SCQA, etc). See src/framework.ts for the catalog.
  // Applies globally across all domains and both single-CLI + council mode.
  responseFramework?: FrameworkId;
}

export interface CouncilConfig {
  clis: CliKind[] | null; // null = use all detected
  // Per-CLI list of model variants to run as separate panelists. Empty list
  // (or empty string entry) means "use the CLI's default model once".
  models: Partial<Record<CliKind, string[]>>;
  chair: { cli: CliKind; model?: string } | null;
}

function normalizeModels(
  raw: Partial<Record<CliKind, string[] | string>> | undefined,
): Partial<Record<CliKind, string[]>> {
  if (!raw) return {};
  const out: Partial<Record<CliKind, string[]>> = {};
  for (const k of Object.keys(raw) as CliKind[]) {
    const v = raw[k];
    if (!v) continue;
    if (typeof v === "string") {
      out[k] = [v];
    } else if (Array.isArray(v) && v.length > 0) {
      out[k] = v;
    }
  }
  return out;
}

export function readCouncilConfig(): CouncilConfig {
  const c = readConfig();
  return {
    clis: c?.councilClis ?? null,
    models: normalizeModels(c?.councilModels),
    chair: c?.councilChair ?? null,
  };
}

// Pin who synthesizes the verdict. Pass null to clear (auto: first panelist
// that successfully returned a reply).
export function setCouncilChair(chair: { cli: CliKind; model?: string } | null): void {
  const cfg = readConfig();
  if (!cfg) return;
  const next = { ...cfg };
  if (chair === null) delete next.councilChair;
  else next.councilChair = chair;
  writeConfig(next);
}

export function setCouncilClis(clis: CliKind[] | null): void {
  const cfg = readConfig();
  if (!cfg) return;
  const next = { ...cfg };
  if (clis === null) delete next.councilClis;
  else next.councilClis = clis;
  writeConfig(next);
}

// Replace the entire model list for a CLI. Pass null or empty to clear (use
// that CLI's default). Used by /council model <cli> <name> (single-value
// replace, back-compat shape).
export function setCouncilModel(cli: CliKind, model: string | null): void {
  const cfg = readConfig();
  if (!cfg) return;
  const cur = normalizeModels(cfg.councilModels);
  if (model === null || model.trim() === "" || model.trim().toLowerCase() === "default") {
    delete cur[cli];
  } else {
    cur[cli] = [model.trim()];
  }
  writeCouncilModels(cfg, cur);
}

// Append a model variant to the CLI's list. No-op if already present.
export function addCouncilModel(cli: CliKind, model: string): void {
  const m = model.trim();
  if (!m || m.toLowerCase() === "default") return;
  const cfg = readConfig();
  if (!cfg) return;
  const cur = normalizeModels(cfg.councilModels);
  const list = cur[cli] ? [...cur[cli]!] : [];
  if (!list.includes(m)) list.push(m);
  cur[cli] = list;
  writeCouncilModels(cfg, cur);
}

// Remove a model variant from the CLI's list. If the list becomes empty,
// the entry is dropped so the CLI runs once with its default model.
export function removeCouncilModel(cli: CliKind, model: string): void {
  const m = model.trim();
  const cfg = readConfig();
  if (!cfg) return;
  const cur = normalizeModels(cfg.councilModels);
  const list = (cur[cli] ?? []).filter((x) => x !== m);
  if (list.length === 0) delete cur[cli];
  else cur[cli] = list;
  writeCouncilModels(cfg, cur);
}

function writeCouncilModels(
  cfg: UserConfig,
  models: Partial<Record<CliKind, string[]>>,
): void {
  const next: UserConfig = { ...cfg };
  if (Object.keys(models).length === 0) {
    delete next.councilModels;
  } else {
    next.councilModels = models;
  }
  writeConfig(next);
}

export function readWebAccess(): "allow" | "deny" {
  return readConfig()?.webAccess ?? "allow";
}

export function setWebAccess(mode: "allow" | "deny"): void {
  const cfg = readConfig();
  if (!cfg) return;
  writeConfig({ ...cfg, webAccess: mode });
}

export function readResponseFramework(): FrameworkId | null {
  return readConfig()?.responseFramework ?? null;
}

// Set the active response framework. Pass null to clear (model picks its
// own structure as before).
export function setResponseFramework(id: FrameworkId | null): void {
  const cfg = readConfig();
  if (!cfg) return;
  const next = { ...cfg };
  if (id === null) delete next.responseFramework;
  else next.responseFramework = id;
  writeConfig(next);
}

export function configDir(): string {
  return join(homedir(), ".prevail");
}

export function configFile(): string {
  return join(configDir(), "config.json");
}

export function readConfig(): UserConfig | null {
  const file = configFile();
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    return JSON.parse(raw) as UserConfig;
  } catch {
    return null;
  }
}

export function writeConfig(cfg: UserConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}

export function bundledDemoVaultPath(): string {
  // Resolve in priority order:
  // 1. ~/.prevail/vault-demo — where the installer drops it
  // 2. PREVAIL_DATA_DIR/vault-demo if env var is set
  // 3. next to the binary (unpacked tarball before install)
  // 4. relative to argv[1] (script-mode)
  // 5. relative to import.meta.url (source run via bun)
  // 6. cwd
  const candidates: string[] = [];
  candidates.push(join(homedir(), ".prevail", "vault-demo"));
  if (process.env.PREVAIL_DATA_DIR) {
    candidates.push(join(process.env.PREVAIL_DATA_DIR, "vault-demo"));
  }
  try {
    const execDir = dirname(process.execPath);
    candidates.push(resolve(execDir, "vault-demo"));
  } catch {}
  if (process.argv[1]) {
    try {
      candidates.push(resolve(dirname(process.argv[1]), "vault-demo"));
    } catch {}
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(resolve(here, "..", "vault-demo"));
    candidates.push(resolve(here, "vault-demo"));
  } catch {}
  candidates.push(resolve(process.cwd(), "vault-demo"));
  // First pass: prefer a candidate that actually contains apps/ — this
  // guards against an incomplete copy (e.g. dist/vault-demo from a stale
  // partial build) that exists but has no LIFE APPS to surface. Picking
  // such a path silently produces an empty Apps sidebar.
  for (const c of candidates) {
    if (existsSync(c) && existsSync(join(c, "apps"))) return c;
  }
  // Second pass: any path that exists, even incomplete. Better than
  // returning a non-existent fallback.
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

export interface VaultCandidate {
  kind: "demo" | "existing" | "ai-folder" | "current-dir" | "default-home";
  label: string;
  path: string;
  exists: boolean;
}

export function detectVaultCandidates(): VaultCandidate[] {
  const cwd = process.cwd();
  const home = homedir();
  const cwdVault = join(cwd, "vault");
  const aiVault = join(home, ".ai", "vault");
  const prevailVault = join(home, ".prevail", "vault");
  const demo = bundledDemoVaultPath();
  return [
    {
      kind: "demo",
      label: "bundled demo (Alex Rivera, synthetic — safe to explore)",
      path: demo,
      exists: existsSync(demo),
    },
    {
      kind: "ai-folder",
      label: "~/.ai/vault (existing Prevail-style folder)",
      path: aiVault,
      exists: existsSync(aiVault),
    },
    {
      kind: "current-dir",
      label: `./vault (relative to ${shorten(cwd)})`,
      path: cwdVault,
      exists: existsSync(cwdVault),
    },
    {
      kind: "default-home",
      label: "~/.prevail/vault (fresh start — scaffold 22 default domains)",
      path: prevailVault,
      exists: existsSync(prevailVault),
    },
  ];
}

function shorten(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
