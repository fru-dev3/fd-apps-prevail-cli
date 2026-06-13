// launchd agent installer for the headless learn daemon. Writes a LaunchAgent
// plist that runs `prevail daemon --learn` at login and keeps it alive, so
// self-learning continues with the desktop app closed.

import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LABEL = "sh.prevail.learn";

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
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

export async function installLaunchAgent(vault: string, bin?: string): Promise<void> {
  const dir = join(homedir(), "Library", "LaunchAgents");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const program = bin || enginePath();
  const logOut = join(homedir(), "Library", "Logs", "prevail-learn.log");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${program}</string>
    <string>daemon</string>
    <string>--learn</string>
    <string>--vault</string>
    <string>${vault}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logOut}</string>
  <key>StandardErrorPath</key><string>${logOut}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PREVAIL_HEADLESS_LEARN</key><string>1</string>
  </dict>
</dict>
</plist>
`;
  writeFileSync(plistPath(), plist);
  // (Re)load it. bootout first so a re-install picks up changes; ignore errors.
  const uid = process.getuid?.() ?? 501;
  await run(["launchctl", "bootout", `gui/${uid}/${LABEL}`]).catch(() => {});
  const r = await run(["launchctl", "bootstrap", `gui/${uid}`, plistPath()]);
  if (r.ok) {
    console.log(`installed: ${LABEL} runs 'prevail daemon --learn' at login`);
    console.log(`           plist: ${plistPath()}`);
    console.log(`           logs:  ${logOut}`);
  } else {
    // bootstrap can fail if already loaded; fall back to legacy load.
    await run(["launchctl", "load", plistPath()]).catch(() => {});
    console.log(`installed: ${LABEL} (plist written; ${r.err || "loaded"})`);
  }
}

export async function uninstallLaunchAgent(): Promise<void> {
  const uid = process.getuid?.() ?? 501;
  await run(["launchctl", "bootout", `gui/${uid}/${LABEL}`]).catch(() => {});
  await run(["launchctl", "unload", plistPath()]).catch(() => {});
  if (existsSync(plistPath())) rmSync(plistPath());
  console.log(`uninstalled: ${LABEL} removed`);
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
