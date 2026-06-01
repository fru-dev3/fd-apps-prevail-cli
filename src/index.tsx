#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { App } from "./app.tsx";
import { FirstRunWizard } from "./wizard.tsx";
import { bundledDemoVaultPath, readConfig, writeConfig } from "./config.ts";

interface Args {
  vaultPath: string | null;
  forceInit: boolean;
  demo: boolean;
  help: boolean;
  version: boolean;
  doctor: boolean;
}

function parseArgs(argv: string[]): Args {
  let vaultPath: string | null = null;
  let forceInit = false;
  let demo = false;
  let help = false;
  let version = false;
  let doctor = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") help = true;
    else if (a === "-v" || a === "--version") version = true;
    else if (a === "init" || a === "--init") forceInit = true;
    else if (a === "demo" || a === "--demo") demo = true;
    else if (a === "doctor") doctor = true;
    else if (a === "--vault" || a === "-d") {
      const next = argv[i + 1];
      if (next) {
        vaultPath = resolve(process.cwd(), next);
        i++;
      }
    } else if (a.startsWith("--vault=")) {
      vaultPath = resolve(process.cwd(), a.slice("--vault=".length));
    }
  }
  return { vaultPath, forceInit, demo, help, version, doctor };
}

function printHelp() {
  console.log(`aireadyu — a terminal cockpit for your life domains

USAGE
  aireadyu                     boot the cockpit (uses your saved vault)
  aireadyu init                run the first-run wizard
  aireadyu demo                ignore config, boot the synthetic vault
  aireadyu doctor              check installed AI clis + vault shape
  aireadyu --vault <path>      override vault path for one session

OPTIONS
  -d, --vault <path>           use this vault root for this run
  -v, --version                show version
  -h, --help                   show this help

KEYS (inside the cockpit)
  ↑/↓                          arrow between life domains and apps
  s                            toggle focus between domains and apps
  c                            (no longer required — chat opens automatically)
  e                            edit active tab in $EDITOR
  n                            scaffold a new domain
  r                            rescan vault
  q / ctrl-c                   quit

CHAT (right pane, always live)
  click [Claude]/[Codex]/[Gemini]   switch CLI in current chat
  click model chips                 switch model
  /claude /codex /gemini [model]    same, via slash command
  /model <name>                     custom model name pass-through
  /help                             list slash commands
  /clear                            reset conversation
  /exit                             return to cockpit
`);
}

async function doctor() {
  const { detectClis } = await import("./cli-bridge.ts");
  const cfg = readConfig();
  console.log("aireadyu doctor\n");
  console.log(`config       ${cfg ? "found" : "missing (will run wizard on next boot)"}`);
  if (cfg) {
    const ok = existsSync(cfg.vaultPath);
    console.log(`vault        ${cfg.vaultPath} ${ok ? "✓" : "✗ (missing!)"}`);
  }
  const ai = `${homedir()}/.ai/vault`;
  console.log(`~/.ai/vault  ${existsSync(ai) ? "found — will be offered in wizard" : "not present"}`);
  console.log("");
  const clis = detectClis();
  if (clis.length === 0) {
    console.log("clis         none detected — install at least one:");
    console.log("             claude   https://claude.com/code");
    console.log("             codex    https://github.com/openai/codex");
    console.log("             gemini   https://github.com/google-gemini/gemini-cli");
  } else {
    for (const c of clis) console.log(`cli          ${c.label.padEnd(14)} ${c.bin}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  if (args.version) {
    console.log("aireadyu 0.1.2");
    return;
  }
  if (args.doctor) {
    await doctor();
    return;
  }

  let vaultPath = args.vaultPath;

  if (args.demo) {
    vaultPath = bundledDemoVaultPath();
  } else if (!vaultPath) {
    const cfg = args.forceInit ? null : readConfig();
    if (cfg && existsSync(cfg.vaultPath)) {
      vaultPath = cfg.vaultPath;
    } else {
      vaultPath = await runWizard();
    }
  }

  if (!existsSync(vaultPath)) {
    console.error(`vault path not found: ${vaultPath}`);
    console.error("run `aireadyu init` to set up, or `aireadyu demo` for the synthetic vault.");
    process.exit(1);
  }

  await launchCockpit(vaultPath);
}

async function runWizard(): Promise<string> {
  return new Promise((resolve) => {
    void (async () => {
      const renderer = await createCliRenderer({
        targetFps: 60,
        exitOnCtrlC: true,
        useMouse: true,
      });
      const root = createRoot(renderer);
      root.render(
        <FirstRunWizard
          onDone={(vault) => {
            root.unmount?.();
            try { renderer?.destroy?.(); } catch {}
            resolve(vault);
          }}
        />,
      );
    })();
  });
}

async function launchCockpit(vaultPath: string) {
  const renderer = await createCliRenderer({
    targetFps: 60,
    exitOnCtrlC: true,
    useMouse: true,
  });
  const vaultLabel = shortenPath(vaultPath);
  createRoot(renderer).render(<App vaultPath={vaultPath} vaultLabel={vaultLabel} />);
}

function shortenPath(p: string): string {
  const home = process.env.HOME ?? "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
