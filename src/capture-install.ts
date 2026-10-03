import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import { KNOWN_TOOLS, type KnownTool } from "./capture.ts";
import { validateVaultPath } from "./path-safety.ts";
// prevailInvocation: the prevail binary this process IS, so installed hooks and
// agents re-invoke the same code.
import { escapeXml, prevailInvocation } from "./heartbeat.ts";

// =============================================================================
// `prevail capture install` - wire prompt capture into every harness, in one
// shot, mirroring `heartbeat.ts`'s launchd idiom.
//
// Two mechanisms, because not every CLI exposes a per-prompt hook:
//
//   PUSH  - a harness with a real submit hook (Claude Code's UserPromptSubmit)
//           gets a one-line command merged into its config that pipes each
//           prompt to `prevail capture --tool <t>`. Instant capture.
//   SYNC  - everything else is covered by the launchd backstop, which runs
//           `prevail capture sync` on an interval to scrape native transcript
//           dirs. (The sync command itself lands in the next increment; the
//           agent is installed now, SAFE/disabled, exactly like heartbeat.)
//
// SAFE BY DEFAULT. The launchd plist is written with RunAtLoad:false and is
// never `launchctl load`ed automatically - the operator enables it. Hook
// wiring is idempotent: re-running install updates the existing entry in place
// rather than stacking duplicates, and never touches unrelated config.
// =============================================================================

/** launchd label / plist basename - sibling of sh.prevail.heartbeat. */
export const CAPTURE_LABEL = "sh.prevail.capture";

/** How often the sync backstop runs, in seconds (30 min). */
const SYNC_INTERVAL_SEC = 1800;

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${CAPTURE_LABEL}.plist`);
}

/** Shell-quote a single argument (single-quote wrap, escape embedded quotes). */
function shQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The shell command string a push hook runs for a given tool. The harness
 *  pipes its payload to stdin; `prevail capture` parses it. Carries a stable
 *  `capture --tool <slug>` marker we detect for idempotent re-wiring. */
export function captureHookCommand(slug: string): string {
  return [...prevailInvocation(), "capture", "--tool", slug].map(shQuote).join(" ");
}

// -----------------------------------------------------------------------------
// launchd agent - the sync backstop. RunAtLoad:false → SAFE / disabled.
// -----------------------------------------------------------------------------

/** Where the sync agent logs: beside the other Prevail agents, not in a vault. */
export function captureLogPath(): string {
  return join(homedir(), "Library", "Logs", "prevail-capture.log");
}

// No --vault: each run resolves the vault from config.json, like the push hooks
// do. A pinned path kept syncing into a demo vault long after the switch to the
// real one, so a month of prompts landed where nothing reads them.
export function renderPlist(): string {
  const argv = [...prevailInvocation(), "capture", "sync"];
  const programArgs = argv.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  const logOut = captureLogPath();
  const logErr = captureLogPath();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(CAPTURE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>StartInterval</key>
  <integer>${SYNC_INTERVAL_SEC}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(logOut)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logErr)}</string>
</dict>
</plist>
`;
}

export interface AgentResult {
  installed: boolean;
  plist: string;
  unsupported?: boolean;
  error?: string;
}

export function isAgentLoaded(): boolean {
  if (platform() !== "darwin") return false;
  try {
    return spawnSync("launchctl", ["list", CAPTURE_LABEL], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Write the launchd plist. SAFE: never loads it for the first time (the
 *  operator enables it), but an agent that is already loaded is reloaded so a
 *  re-install takes effect instead of launchd running the stale copy. */
export function installAgent(): AgentResult {
  const file = plistPath();
  if (platform() !== "darwin") {
    return { installed: false, plist: file, unsupported: true, error: "launchd is macOS-only" };
  }
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, renderPlist());
    try {
      chmodSync(file, 0o644);
    } catch {
      /* best effort */
    }
    if (isAgentLoaded()) {
      const domain = `gui/${process.getuid?.() ?? 501}`;
      spawnSync("launchctl", ["bootout", `${domain}/${CAPTURE_LABEL}`], { stdio: "ignore" });
      spawnSync("launchctl", ["bootstrap", domain, file], { stdio: "ignore" });
    }
  } catch (err) {
    return { installed: false, plist: file, error: (err as Error).message };
  }
  return { installed: true, plist: file };
}

export function uninstallAgent(): AgentResult {
  const file = plistPath();
  if (platform() === "darwin" && isAgentLoaded()) {
    try {
      spawnSync("launchctl", ["unload", file], { stdio: "ignore" });
    } catch {
      /* best effort */
    }
  }
  if (!existsSync(file)) return { installed: false, plist: file };
  try {
    unlinkSync(file);
  } catch (err) {
    return { installed: false, plist: file, error: (err as Error).message };
  }
  return { installed: false, plist: file };
}

// -----------------------------------------------------------------------------
// Push hooks - a UserPromptSubmit entry in Claude Code's ~/.claude/settings.json
// and Codex's ~/.codex/hooks.json. Both files nest the same shape:
// { hooks: { UserPromptSubmit: [ { hooks: [ {type, command, timeout} ] } ] } }.
// -----------------------------------------------------------------------------

export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export function codexHooksPath(): string {
  return join(homedir(), ".codex", "hooks.json");
}

/** The push-hooked harnesses: config file and the folder that proves it is installed. */
export const PUSH_TOOLS: Record<string, { file: () => string; home: () => string; name: string }> = {
  claude: { file: claudeSettingsPath, home: () => join(homedir(), ".claude"), name: "Claude Code" },
  codex: { file: codexHooksPath, home: () => join(homedir(), ".codex"), name: "Codex" },
};

type HookEntry = { type?: string; command?: string; timeout?: number; [k: string]: unknown };
type HookGroup = { hooks?: HookEntry[]; [k: string]: unknown };

export interface HookWireResult {
  tool: string;
  method: "push" | "sync";
  present: boolean;
  wired: boolean;
  target?: string;
  /** Absolute path of the native transcript dir/file this harness is read from
   *  (where its prompts originate), so the UI can reveal it. Undefined for tools
   *  with no readable source on disk. */
  source?: string;
  action?: "added" | "updated" | "removed" | "noop";
  detail?: string;
  error?: string;
}

/** Where a harness's prompts originate on disk - the native transcript the sync
 *  backstop scrapes (and, for Claude Code, what the live hook mirrors). Kept in
 *  step with the readers in capture-sync.ts. Undefined => no on-disk source. */
export function captureSourcePath(slug: string, transcript?: string): string | undefined {
  const home = homedir();
  switch (slug) {
    case "antigravity":
      return join(home, ".gemini", "antigravity-cli", "history.jsonl");
    case "opencode":
      return join(home, ".local", "share", "opencode", "opencode.db");
    case "prevail":
      return join(home, ".prevail", "sessions.db");
    case "hermes":
      return join(home, ".hermes", "state.db");
    default:
      return transcript ? join(home, transcript) : undefined;
  }
}

const marker = (tool: string) => `capture --tool ${tool}`;

/** Does this hooks file already carry our capture hook for `tool`? */
export function promptHookWired(tool: string, file = PUSH_TOOLS[tool]?.file()): boolean {
  if (!file || !existsSync(file)) return false;
  try {
    return readFileSync(file, "utf8").includes(marker(tool));
  } catch {
    return false;
  }
}

/** Idempotently merge (or refresh) the prevail capture hook into a harness's
 *  UserPromptSubmit list, preserving every other hook and key. `file` and
 *  `present` are injectable for tests. */
export function wirePromptHook(
  tool: string,
  file = PUSH_TOOLS[tool].file(),
  present = existsSync(PUSH_TOOLS[tool].home()),
): HookWireResult {
  const base: HookWireResult = { tool, method: "push", present, target: file, wired: false };
  if (!present) {
    return { ...base, action: "noop", detail: `${PUSH_TOOLS[tool]?.name ?? tool} not installed` };
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (err) {
      return { ...base, error: `${file} is not valid JSON: ${(err as Error).message}` };
    }
  }

  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  const list = (hooks.UserPromptSubmit ??= []) as HookGroup[];
  const entry: HookEntry = { type: "command", command: captureHookCommand(tool), timeout: 10 };

  // Find an existing prevail-capture entry by its stable marker and replace its
  // command (the exec path may have changed, e.g. app moved to /Applications).
  let action: "added" | "updated" = "added";
  for (const group of list) {
    const inner = Array.isArray(group?.hooks) ? group.hooks : [];
    for (let i = 0; i < inner.length; i++) {
      if (typeof inner[i]?.command === "string" && inner[i].command!.includes(marker(tool))) {
        inner[i] = entry;
        action = "updated";
      }
    }
  }
  if (action === "added") list.push({ hooks: [entry] });

  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
  return { ...base, wired: true, action };
}

/** Remove the prevail capture hook from a harness's hooks file. */
export function unwirePromptHook(tool: string, file = PUSH_TOOLS[tool].file()): HookWireResult {
  const base: HookWireResult = {
    tool,
    method: "push",
    present: existsSync(PUSH_TOOLS[tool]?.home() ?? file),
    target: file,
    wired: false,
  };
  if (!existsSync(file)) return { ...base, action: "noop" };
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return { ...base, action: "noop", detail: `${file} unparseable; left untouched` };
  }
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const list = hooks?.UserPromptSubmit as HookGroup[] | undefined;
  if (!Array.isArray(list)) return { ...base, action: "noop" };
  let removed = false;
  const kept = list.filter((group) => {
    const inner = Array.isArray(group?.hooks) ? group.hooks : [];
    const isOurs = inner.some((h) => typeof h?.command === "string" && h.command.includes(marker(tool)));
    if (isOurs) removed = true;
    return !isOurs;
  });
  (hooks as Record<string, unknown>).UserPromptSubmit = kept;
  try {
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
  return { ...base, action: removed ? "removed" : "noop" };
}

/** Kept for callers of the Claude-only API. */
export const wireClaudeHook = (): HookWireResult => wirePromptHook("claude");
export const unwireClaudeHook = (): HookWireResult => unwirePromptHook("claude");

// -----------------------------------------------------------------------------
// Harness roster - which tools get PUSH vs SYNC, plus light presence detection.
// -----------------------------------------------------------------------------

const KNOWN_BIN_DIRS = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".bun", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
];

const BIN_FOR_SLUG: Record<string, string> = {
  codex: "codex",
  gemini: "gemini",
  antigravity: "agy",
  opencode: "opencode",
  openclaw: "openclaw",
  hermes: "hermes",
  pi: "pi",
};

function binAvailable(bin: string): boolean {
  return KNOWN_BIN_DIRS.some((d) => existsSync(join(d, bin)));
}

/** Report a SYNC-covered harness (no push hook wired this increment). */
function syncHarness(t: KnownTool): HookWireResult {
  if (t.slug === "hermes") {
    return {
      tool: "hermes",
      method: "sync",
      present: binAvailable("hermes") || existsSync(captureSourcePath("hermes")!),
      wired: false,
      source: captureSourcePath("hermes"),
      detail: "Hermes keeps sessions in ~/.hermes/state.db; no reader yet",
    };
  }
  if (t.slug === "prevail") {
    return {
      tool: "prevail",
      method: "sync",
      present: existsSync(join(homedir(), ".prevail")),
      wired: false,
      source: captureSourcePath("prevail"),
      detail: "cockpit prompts exported from sessions.db by `capture sync`",
    };
  }
  const bin = BIN_FOR_SLUG[t.slug];
  return {
    tool: t.slug,
    method: "sync",
    present: bin ? binAvailable(bin) : false,
    wired: false,
    source: captureSourcePath(t.slug, t.transcript),
    detail: t.transcript
      ? `captured from ~/${t.transcript} by the sync backstop`
      : "captured by the sync backstop",
  };
}

// -----------------------------------------------------------------------------
// install / uninstall / status - the orchestrators the CLI calls.
// -----------------------------------------------------------------------------

export interface CaptureInstallResult {
  ok: boolean;
  agent: AgentResult;
  harnesses: HookWireResult[];
  error?: string;
}

export function install(vaultPath: string): CaptureInstallResult {
  const v = validateVaultPath(vaultPath);
  if (!v.ok) {
    return {
      ok: false,
      agent: { installed: false, plist: plistPath(), error: v.reason },
      harnesses: [],
      error: v.reason,
    };
  }
  const agent = installAgent();
  const harnesses: HookWireResult[] = [];
  // PUSH: the harnesses with a real submit hook. Each is also read by sync.
  for (const tool of Object.keys(PUSH_TOOLS)) harnesses.push(wirePromptHook(tool));
  // SYNC: everything else, reported so the UI/operator sees full coverage.
  for (const t of KNOWN_TOOLS) {
    if (t.slug in PUSH_TOOLS) continue;
    harnesses.push(syncHarness(t));
  }
  // Success when the platform supported the agent AND no harness hard-errored.
  const hookError = harnesses.some((h) => h.error);
  const ok = (agent.installed || !!agent.unsupported) && !hookError;
  return { ok, agent, harnesses };
}

export function uninstall(_vaultPath: string): CaptureInstallResult {
  const agent = uninstallAgent();
  const harnesses = Object.keys(PUSH_TOOLS).map((tool) => unwirePromptHook(tool));
  return { ok: !agent.error && !harnesses.some((h) => h.error), agent, harnesses };
}

export interface CaptureInstallStatus {
  ok: true;
  agent: { plistPresent: boolean; loaded: boolean; supported: boolean; plist: string };
  harnesses: HookWireResult[];
}

/** Report current wiring without changing anything (pure read). */
export function status(_vaultPath: string): CaptureInstallStatus {
  const plist = plistPath();
  const harnesses: HookWireResult[] = [];
  for (const t of KNOWN_TOOLS) {
    const push = PUSH_TOOLS[t.slug];
    if (!push) {
      harnesses.push(syncHarness(t));
      continue;
    }
    const present = existsSync(push.home());
    harnesses.push({
      tool: t.slug,
      method: "push",
      present,
      wired: present && promptHookWired(t.slug),
      target: push.file(),
      source: captureSourcePath(t.slug, t.transcript),
    });
  }
  return {
    ok: true,
    agent: {
      plistPresent: existsSync(plist),
      loaded: isAgentLoaded(),
      supported: platform() === "darwin",
      plist,
    },
    harnesses,
  };
}

// -----------------------------------------------------------------------------
// JSON handlers (ENGINE-JSON-API style) - the CLI command layer prints these.
// -----------------------------------------------------------------------------

export function handleInstall(vaultPath: string): CaptureInstallResult {
  return install(vaultPath);
}

export function handleUninstall(vaultPath: string): CaptureInstallResult {
  return uninstall(vaultPath);
}

export function handleStatus(vaultPath: string): CaptureInstallStatus {
  return status(vaultPath);
}
