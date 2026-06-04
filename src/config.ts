import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import type { FrameworkId } from "./framework.ts";
import type { LensSelection } from "./lens.ts";

export type CliKind = "claude" | "codex" | "gemini" | "ollama";

export const ALL_CLI_KINDS: readonly CliKind[] = ["claude", "codex", "gemini", "ollama"];

export function isCliKind(s: string): s is CliKind {
  return s === "claude" || s === "codex" || s === "gemini" || s === "ollama";
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
  // Per-domain framework overrides. When a key matches the active domain
  // name, this wins over the global responseFramework. Keyed by the raw
  // domain basename (same value as `Domain.name`). Cycling the chip on a
  // domain workspace only mutates this map for that domain; cycling the
  // chip on the top status column still mutates the global default.
  domainFrameworks?: Record<string, FrameworkId>;
  // Optional cognitive lens. Same resolution rules as framework — global
  // default + per-domain overrides — but the semantics are different:
  // when set to "all", the council runner fans every panelist across
  // every lens (4 CLIs × 5 lenses = 20 calls per question). Specific id
  // applies just that lens to every panelist (no fanout). null = off.
  // Lens only fires in council mode; single chat ignores it (would
  // require a single-CLI fanout, which is a follow-up).
  responseLens?: LensSelection;
  domainLenses?: Record<string, LensSelection>;
  // Global council default. When a chat session has no explicit per-key
  // setting, this is the fallback. Per-chat overrides still win when set.
  councilDefaultOn?: boolean;
  // Checkpointing — when true, every chat turn (prompt + reply) is
  // appended verbatim to <domain>/_log/YYYY-MM-DD.md. Default ON: the
  // user wants every interaction saved for future reference. Read via
  // readCheckpoint(domainKey?) so a per-domain override (rare — most
  // users want everything saved) can disable a noisy domain without
  // touching the global.
  checkpoint?: boolean;
  domainCheckpoint?: Record<string, boolean>;
  // Serendipity injection — when on, every chat turn fires a second
  // lightweight call after the main reply to surface one non-obvious
  // adjacent angle, fact, or question the user didn't ask but might
  // value. Off by default (the user opts in domain-by-domain or
  // globally). Per-domain override available.
  serendipity?: boolean;
  domainSerendipity?: Record<string, boolean>;
  // Auto-council detection. When set to "suggest" (default), every chat
  // turn sent in non-council mode also fires a tiny classifier in
  // parallel; if it judges the prompt council-worthy, a passive
  // suggestion bubble appears in the transcript. "auto" upgrades that
  // to silently routing through runCouncil instead. "off" disables.
  autoCouncil?: "off" | "suggest" | "auto";
  domainAutoCouncil?: Record<string, "off" | "suggest" | "auto">;
  // Hard cap on the number of CLI calls a single /council turn can fire.
  // panelists × lens fanout count must be <= this number, or the turn
  // refuses with a friendly error. Default 16 — covers 4 CLIs × 4 lenses,
  // a typical heavy turn. Set higher if you want full 4 × 8 = 32 lens
  // fanouts. Set to 1 to effectively disable council fanout.
  councilMaxCallsPerTurn?: number;
}

// Default hard cap on /council calls per turn. Lives at the top so the
// readCouncilMaxCallsPerTurn helper and any callers that want to label
// the default (UI hints, error messages) read from one constant.
export const DEFAULT_COUNCIL_MAX_CALLS_PER_TURN = 16;

export function readCouncilMaxCallsPerTurn(): number {
  const cfg = readConfig();
  const raw = cfg?.councilMaxCallsPerTurn;
  // Guard against junk values in the JSON (negative, zero, NaN, non-int).
  // Anything invalid falls back to the default rather than silently
  // disabling the cap or producing an off-by-one.
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    return DEFAULT_COUNCIL_MAX_CALLS_PER_TURN;
  }
  return Math.floor(raw);
}

export function setCouncilMaxCallsPerTurn(n: number): void {
  const cfg = readConfig();
  if (!cfg) return;
  const next = { ...cfg };
  if (!Number.isFinite(n) || n < 1) {
    delete next.councilMaxCallsPerTurn;
  } else {
    next.councilMaxCallsPerTurn = Math.floor(n);
  }
  writeConfig(next);
}

export function readGlobalCouncilDefault(): boolean {
  return readConfig()?.councilDefaultOn ?? false;
}

export function setGlobalCouncilDefault(on: boolean): void {
  const cfg = readConfig();
  if (!cfg) return;
  writeConfig({ ...cfg, councilDefaultOn: on });
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

// Read the effective framework for a given scope.
//   - readResponseFramework()              → global default
//   - readResponseFramework("wealth")      → domain override if set, else
//                                            falls through to the global
//                                            default, else null
export function readResponseFramework(domainKey?: string): FrameworkId | null {
  const cfg = readConfig();
  if (!cfg) return null;
  if (domainKey) {
    const override = cfg.domainFrameworks?.[domainKey];
    if (override) return override;
  }
  return cfg.responseFramework ?? null;
}

// Resolve the framework AND its scope so the UI can label the chip with
// "global" / "domain" / "none". Resolution rules match readResponseFramework.
export function resolveResponseFramework(
  domainKey?: string,
): { id: FrameworkId | null; scope: "domain" | "global" | "none" } {
  const cfg = readConfig();
  if (!cfg) return { id: null, scope: "none" };
  if (domainKey) {
    const override = cfg.domainFrameworks?.[domainKey];
    if (override) return { id: override, scope: "domain" };
  }
  const g = cfg.responseFramework ?? null;
  return g ? { id: g, scope: "global" } : { id: null, scope: "none" };
}

// Set the framework. Pass null to clear.
//   - setResponseFramework(id)            → writes the global default
//   - setResponseFramework(id, "wealth")  → writes/clears the domain override.
//                                           Clearing (id === null) falls the
//                                           domain back to the global default.
export function setResponseFramework(
  id: FrameworkId | null,
  domainKey?: string,
): void {
  const cfg = readConfig();
  if (!cfg) return;
  const next = { ...cfg };
  if (domainKey) {
    const map = { ...(next.domainFrameworks ?? {}) };
    if (id === null) delete map[domainKey];
    else map[domainKey] = id;
    if (Object.keys(map).length === 0) delete next.domainFrameworks;
    else next.domainFrameworks = map;
  } else {
    if (id === null) delete next.responseFramework;
    else next.responseFramework = id;
  }
  writeConfig(next);
}

// Lens accessors — mirror the framework helpers above. Same resolution
// order: per-domain override wins, global is fallback, null = off.
export function readResponseLens(domainKey?: string): LensSelection {
  const cfg = readConfig();
  if (!cfg) return null;
  if (domainKey) {
    const override = cfg.domainLenses?.[domainKey];
    if (override !== undefined) return override;
  }
  return cfg.responseLens ?? null;
}

export function resolveResponseLens(
  domainKey?: string,
): { sel: LensSelection; scope: "domain" | "global" | "none" } {
  const cfg = readConfig();
  if (!cfg) return { sel: null, scope: "none" };
  if (domainKey) {
    const override = cfg.domainLenses?.[domainKey];
    if (override !== undefined) return { sel: override, scope: "domain" };
  }
  const g = cfg.responseLens ?? null;
  return g ? { sel: g, scope: "global" } : { sel: null, scope: "none" };
}

export function setResponseLens(
  sel: LensSelection,
  domainKey?: string,
): void {
  const cfg = readConfig();
  if (!cfg) return;
  const next = { ...cfg };
  if (domainKey) {
    const map = { ...(next.domainLenses ?? {}) };
    if (sel === null) delete map[domainKey];
    else map[domainKey] = sel;
    if (Object.keys(map).length === 0) delete next.domainLenses;
    else next.domainLenses = map;
  } else {
    if (sel === null) delete next.responseLens;
    else next.responseLens = sel;
  }
  writeConfig(next);
}

// Checkpoint resolution — global default is ON because the user
// explicitly asked for every interaction to be logged. Per-domain
// override flips a single domain without touching the global.
export function readCheckpoint(domainKey?: string): boolean {
  const cfg = readConfig();
  if (!cfg) return true;
  if (domainKey) {
    const override = cfg.domainCheckpoint?.[domainKey];
    if (override !== undefined) return override;
  }
  return cfg.checkpoint ?? true;
}

export function setCheckpoint(on: boolean, domainKey?: string): void {
  const cfg = readConfig();
  if (!cfg) return;
  const next = { ...cfg };
  if (domainKey) {
    const map = { ...(next.domainCheckpoint ?? {}) };
    map[domainKey] = on;
    next.domainCheckpoint = map;
  } else {
    next.checkpoint = on;
  }
  writeConfig(next);
}

// Serendipity — same shape as checkpoint, but OFF by default (this is
// an opt-in injection; the user picks where it adds signal).
export function readSerendipity(domainKey?: string): boolean {
  const cfg = readConfig();
  if (!cfg) return false;
  if (domainKey) {
    const override = cfg.domainSerendipity?.[domainKey];
    if (override !== undefined) return override;
  }
  return cfg.serendipity ?? false;
}

export function setSerendipity(on: boolean, domainKey?: string): void {
  const cfg = readConfig();
  if (!cfg) return;
  const next = { ...cfg };
  if (domainKey) {
    const map = { ...(next.domainSerendipity ?? {}) };
    map[domainKey] = on;
    next.domainSerendipity = map;
  } else {
    next.serendipity = on;
  }
  writeConfig(next);
}

// Auto-council mode resolution. Default "suggest" — the user gets a
// passive hint without surprise behavior.
export type AutoCouncilMode = "off" | "suggest" | "auto";

export function readAutoCouncil(domainKey?: string): AutoCouncilMode {
  const cfg = readConfig();
  if (!cfg) return "suggest";
  if (domainKey) {
    const override = cfg.domainAutoCouncil?.[domainKey];
    if (override) return override;
  }
  return cfg.autoCouncil ?? "suggest";
}

export function setAutoCouncil(mode: AutoCouncilMode, domainKey?: string): void {
  const cfg = readConfig();
  if (!cfg) return;
  const next = { ...cfg };
  if (domainKey) {
    const map = { ...(next.domainAutoCouncil ?? {}) };
    map[domainKey] = mode;
    next.domainAutoCouncil = map;
  } else {
    next.autoCouncil = mode;
  }
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
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
  const file = configFile();
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  // SECURITY: config holds the vault path + saved chair / model pins. Not
  // as sensitive as telegram.json or sessions.db, but still cheap to lock
  // down to owner-only access.
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
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
  // "custom" is a placeholder pseudo-candidate that, when picked in the
  // wizard, swaps the list view for an inline path-input box. The path
  // field is empty for "custom" — the user types it.
  kind: "demo" | "existing" | "ai-folder" | "current-dir" | "default-home" | "custom";
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
    {
      // Sentinel option — selecting this in the wizard opens an inline
      // path-input box. The path field is empty; the wizard fills it in
      // from what the user types.
      kind: "custom",
      label: "type a custom path (existing folder or new — will scaffold if empty)",
      path: "",
      exists: false,
    },
  ];
}

function shorten(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
