import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import { KNOWN_TOOLS, type KnownTool } from "./capture.ts";
import { runtimePath, validateVaultPath } from "./path-safety.ts";

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

/** Best-effort resolution of the prevail binary this process IS, so installed
 *  hooks/agents re-invoke the same code. Mirrors heartbeat.ts:prevailInvocation.
 *  Compiled binary → [execPath]; running from source via bun → [bun, script]. */
function prevailInvocation(): string[] {
  const exec = process.execPath;
  if (process.argv[1] && /\b(bun|node)$/.test(exec)) return [exec, process.argv[1]];
  if (exec && existsSync(exec)) return [exec];
  return ["prevail"];
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

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// -----------------------------------------------------------------------------
// launchd agent - the sync backstop. RunAtLoad:false → SAFE / disabled.
// -----------------------------------------------------------------------------

export function renderPlist(vaultPath: string): string {
  const argv = [...prevailInvocation(), "capture", "sync", "--vault", vaultPath];
  const programArgs = argv.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  const logOut = join(runtimePath(vaultPath, "_log"), "capture.out.log");
  const logErr = join(runtimePath(vaultPath, "_log"), "capture.err.log");
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

/** Write (not load) the launchd plist. SAFE: operator enables explicitly. */
export function installAgent(vaultPath: string): AgentResult {
  const file = plistPath();
  if (platform() !== "darwin") {
    return { installed: false, plist: file, unsupported: true, error: "launchd is macOS-only" };
  }
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, renderPlist(vaultPath));
    try {
      chmodSync(file, 0o644);
    } catch {
      /* best effort */
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
// Claude Code push hook - merge a UserPromptSubmit entry into ~/.claude/settings.json
// -----------------------------------------------------------------------------

export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** Is Claude Code present on this machine? Its config dir is the reliable tell. */
function claudePresent(): boolean {
  return existsSync(join(homedir(), ".claude"));
}

type HookEntry = { type?: string; command?: string; timeout?: number; [k: string]: unknown };
type HookGroup = { hooks?: HookEntry[]; [k: string]: unknown };

export interface HookWireResult {
  tool: string;
  method: "push" | "sync";
  present: boolean;
  wired: boolean;
  target?: string;
  action?: "added" | "updated" | "removed" | "noop";
  detail?: string;
  error?: string;
}

/** Idempotently merge (or refresh) the prevail capture hook into Claude Code's
 *  settings.json UserPromptSubmit list, preserving every other hook and key. */
export function wireClaudeHook(): HookWireResult {
  const target = claudeSettingsPath();
  const base: HookWireResult = {
    tool: "claude",
    method: "push",
    present: claudePresent(),
    target,
    wired: false,
  };
  if (!base.present) {
    return {
      ...base,
      wired: false,
      action: "noop",
      detail: "Claude Code not installed (~/.claude absent)",
    };
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(target)) {
    try {
      settings = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
    } catch (err) {
      return {
        ...base,
        wired: false,
        error: `settings.json is not valid JSON: ${(err as Error).message}`,
      };
    }
  }

  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  const list = (hooks.UserPromptSubmit ??= []) as HookGroup[];
  const command = captureHookCommand("claude");
  const entry: HookEntry = { type: "command", command, timeout: 10 };

  // Find an existing prevail-capture group by its stable marker and replace its
  // command (the exec path may have changed, e.g. app moved to /Applications).
  let action: "added" | "updated" = "added";
  let found = false;
  for (const group of list) {
    const inner = Array.isArray(group?.hooks) ? group.hooks : [];
    for (let i = 0; i < inner.length; i++) {
      if (
        typeof inner[i]?.command === "string" &&
        inner[i].command!.includes("capture --tool claude")
      ) {
        inner[i] = entry;
        found = true;
        action = "updated";
      }
    }
  }
  if (!found) list.push({ hooks: [entry] });

  try {
    const dir = dirname(target);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch (err) {
    return { ...base, wired: false, error: (err as Error).message };
  }
  return { ...base, wired: true, action };
}

/** Remove the prevail capture hook from Claude Code's settings.json. */
export function unwireClaudeHook(): HookWireResult {
  const target = claudeSettingsPath();
  const base: HookWireResult = {
    tool: "claude",
    method: "push",
    present: claudePresent(),
    target,
    wired: false,
  };
  if (!existsSync(target)) return { ...base, wired: false, action: "noop" };
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
  } catch {
    return {
      ...base,
      wired: false,
      action: "noop",
      detail: "settings.json unparseable; left untouched",
    };
  }
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const list = hooks?.UserPromptSubmit as HookGroup[] | undefined;
  if (!Array.isArray(list)) return { ...base, wired: false, action: "noop" };
  let removed = false;
  const kept = list.filter((group) => {
    const inner = Array.isArray(group?.hooks) ? group.hooks : [];
    const isOurs = inner.some(
      (h) => typeof h?.command === "string" && h.command.includes("capture --tool claude"),
    );
    if (isOurs) removed = true;
    return !isOurs;
  });
  (hooks as Record<string, unknown>).UserPromptSubmit = kept;
  try {
    writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch (err) {
    return { ...base, wired: false, error: (err as Error).message };
  }
  return { ...base, wired: false, action: removed ? "removed" : "noop" };
}

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
  if (t.slug === "prevail") {
    return {
      tool: "prevail",
      method: "sync",
      present: existsSync(join(homedir(), ".prevail")),
      wired: false,
      detail: "cockpit prompts exported from sessions.db by `capture sync`",
    };
  }
  const bin = BIN_FOR_SLUG[t.slug];
  return {
    tool: t.slug,
    method: "sync",
    present: bin ? binAvailable(bin) : false,
    wired: false,
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
  const agent = installAgent(vaultPath);
  const harnesses: HookWireResult[] = [];
  // PUSH: Claude Code (the one mature submit hook).
  harnesses.push(wireClaudeHook());
  // SYNC: everything else, reported so the UI/operator sees full coverage.
  for (const t of KNOWN_TOOLS) {
    if (t.slug === "claude") continue;
    harnesses.push(syncHarness(t));
  }
  // Success when the platform supported the agent AND no harness hard-errored.
  const hookError = harnesses.some((h) => h.error);
  const ok = (agent.installed || !!agent.unsupported) && !hookError;
  return { ok, agent, harnesses };
}

export function uninstall(_vaultPath: string): CaptureInstallResult {
  const agent = uninstallAgent();
  const harnesses = [unwireClaudeHook()];
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
  const claudeWired =
    claudePresent() &&
    existsSync(claudeSettingsPath()) &&
    (() => {
      try {
        return readFileSync(claudeSettingsPath(), "utf8").includes("capture --tool claude");
      } catch {
        return false;
      }
    })();
  const harnesses: HookWireResult[] = [
    {
      tool: "claude",
      method: "push",
      present: claudePresent(),
      wired: claudeWired,
      target: claudeSettingsPath(),
    },
  ];
  for (const t of KNOWN_TOOLS) {
    if (t.slug === "claude") continue;
    harnesses.push(syncHarness(t));
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
