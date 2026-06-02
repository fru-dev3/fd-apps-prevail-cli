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
  daemon: boolean;
  daemonArgs: string[];
  telegram: boolean;
  telegramArgs: string[];
  briefing: boolean;
  briefingArgs: string[];
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
  let daemon = false;
  let daemonArgs: string[] = [];
  let telegram = false;
  let telegramArgs: string[] = [];
  let briefing = false;
  let briefingArgs: string[] = [];
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
    } else if (a === "daemon") {
      daemon = true;
      daemonArgs = argv.slice(i + 1);
      break;
    } else if (a === "telegram") {
      telegram = true;
      telegramArgs = argv.slice(i + 1);
      break;
    } else if (a === "briefing" || a === "briefings") {
      briefing = true;
      briefingArgs = argv.slice(i + 1);
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
  return {
    vaultPath,
    forceInit,
    demo,
    help,
    version,
    doctor,
    schedule,
    scheduleArgs,
    daemon,
    daemonArgs,
    telegram,
    telegramArgs,
    briefing,
    briefingArgs,
  };
}

function printHelp() {
  console.log(`prevail — a terminal cockpit for your life domains

USAGE
  prevail                     boot the cockpit (uses your saved vault)
  prevail init                run the first-run wizard
  prevail demo                ignore config, boot the synthetic vault
  prevail doctor              check installed AI clis + vault shape
  prevail schedule [...]      manage embedded cron-style schedules
  prevail telegram [...]      configure the Telegram bot bridge
  prevail briefing [...]      schedule per-domain prompts (e.g. daily 7am wealth digest)
  prevail daemon --telegram   run the headless Telegram bot + briefing ticker
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

async function telegramCommand(args: string[]): Promise<void> {
  const {
    readTelegramConfig,
    writeTelegramConfig,
    setTelegramToken,
    addAllowedChatId,
    removeAllowedChatId,
    telegramConfigFile,
  } = await import("./telegram-config.ts");
  const sub = args[0];
  if (!sub || sub === "status") {
    const cur = readTelegramConfig();
    if (!cur) {
      console.log("telegram: not configured");
      console.log(`           config file: ${telegramConfigFile()}`);
      console.log("           setup with:  prevail telegram setup <bot-token>");
      console.log("           or:          export PREVAIL_TELEGRAM_TOKEN=<token>");
      return;
    }
    const tokenPreview = cur.botToken
      ? `${cur.botToken.slice(0, 6)}…${cur.botToken.slice(-4)}`
      : "(missing)";
    console.log(`telegram: configured`);
    console.log(`token:    ${tokenPreview}`);
    console.log(`allow:    ${cur.allowList.length === 0 ? "(empty — bot will refuse everyone)" : cur.allowList.join(", ")}`);
    console.log(`default cli:    ${cur.defaultCli ?? "(auto)"}`);
    console.log(`default domain: ${cur.defaultDomain ?? "(first in vault)"}`);
    console.log(`council default: ${cur.councilByDefault ? "on" : "off"}`);
    return;
  }
  if (sub === "setup") {
    const token = args[1];
    if (!token) {
      console.error("usage: prevail telegram setup <bot-token>");
      console.error("");
      console.error("To get a token:");
      console.error("  1. Open Telegram, message @BotFather");
      console.error("  2. Send /newbot and follow the prompts");
      console.error("  3. Paste the token here");
      process.exit(1);
    }
    setTelegramToken(token);
    console.log(`✓ token saved to ${telegramConfigFile()} (chmod 600)`);
    console.log("");
    console.log("Next: message your bot once from your phone, then watch the daemon log");
    console.log("for your chat_id. Add it with:");
    console.log("  prevail telegram add-user <chat_id>");
    console.log("");
    console.log("Start the daemon:");
    console.log("  prevail daemon --telegram");
    return;
  }
  if (sub === "add-user") {
    const id = parseInt(args[1] ?? "", 10);
    if (!Number.isFinite(id)) {
      console.error("usage: prevail telegram add-user <chat_id>");
      process.exit(1);
    }
    try {
      const added = addAllowedChatId(id);
      if (added) console.log(`✓ chat_id ${id} allow-listed`);
      else console.log(`(${id} was already on the list)`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
    return;
  }
  if (sub === "remove-user" || sub === "rm-user") {
    const id = parseInt(args[1] ?? "", 10);
    if (!Number.isFinite(id)) {
      console.error("usage: prevail telegram remove-user <chat_id>");
      process.exit(1);
    }
    const removed = removeAllowedChatId(id);
    console.log(removed ? `✓ removed ${id}` : `(${id} wasn't on the list)`);
    return;
  }
  if (sub === "set-default") {
    const k = args[1];
    const v = args[2];
    if (!k || !v) {
      console.error("usage: prevail telegram set-default <cli|domain|council> <value>");
      process.exit(1);
    }
    const cur = readTelegramConfig();
    if (!cur) {
      console.error("not configured — run `prevail telegram setup <token>` first");
      process.exit(1);
    }
    if (k === "cli") {
      if (!["claude", "codex", "gemini", "ollama"].includes(v)) {
        console.error(`unknown cli "${v}"`);
        process.exit(1);
      }
      writeTelegramConfig({ ...cur, defaultCli: v as "claude" | "codex" | "gemini" | "ollama" });
    } else if (k === "domain") {
      writeTelegramConfig({ ...cur, defaultDomain: v });
    } else if (k === "council") {
      writeTelegramConfig({ ...cur, councilByDefault: v === "on" || v === "true" || v === "1" });
    } else {
      console.error(`unknown key "${k}"`);
      process.exit(1);
    }
    console.log(`✓ ${k}=${v}`);
    return;
  }
  console.error(`unknown telegram subcommand: ${sub}\n`);
  console.error("usage:");
  console.error("  prevail telegram status");
  console.error("  prevail telegram setup <bot-token>");
  console.error("  prevail telegram add-user <chat_id>");
  console.error("  prevail telegram remove-user <chat_id>");
  console.error("  prevail telegram set-default <cli|domain|council> <value>");
  process.exit(1);
}

async function briefingCommand(args: string[], vaultOverride: string | null): Promise<void> {
  const {
    loadBriefings,
    saveBriefings,
    makeBriefingId,
    runBriefing,
    findDomain,
  } = await import("./briefings.ts");
  const { isValidCron, describeCron, nextRunWithin } = await import("./schedule.ts");
  const cfg = readConfig();
  const vault = vaultOverride ?? cfg?.vaultPath ?? bundledDemoVaultPath();
  if (!existsSync(vault)) {
    console.error(`vault path not found: ${vault}`);
    process.exit(1);
  }

  const sub = args[0];
  if (!sub || sub === "list" || sub === "ls") {
    const briefings = loadBriefings(vault);
    if (briefings.length === 0) {
      console.log(`no briefings in ${vault}/.briefings.json`);
      console.log(`add one with: prevail briefing add --cron "<cron>" --domain <name> --prompt "<text>" [--mode council] [--deliver telegram|log|both]`);
      return;
    }
    console.log(`briefings in ${vault}/.briefings.json:\n`);
    for (const b of briefings) {
      const next = nextRunWithin(b.cron);
      const nextLabel = next ? new Date(next).toLocaleString() : "(none within 7d)";
      const status = b.enabled ? "✓" : "✗";
      console.log(`  ${status} ${b.id}`);
      console.log(`    name:     ${b.name}`);
      console.log(`    cron:     ${b.cron}  (${describeCron(b.cron)})`);
      console.log(`    domain:   ${b.domain}`);
      console.log(`    mode:     ${b.mode}`);
      console.log(`    deliver:  ${b.deliver}`);
      console.log(`    prompt:   ${b.prompt}`);
      console.log(`    last:     ${b.last_run ? new Date(b.last_run).toLocaleString() : "(never)"}`);
      console.log(`    next:     ${nextLabel}\n`);
    }
    return;
  }

  if (sub === "add") {
    // Parse named flags so users can mix-and-match instead of positional args.
    let cron = "";
    let domain = "";
    let prompt = "";
    let name = "";
    let mode: "single" | "council" = "single";
    let deliver: "log" | "telegram" | "both" = "log";
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const v = args[i + 1];
      if (a === "--cron" && v) { cron = v; i++; }
      else if (a === "--domain" && v) { domain = v; i++; }
      else if (a === "--prompt" && v) { prompt = v; i++; }
      else if (a === "--name" && v) { name = v; i++; }
      else if (a === "--mode" && v) { mode = v === "council" ? "council" : "single"; i++; }
      else if (a === "--deliver" && v) {
        deliver = v === "telegram" || v === "both" ? v : "log";
        i++;
      }
    }
    if (!cron || !domain || !prompt) {
      console.error('usage: prevail briefing add --cron "<cron>" --domain <name> --prompt "<text>" [--mode council] [--deliver telegram|both]');
      process.exit(1);
    }
    if (!isValidCron(cron)) {
      console.error(`invalid cron: "${cron}" — needs 5 space-separated fields`);
      process.exit(1);
    }
    if (!findDomain(vault, domain)) {
      console.error(`domain "${domain}" not found in vault ${vault}`);
      process.exit(1);
    }
    if (!name) name = `${domain} briefing`;
    const entry = {
      id: makeBriefingId(),
      name,
      cron,
      domain,
      prompt,
      mode,
      deliver,
      enabled: true,
      last_run: null,
      created_at: Date.now(),
    };
    const list = loadBriefings(vault);
    list.push(entry);
    saveBriefings(vault, list);
    console.log(`✓ added ${entry.id}`);
    console.log(`  cron:     ${cron}  (${describeCron(cron)})`);
    console.log(`  domain:   ${domain}`);
    console.log(`  mode:     ${mode}`);
    console.log(`  deliver:  ${deliver}`);
    console.log(`  prompt:   ${prompt}`);
    if (deliver !== "log") {
      console.log("");
      console.log("⚠ telegram delivery requires the daemon to be running:");
      console.log("  prevail daemon --telegram");
    }
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const id = args[1];
    if (!id) {
      console.error("usage: prevail briefing remove <id>");
      process.exit(1);
    }
    const before = loadBriefings(vault);
    const after = before.filter((b) => b.id !== id);
    if (after.length === before.length) {
      console.error(`no briefing with id ${id}`);
      process.exit(1);
    }
    saveBriefings(vault, after);
    console.log(`✓ removed ${id}`);
    return;
  }

  if (sub === "run") {
    const id = args[1];
    if (!id) {
      console.error("usage: prevail briefing run <id>");
      process.exit(1);
    }
    const list = loadBriefings(vault);
    const entry = list.find((b) => b.id === id);
    if (!entry) {
      console.error(`no briefing with id ${id}`);
      process.exit(1);
    }
    console.log(`running ${entry.id}: ${entry.name}`);
    // Telegram delivery is only wired by the daemon — `prevail briefing run`
    // is for one-off manual fires, so telegram delivery is skipped here even
    // if the briefing is configured for it. The verdict still lands in the
    // vault log either way.
    const r = await runBriefing(entry, vault);
    if (r.error) {
      console.error(`✗ ${r.error}`);
      process.exit(1);
    }
    entry.last_run = r.ts;
    saveBriefings(vault, list);
    console.log("");
    console.log(r.output);
    console.log("");
    console.log(`✓ delivered to log: ${r.delivered.log}, telegram: ${r.delivered.telegram}`);
    return;
  }

  console.error(`unknown briefing subcommand: ${sub}\n`);
  console.error("usage:");
  console.error("  prevail briefing list");
  console.error('  prevail briefing add --cron "<cron>" --domain <name> --prompt "<text>" [--mode council] [--deliver telegram|both]');
  console.error("  prevail briefing remove <id>");
  console.error("  prevail briefing run <id>");
  process.exit(1);
}

async function daemonCommand(args: string[], vaultOverride: string | null): Promise<void> {
  const wantTelegram = args.includes("--telegram") || args.includes("-t");
  if (!wantTelegram) {
    console.error("usage: prevail daemon --telegram");
    console.error("");
    console.error("Currently the daemon only supports the --telegram transport.");
    console.error("Other transports (webhook, slack, sms) are on the roadmap.");
    process.exit(1);
  }
  const cfg = readConfig();
  const vault = vaultOverride ?? cfg?.vaultPath ?? bundledDemoVaultPath();
  if (!existsSync(vault)) {
    console.error(`vault path not found: ${vault}`);
    process.exit(1);
  }
  const { runTelegramDaemon } = await import("./telegram.ts");
  const handle = await runTelegramDaemon({ vaultPath: vault });
  console.log("press ctrl-c to stop");
  // Plain process — the daemon is the foreground loop, so just let it run.
  // Ctrl-C → SIGINT → node default handler exits the process; runTelegramDaemon
  // doesn't need explicit teardown because the only state is in memory.
  process.on("SIGINT", () => {
    handle.stop();
    console.log("\n[telegram] stopped");
    process.exit(0);
  });
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
  const clis = await detectClis();
  if (clis.length === 0) {
    console.log("clis         none detected — install at least one:");
    console.log("             claude   https://claude.com/code");
    console.log("             codex    https://github.com/openai/codex");
    console.log("             gemini   https://github.com/google-gemini/gemini-cli");
    console.log("             ollama   https://ollama.com  (run `ollama serve`)");
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
    console.log("prevail 0.3.0");
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
  if (args.telegram) {
    await telegramCommand(args.telegramArgs);
    return;
  }
  if (args.briefing) {
    await briefingCommand(args.briefingArgs, args.vaultPath);
    return;
  }
  if (args.daemon) {
    await daemonCommand(args.daemonArgs, args.vaultPath);
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
