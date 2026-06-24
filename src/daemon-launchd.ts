// launchd agent installer for the headless daemons. Writes LaunchAgent plists
// that run at login and stay alive, so Prevail keeps WORKING with the desktop
// app closed: self-learning (--learn), domain loops (--loops), and app sync
// (--sync). One agent per daemon (each is a single forever-loop), all toggled
// together by the desktop's "keep working when closed" switch.

import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// The learn agent keeps its original label so existing status checks + the
// in-app distiller's "defer when installed" guard keep working unchanged.
const LABEL = "sh.prevail.learn";
type AgentDef = { label: string; flag: string; env?: Record<string, string>; runAtLoad?: boolean };
const AGENTS: AgentDef[] = [
  { label: LABEL, flag: "--learn", env: { PREVAIL_HEADLESS_LEARN: "1" } },
  // Decision: the acting loops daemon does NOT auto-start at login (RunAtLoad
  // false) — consequential autonomy is opt-in, started explicitly. learn/sync
  // are background-safe and keep RunAtLoad true.
  { label: "sh.prevail.loops", flag: "--loops", runAtLoad: false },
  { label: "sh.prevail.sync", flag: "--sync" },
];

function plistPathFor(label: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}
function plistPath(): string {
  return plistPathFor(LABEL);
}

// Resolve the absolute path to this engine binary so the agent can launch it
// after the installing process exits. Prefer the running executable.
function enginePath(): string {
  // Bun/Node: process.execPath is the runtime; for a packaged single-file
  // `prevail` binary that IS the engine. argv[1] is the script when run via a
  // runtime. Prefer execPath when it looks like a prevail binary, else argv.
  const exec = process.execPath;
  if (exec && /prevail/i.test(exec)) return exec;
  // Fall back to `prevail` on PATH (the desktop passes an absolute path in).
  return process.env.PREVAIL_BIN || "prevail";
}

function buildPlist(label: string, program: string, flag: string, vault: string, logOut: string, env?: Record<string, string>, runAtLoad = true): string {
  const envXml = env
    ? `\n  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${v}</string>`).join("\n")}\n  </dict>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${program}</string>
    <string>daemon</string>
    <string>${flag}</string>
    <string>--vault</string>
    <string>${vault}</string>
  </array>
  <key>RunAtLoad</key><${runAtLoad}/>
  <key>KeepAlive</key><${runAtLoad}/>
  <key>StandardOutPath</key><string>${logOut}</string>
  <key>StandardErrorPath</key><string>${logOut}</string>${envXml}
</dict>
</plist>
`;
}

export async function installLaunchAgent(vault: string, bin?: string): Promise<void> {
  const dir = join(homedir(), "Library", "LaunchAgents");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const program = bin || enginePath();
  const uid = process.getuid?.() ?? 501;
  for (const a of AGENTS) {
    const logOut = join(homedir(), "Library", "Logs", `prevail-${a.flag.replace(/^--/, "")}.log`);
    const path = plistPathFor(a.label);
    writeFileSync(path, buildPlist(a.label, program, a.flag, vault, logOut, a.env, a.runAtLoad ?? true));
    // (Re)load it. bootout first so a re-install picks up changes; ignore errors.
    await run(["launchctl", "bootout", `gui/${uid}/${a.label}`]).catch(() => {});
    const r = await run(["launchctl", "bootstrap", `gui/${uid}`, path]);
    if (r.ok) console.log(`installed: ${a.label} runs 'prevail daemon ${a.flag}' at login`);
    else { await run(["launchctl", "load", path]).catch(() => {}); console.log(`installed: ${a.label} (plist written; ${r.err || "loaded"})`); }
  }
}

export async function uninstallLaunchAgent(): Promise<void> {
  const uid = process.getuid?.() ?? 501;
  for (const a of AGENTS) {
    const path = plistPathFor(a.label);
    await run(["launchctl", "bootout", `gui/${uid}/${a.label}`]).catch(() => {});
    await run(["launchctl", "unload", path]).catch(() => {});
    if (existsSync(path)) rmSync(path);
    console.log(`uninstalled: ${a.label} removed`);
  }
}

export function isLaunchAgentInstalled(): boolean {
  return existsSync(plistPath());
}

async function run(argv: string[]): Promise<{ ok: boolean; err?: string }> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code === 0) return { ok: true };
    const err = (await new Response(proc.stderr).text()).trim();
    return { ok: false, err };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
}
