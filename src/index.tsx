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
  schedule: boolean;
  scheduleArgs: string[];
}

function parseArgs(argv: string[]): Args {
  let vaultPath: string | null = null;
  let forceInit = false;
  let demo = false;
  let help = false;
  let version = false;
  let doctor = false;
  let schedule = false;
  let scheduleArgs: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") help = true;
    else if (a === "-v" || a === "--version") version = true;
    else if (a === "init" || a === "--init") forceInit = true;
    else if (a === "demo" || a === "--demo") demo = true;
    else if (a === "doctor") doctor = true;
    else if (a === "schedule") {
      schedule = true;
      scheduleArgs = argv.slice(i + 1);
      break;
    } else if (a === "--vault" || a === "-d") {
      const next = argv[i + 1];
      if (next) {
        vaultPath = resolve(process.cwd(), next);
        i++;
      }
    } else if (a.startsWith("--vault=")) {
      vaultPath = resolve(process.cwd(), a.slice("--vault=".length));
    }
  }
  return { vaultPath, forceInit, demo, help, version, doctor, schedule, scheduleArgs };
}

function printHelp() {
  console.log(`prevail — a terminal cockpit for your life domains

USAGE
  prevail                     boot the cockpit (uses your saved vault)
  prevail init                run the first-run wizard
  prevail demo                ignore config, boot the synthetic vault
  prevail doctor              check installed AI clis + vault shape
  prevail schedule [...]      manage embedded cron-style schedules
  prevail --vault <path>      override vault path for one session

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

async function scheduleCommand(args: string[], vaultOverride: string | null) {
  const { loadSchedules, saveSchedules, makeScheduleId, isValidCron, isCronDue, runSchedule, describeCron, nextRunWithin } = await import("./schedule.ts");
  const cfg = readConfig();
  const vault = vaultOverride ?? cfg?.vaultPath ?? bundledDemoVaultPath();
  if (!existsSync(vault)) {
    console.error(`vault path not found: ${vault}`);
    process.exit(1);
  }

  const sub = args[0];
  if (!sub || sub === "list" || sub === "ls") {
    const schedules = loadSchedules(vault);
    if (schedules.length === 0) {
      console.log(`no schedules in ${vault}/.schedule.json`);
      console.log(`add one with: prevail schedule add "<cron>" "<command>" [--name <name>]`);
      return;
    }
    console.log(`schedules in ${vault}/.schedule.json:\n`);
    for (const s of schedules) {
      const next = nextRunWithin(s.cron);
      const nextLabel = next ? new Date(next).toLocaleString() : "(never within 7d)";
      const status = s.enabled ? "✓" : "✗";
      console.log(`  ${status} ${s.id}`);
      console.log(`    name:     ${s.name}`);
      console.log(`    cron:     ${s.cron}  (${describeCron(s.cron)})`);
      console.log(`    command:  ${s.command}`);
      console.log(`    last_run: ${s.last_run ? new Date(s.last_run).toLocaleString() : "(never)"}`);
      console.log(`    next:     ${nextLabel}\n`);
    }
    return;
  }

  if (sub === "add") {
    const cron = args[1];
    const command = args[2];
    if (!cron || !command) {
      console.error('usage: prevail schedule add "<cron>" "<command>" [--name <name>]');
      process.exit(1);
    }
    if (!isValidCron(cron)) {
      console.error(`invalid cron: "${cron}" — needs 5 space-separated fields`);
      process.exit(1);
    }
    let name = command.slice(0, 60);
    for (let i = 3; i < args.length; i++) {
      if (args[i] === "--name" && args[i + 1]) {
        name = args[i + 1];
        i++;
      }
    }
    const entry = {
      id: makeScheduleId(),
      name,
      cron,
      command,
      enabled: true,
      last_run: null,
      created_at: Date.now(),
    };
    const schedules = loadSchedules(vault);
    schedules.push(entry);
    saveSchedules(vault, schedules);
    console.log(`✓ added ${entry.id}`);
    console.log(`  cron:    ${cron}  (${describeCron(cron)})`);
    console.log(`  command: ${command}`);
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const id = args[1];
    if (!id) {
      console.error("usage: prevail schedule remove <id>");
      process.exit(1);
    }
    const before = loadSchedules(vault);
    const after = before.filter((s) => s.id !== id);
    if (after.length === before.length) {
      console.error(`no schedule with id ${id}`);
      process.exit(1);
    }
    saveSchedules(vault, after);
    console.log(`✓ removed ${id}`);
    return;
  }

  if (sub === "run") {
    const id = args[1];
    if (!id) {
      console.error("usage: prevail schedule run <id>");
      process.exit(1);
    }
    const schedules = loadSchedules(vault);
    const entry = schedules.find((s) => s.id === id);
    if (!entry) {
      console.error(`no schedule with id ${id}`);
      process.exit(1);
    }
    console.log(`running ${entry.id}: ${entry.command}`);
    const result = await runSchedule(entry, vault);
    entry.last_run = result.ts;
    saveSchedules(vault, schedules);
    console.log(`✓ fired at ${new Date(result.ts).toLocaleString()}`);
    return;
  }

  if (sub === "tick") {
    // mostly for debugging — runs all due schedules right now
    const schedules = loadSchedules(vault);
    let fired = 0;
    for (const s of schedules) {
      if (!s.enabled) continue;
      if (!isCronDue(s.cron, new Date())) continue;
      console.log(`firing ${s.id}: ${s.command}`);
      await runSchedule(s, vault);
      s.last_run = Date.now();
      fired++;
    }
    saveSchedules(vault, schedules);
    console.log(`${fired} schedule${fired === 1 ? "" : "s"} fired`);
    return;
  }

  console.error(`unknown subcommand: ${sub}\n`);
  console.error("usage:");
  console.error("  prevail schedule list");
  console.error('  prevail schedule add "<cron>" "<command>" [--name <name>]');
  console.error("  prevail schedule remove <id>");
  console.error("  prevail schedule run <id>");
  process.exit(1);
}

async function doctor() {
  const { detectClis } = await import("./cli-bridge.ts");
  const cfg = readConfig();
  console.log("prevail doctor\n");
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
    console.log("prevail 0.2.0");
    return;
  }
  if (args.doctor) {
    await doctor();
    return;
  }
  if (args.schedule) {
    await scheduleCommand(args.scheduleArgs, args.vaultPath);
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
    console.error("run `prevail init` to set up, or `prevail demo` for the synthetic vault.");
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
