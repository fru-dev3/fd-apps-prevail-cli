#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { resolve, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
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
  debug: boolean;
  schedule: boolean;
  scheduleArgs: string[];
  daemon: boolean;
  daemonArgs: string[];
  telegram: boolean;
  telegramArgs: string[];
  briefing: boolean;
  briefingArgs: string[];
  connectors: boolean;
  connectorsArgs: string[];
  mcp: boolean;
  mcpUnsafeDetach: boolean;
  bench: boolean;
  benchArgs: string[];
  vault: boolean;
  vaultArgs: string[];
}

function parseArgs(argv: string[]): Args {
  let vaultPath: string | null = null;
  let forceInit = false;
  let demo = false;
  let help = false;
  let version = false;
  let doctor = false;
  let debug = false;
  let schedule = false;
  let scheduleArgs: string[] = [];
  let daemon = false;
  let daemonArgs: string[] = [];
  let telegram = false;
  let telegramArgs: string[] = [];
  let briefing = false;
  let briefingArgs: string[] = [];
  let connectors = false;
  let connectorsArgs: string[] = [];
  let mcp = false;
  let mcpUnsafeDetach = false;
  let bench = false;
  let benchArgs: string[] = [];
  let vault = false;
  let vaultArgs: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") help = true;
    else if (a === "-v" || a === "--version") version = true;
    else if (a === "init" || a === "--init") forceInit = true;
    else if (a === "demo" || a === "--demo") demo = true;
    else if (a === "doctor") doctor = true;
    else if (a === "--debug") debug = true;
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
    } else if (a === "connectors" || a === "connector") {
      connectors = true;
      connectorsArgs = argv.slice(i + 1);
      break;
    } else if (a === "mcp") {
      mcp = true;
      // Consume any remaining mcp-specific flags (e.g. --unsafe-detach)
      // without falling back to the generic flag parser — same shape as
      // schedule/daemon/telegram, but mcp has no positional sub-commands
      // so a small inline loop is enough.
      for (let j = i + 1; j < argv.length; j++) {
        const f = argv[j];
        if (f === "--unsafe-detach") mcpUnsafeDetach = true;
      }
      break;
    } else if (a === "bench") {
      bench = true;
      benchArgs = argv.slice(i + 1);
      break;
    } else if (a === "vault") {
      vault = true;
      vaultArgs = argv.slice(i + 1);
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
    debug,
    schedule,
    scheduleArgs,
    daemon,
    daemonArgs,
    telegram,
    telegramArgs,
    briefing,
    briefingArgs,
    connectors,
    connectorsArgs,
    mcp,
    mcpUnsafeDetach,
    bench,
    benchArgs,
    vault,
    vaultArgs,
  };
}

function printHelp() {
  console.log(`prevail — a terminal cockpit for your life domains

USAGE
  prevail                     boot the cockpit (uses your saved vault)
  prevail init                run the first-run wizard
  prevail demo                ignore config, boot the synthetic vault
  prevail doctor              check installed AI clis + vault shape
  prevail doctor --debug      also print the last 50 entries from ~/.prevail/debug.log
  prevail schedule [...]      manage embedded cron-style schedules
  prevail telegram [...]      configure the Telegram bot bridge
  prevail briefing [...]      schedule per-domain prompts (e.g. daily 7am wealth digest)
  prevail connectors [...]    list connectors / run OAuth flows / test connections
  prevail mcp                 run as an MCP server (stdio) — exposes council + vault to other agents
                              auth: clients must send Authorization: prevail-<token> from ~/.prevail/mcp.json
                              parent-check: refuses non-TTY / unknown parents — bypass with --unsafe-detach
  prevail bench [...]         run the public council benchmark suite
  prevail vault [...]         prune old logs, snapshot/restore the vault
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

async function benchCommand(args: string[], vaultOverride: string | null): Promise<void> {
  const { loadQuestions, runBenchOne, writeBenchResult, writeBenchSummary, defaultResultsDir } =
    await import("./bench.ts");
  const cfg = readConfig();
  const vault = vaultOverride ?? cfg?.vaultPath ?? bundledDemoVaultPath();
  const sub = args[0];

  if (!sub || sub === "list" || sub === "ls") {
    const questions = loadQuestions();
    if (questions.length === 0) {
      console.log("no bench questions found. drop them under bench/questions/<domain>/<id>.md");
      return;
    }
    console.log(`${questions.length} bench question${questions.length === 1 ? "" : "s"}:`);
    for (const q of questions) {
      console.log(`  ${q.id.padEnd(36)}  ${q.domain.padEnd(10)} ${q.stakes.padEnd(6)} ${q.verifiable ? "✓" : " "}  ${q.prompt.slice(0, 80)}`);
    }
    return;
  }

  if (sub === "seed") {
    // Personal canonical benchmark — separate from the bundled
    // bench/questions/ suite. Writes to <vault>/benchmark/questions/.
    // Two modes:
    //   prevail bench seed --domain <name>           interactive scaffold,
    //                                                writes a fillable stub
    //   prevail bench seed --from-log <domain>       imports the most
    //                                                recent council verdict
    //                                                from that domain's _log
    const {
      ensureScaffold,
      writeDraftQuestion,
      seedFromLatestCouncil,
    } = await import("./canonical-bench.ts");
    ensureScaffold(vault);
    let domain: string | null = null;
    let fromLog = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const v = args[i + 1];
      if (a === "--domain" && v) {
        domain = v;
        i++;
      } else if (a === "--from-log" && v) {
        domain = v;
        fromLog = true;
        i++;
      }
    }
    if (!domain) {
      console.error("usage:");
      console.error("  prevail bench seed --domain <name>        write an empty stub question");
      console.error("  prevail bench seed --from-log <domain>    import latest council verdict");
      process.exit(1);
    }
    if (fromLog) {
      const result = seedFromLatestCouncil(vault, domain);
      if (!result) {
        console.error(`no council verdict found under ${vault}/${domain}/_log/. Either run a council in this domain first, or use --domain to write a fresh stub.`);
        process.exit(1);
      }
      console.log(`drafted from ${result.sourceFile}`);
      console.log(`  ${result.path}`);
      console.log(`\nopen the file and fill in expected_decision + expected_verdict_keywords with the answer you stand behind.`);
      return;
    }
    const path = writeDraftQuestion({ vaultPath: vault, domain });
    console.log(`wrote stub: ${path}`);
    console.log(`\nopen the file and fill in:`);
    console.log(`  - prompt (the question, as you'd type it to the council)`);
    console.log(`  - expected_decision (the answer you stand behind)`);
    console.log(`  - expected_verdict_keywords (substrings a good answer should hit)`);
    return;
  }

  if (sub === "score") {
    // Score one canonical run directory. Default: score the LATEST run
    // unless --run <name> is passed. Default judge: claude (first
    // detected; can override with --judge-cli/--judge-model). Skip the
    // LLM-as-judge layer with --no-judge for a fast mechanical pass.
    const { scoreRun, runsDir } = await import("./canonical-bench.ts");
    let runName: string | null = null;
    let noJudge = false;
    let judgeCliKind: string | null = null;
    let judgeModel: string | null = null;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const v = args[i + 1];
      if (a === "--run" && v) { runName = v; i++; }
      else if (a === "--no-judge") noJudge = true;
      else if (a === "--judge-cli" && v) { judgeCliKind = v; i++; }
      else if (a === "--judge-model" && v) { judgeModel = v; i++; }
    }
    const root = runsDir(vault);
    if (!existsSync(root)) {
      console.error(`no runs found under ${root}. run \`prevail bench run --canonical\` first.`);
      process.exit(1);
    }
    const candidates = readdirSync(root).sort().reverse();
    const targetName = runName ?? candidates[0];
    if (!targetName) {
      console.error("no runs found.");
      process.exit(1);
    }
    const runDir = join(root, targetName);
    if (!existsSync(join(runDir, "results.json"))) {
      console.error(`${runDir} has no results.json — was this run interrupted?`);
      process.exit(1);
    }
    let judgeCli;
    if (!noJudge) {
      const { detectClis } = await import("./cli-bridge.ts");
      const allClis = await detectClis();
      judgeCli = judgeCliKind
        ? allClis.find((c) => c.kind === judgeCliKind)
        : allClis.find((c) => c.kind === "claude") ?? allClis[0];
      if (!judgeCli) {
        console.error("no CLI available to act as judge. install one or pass --no-judge.");
        process.exit(1);
      }
    }
    console.log(`scoring ${targetName}${judgeCli ? ` · judge: ${judgeCli.kind}` : " · keyword-only"}…`);
    const result = await scoreRun({
      vaultPath: vault,
      runDir,
      judgeCli,
      judgeModel: judgeModel ?? undefined,
      onProgress: (id) => process.stdout.write(`  ${id}…\r`),
    });
    console.log("");
    console.log(`✓ scored ${result.questionScores.length} questions`);
    console.log(`  keyword_avg: ${result.keyword_avg ?? "—"}%`);
    console.log(`  judge_avg:   ${result.judge_avg ?? "—"} / 10`);
    console.log(`  written to:  ${runDir}/score.{md,json}`);
    return;
  }

  if (sub === "leaderboard" || sub === "lb") {
    const { buildLeaderboard } = await import("./canonical-bench.ts");
    const entries = buildLeaderboard(vault);
    if (entries.length === 0) {
      console.log("no scored runs yet. run `prevail bench run --canonical` then `prevail bench score`.");
      return;
    }
    console.log(`canonical leaderboard — ${entries.length} run${entries.length === 1 ? "" : "s"}:`);
    console.log("");
    console.log(`  judge / 10  keyword %  questions  label`);
    console.log(`  ----------  ---------  ---------  ----------------------------`);
    for (const e of entries) {
      const j = e.judge_avg === null ? "—" : e.judge_avg.toFixed(1).padStart(4, " ");
      const k = e.keyword_avg === null ? "—" : `${e.keyword_avg}%`.padStart(4, " ");
      console.log(`  ${j.padStart(10, " ")}  ${k.padStart(9, " ")}  ${String(e.questions).padStart(9, " ")}  ${e.label}`);
    }
    return;
  }

  if (sub === "run-canonical" || (sub === "run" && args.includes("--canonical"))) {
    // Personal canonical run: fire each <vault>/benchmark/questions/*.md
    // at the target CLI (or council, when --council is passed) and
    // write results to <vault>/benchmark/runs/<date>_<label>/.
    const { listQuestions, runCanonicalSet, writeRunDirectory } = await import(
      "./canonical-bench.ts"
    );
    const questions = listQuestions(vault);
    if (questions.length === 0) {
      console.error(`no canonical questions found under ${vault}/benchmark/questions/`);
      console.error("run `prevail bench seed --domain <name>` to add some.");
      process.exit(1);
    }
    let domain: string | null = null;
    let questionId: string | null = null;
    let targetCliKind: string | null = null;
    let targetModel: string | null = null;
    let useCouncil = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const v = args[i + 1];
      if (a === "--canonical") continue;
      if (a === "--domain" && v) { domain = v; i++; }
      else if (a === "--question" && v) { questionId = v; i++; }
      else if (a === "--cli" && v) { targetCliKind = v; i++; }
      else if (a === "--model" && v) { targetModel = v; i++; }
      else if (a === "--council") { useCouncil = true; }
    }
    let filtered = questions;
    if (domain) filtered = filtered.filter((q) => q.domain === domain);
    if (questionId) filtered = filtered.filter((q) => q.id === questionId);
    if (filtered.length === 0) {
      console.error("no questions matched the filter");
      process.exit(1);
    }
    const { detectClis } = await import("./cli-bridge.ts");
    const allClis = await detectClis();
    if (allClis.length === 0) {
      console.error("no CLIs detected — install claude / codex / gemini / ollama first");
      process.exit(1);
    }
    const targetCli = useCouncil
      ? undefined
      : (targetCliKind
          ? allClis.find((c) => c.kind === targetCliKind)
          : allClis[0]);
    if (!useCouncil && !targetCli) {
      console.error(`cli ${targetCliKind} not detected. available: ${allClis.map((c) => c.kind).join(", ")}`);
      process.exit(1);
    }
    console.log(`running ${filtered.length} canonical question${filtered.length === 1 ? "" : "s"}…`);
    const records = await runCanonicalSet({
      vaultPath: vault,
      questions: filtered,
      clis: allClis,
      targetCli,
      targetModel: targetModel ?? undefined,
      onProgress: (id, status, info) => {
        if (status === "start") process.stdout.write(`  ${id}…`);
        else if (status === "ok") console.log(` ${info ?? "ok"}`);
        else console.log(` ✗ ${info ?? "error"}`);
      },
    });
    const dir = writeRunDirectory({
      vaultPath: vault,
      records,
      targetCli,
      targetModel: targetModel ?? undefined,
    });
    const ok = records.filter((r) => r.ok).length;
    console.log("");
    console.log(`✓ ${ok}/${records.length} successful · written to ${dir}`);
    console.log(`  next: prevail bench score (coming in #28)`);
    return;
  }

  if (sub === "run") {
    const questions = loadQuestions();
    if (questions.length === 0) {
      console.error("no bench questions found");
      process.exit(1);
    }
    let filtered = questions;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const v = args[i + 1];
      if (a === "--domain" && v) {
        filtered = filtered.filter((q) => q.domain === v);
        i++;
      } else if (a === "--question" && v) {
        filtered = filtered.filter((q) => q.id === v);
        i++;
      }
    }
    if (filtered.length === 0) {
      console.error("no questions matched the filter");
      process.exit(1);
    }
    const today = new Date().toISOString().slice(0, 10);
    const outputDir = join(defaultResultsDir(), today);
    console.log(`running ${filtered.length} question${filtered.length === 1 ? "" : "s"} against the council…`);
    const results = [];
    for (const q of filtered) {
      process.stdout.write(`  ${q.id}…`);
      const t0 = Date.now();
      try {
        const r = await runBenchOne(q, vault);
        results.push(r);
        writeBenchResult(r, outputDir);
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(` ${r.successfulPanelists}/${r.panelCount} panelists · ${r.divergenceFlagged ? "🔀 split" : "consensus"} · ${dt}s`);
      } catch (err) {
        console.log(` ✗ ${(err as Error).message}`);
      }
    }
    const summary = writeBenchSummary(results, outputDir, today);
    console.log(``);
    console.log(`✓ ${results.length} result${results.length === 1 ? "" : "s"} written to ${outputDir}`);
    console.log(`  summary: ${summary}`);
    return;
  }

  console.error(`unknown bench subcommand: ${sub}\n`);
  console.error("usage:");
  console.error("  prevail bench list");
  console.error("  prevail bench run [--domain <name>] [--question <id>]");
  console.error("");
  console.error("personal canonical set (<vault>/benchmark/):");
  console.error("  prevail bench seed --domain <name>             write a stub canonical question");
  console.error("  prevail bench seed --from-log <domain>         import latest council verdict as draft");
  console.error("  prevail bench run --canonical [--cli <kind>] [--model <id>] [--council]");
  console.error("                                                run the personal canonical set");
  console.error("  prevail bench score [--run <name>] [--no-judge] [--judge-cli <kind>]");
  console.error("                                                grade a run (keyword + LLM judge)");
  console.error("  prevail bench leaderboard                     show ranked scoreboard across runs");
  process.exit(1);
}

async function connectorsCommand(args: string[]): Promise<void> {
  const { scanCommunityApps } = await import("./vault.ts");
  const { probeConnector } = await import("./connector-probe.ts");
  const { runOAuthFlow } = await import("./oauth-flow.ts");
  const apps = scanCommunityApps();
  const sub = args[0];
  if (!sub || sub === "list" || sub === "ls") {
    if (apps.length === 0) {
      console.log("no connectors found. drop a manifest.json into ~/.prevail/apps/<id>/");
      return;
    }
    console.log(`${apps.length} connector${apps.length === 1 ? "" : "s"}:\n`);
    for (const a of apps) {
      const integ = (a.integration ?? "manual").padEnd(8);
      console.log(`  ${integ}  ${a.id.padEnd(20)}  ${a.title}`);
    }
    return;
  }
  if (sub === "test" || sub === "probe") {
    const id = args[1];
    if (!id) {
      console.error("usage: prevail connectors test <id>");
      process.exit(1);
    }
    const app = apps.find((a) => a.id === id);
    if (!app) {
      console.error(`no connector with id "${id}"`);
      process.exit(1);
    }
    const r = await probeConnector(app, (app.authCheck as Parameters<typeof probeConnector>[1]) ?? null);
    console.log(`${app.title}: ${r.status}`);
    console.log(`  ${r.message}`);
    if (r.fixHint) console.log(`  fix: ${r.fixHint}`);
    if (r.missing && r.missing.length > 0) console.log(`  missing: ${r.missing.join(", ")}`);
    process.exit(r.ok ? 0 : 2);
  }
  if (sub === "skills") {
    const id = args[1];
    if (!id) {
      console.error("usage: prevail connectors skills <connector-id>");
      process.exit(1);
    }
    const app = apps.find((a) => a.id === id);
    if (!app) {
      console.error(`no connector with id "${id}"`);
      process.exit(1);
    }
    const { loadSkillsForConnector } = await import("./connector-skills.ts");
    const skills = loadSkillsForConnector(app);
    if (skills.length === 0) {
      console.log(`${app.title} has no skill files under ${app.path}/skills/`);
      return;
    }
    console.log(`${app.title} · ${skills.length} skill${skills.length === 1 ? "" : "s"}:`);
    for (const s of skills) {
      console.log(`  ${s.id.padEnd(28)}  runner=${s.runner.padEnd(8)} trigger=${s.trigger ?? "on-demand"}`);
    }
    return;
  }
  if (sub === "run") {
    const id = args[1];
    const skillId = args[2];
    if (!id || !skillId) {
      console.error("usage: prevail connectors run <connector-id> <skill-id> [--input key=value ...]");
      process.exit(1);
    }
    const app = apps.find((a) => a.id === id);
    if (!app) {
      console.error(`no connector with id "${id}"`);
      process.exit(1);
    }
    const { loadSkillsForConnector, runSkill, logSkillRun } = await import("./connector-skills.ts");
    const skill = loadSkillsForConnector(app).find((s) => s.id === skillId);
    if (!skill) {
      console.error(`no skill "${skillId}" for connector ${id}`);
      process.exit(1);
    }
    const inputs: Record<string, unknown> = {};
    for (let i = 3; i < args.length; i++) {
      if (args[i] === "--input" && args[i + 1]) {
        const kv = args[i + 1]!.split("=");
        if (kv.length >= 2) inputs[kv[0]!] = kv.slice(1).join("=");
        i++;
      }
    }
    console.log(`running ${id}/${skillId} (runner=${skill.runner})…`);
    const result = await runSkill(skill, inputs);
    logSkillRun(skill, result);
    if (result.ok) {
      console.log(`✓ ${result.message}`);
      for (const p of result.outputsWritten) console.log(`  → ${p}`);
    } else {
      console.error(`✗ ${result.message}`);
      process.exit(1);
    }
    return;
  }
  if (sub === "oauth") {
    const id = args[1];
    if (!id) {
      console.error("usage: prevail connectors oauth <id>");
      console.error("");
      console.error("walks through the OAuth 2.0 + PKCE flow for the connector,");
      console.error("opens your browser, catches the redirect on 127.0.0.1, and");
      console.error("saves the refresh token to ~/.prevail/connectors/<id>/auth/.");
      process.exit(1);
    }
    const app = apps.find((a) => a.id === id);
    if (!app) {
      console.error(`no connector with id "${id}"`);
      process.exit(1);
    }
    if (!app.oauth) {
      console.error(`connector "${id}" has no oauth block in its manifest`);
      process.exit(1);
    }
    console.log(`starting OAuth flow for ${app.title}…`);
    const result = await runOAuthFlow(
      id,
      app.oauth as Parameters<typeof runOAuthFlow>[1],
      { logger: (line) => console.log(`  ${line}`) },
    );
    if (result.ok) {
      console.log(`\n✓ ${result.message}`);
      console.log(`\ntest the connection with: prevail connectors test ${id}`);
    } else {
      console.error(`\n✗ ${result.message}`);
      process.exit(1);
    }
    return;
  }
  console.error(`unknown connectors subcommand: ${sub}\n`);
  console.error("usage:");
  console.error("  prevail connectors list");
  console.error("  prevail connectors test <id>");
  console.error("  prevail connectors oauth <id>");
  console.error("  prevail connectors skills <id>                       — list runnable skills");
  console.error("  prevail connectors run <id> <skill> [--input k=v]   — execute a skill");
  process.exit(1);
}

async function vaultCommand(args: string[], vaultOverride: string | null): Promise<void> {
  const {
    pruneLog,
    parseDuration,
    backupVault,
    restoreVault,
    defaultBackupPath,
    formatBytes,
    verifyVault,
  } = await import("./vault-ops.ts");
  const cfg = readConfig();
  const vault = vaultOverride ?? cfg?.vaultPath ?? bundledDemoVaultPath();
  const sub = args[0];

  if (!sub) {
    printVaultHelp();
    process.exit(1);
  }

  if (sub === "prune") {
    let older = "30d";
    let force = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const v = args[i + 1];
      if ((a === "--older-than" || a === "--older") && v) {
        older = v;
        i++;
      } else if (a === "--force" || a === "-f") {
        force = true;
      }
    }
    let olderMs: number;
    try {
      olderMs = parseDuration(older);
    } catch (err) {
      console.error(`prune: ${(err as Error).message}`);
      process.exit(1);
    }
    if (!existsSync(vault)) {
      console.error(`vault path not found: ${vault}`);
      process.exit(1);
    }
    // Always do a dry pass first to print what we'd free, even in --force
    // mode (so the user sees what got deleted, not just a silent OK).
    const dryResult = pruneLog({
      vaultPath: vault,
      olderThanMs: olderMs,
      dryRun: true,
    });
    if (dryResult.files.length === 0) {
      console.log(`nothing to prune in ${vault} older than ${older}.`);
      return;
    }
    const verb = force ? "freed" : "would free";
    console.log(
      `${verb} ${formatBytes(dryResult.totalBytes)} / ${dryResult.files.length} file${dryResult.files.length === 1 ? "" : "s"}`,
    );
    for (const f of dryResult.files) console.log(`  ${f.startsWith(vault) ? f.slice(vault.length + 1) : f}`);
    if (!force) {
      console.log("");
      console.log("re-run with --force to actually delete.");
      return;
    }
    // Actually delete.
    pruneLog({ vaultPath: vault, olderThanMs: olderMs, dryRun: false });
    console.log("");
    console.log(`✓ deleted ${dryResult.files.length} file${dryResult.files.length === 1 ? "" : "s"}.`);
    return;
  }

  if (sub === "backup") {
    let output: string | null = null;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const v = args[i + 1];
      if ((a === "--output" || a === "-o") && v) {
        output = resolve(process.cwd(), v);
        i++;
      }
    }
    if (!output) output = defaultBackupPath();
    if (!existsSync(vault)) {
      console.error(`vault path not found: ${vault}`);
      process.exit(1);
    }
    console.log(`backing up ${vault} → ${output}…`);
    try {
      const r = await backupVault({ vaultPath: vault, outputPath: output });
      console.log(`✓ wrote ${r.archivePath} (${formatBytes(r.bytes)})`);
    } catch (err) {
      console.error(`backup failed: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "restore") {
    const archive = args[1];
    if (!archive) {
      console.error("usage: prevail vault restore <archive>");
      process.exit(1);
    }
    if (!existsSync(vault)) {
      // The target may not exist yet — restore will create it. But warn
      // the user so they don't accidentally extract into the wrong place.
      console.log(`note: target vault ${vault} does not exist; will be created.`);
    }
    try {
      await restoreVault({
        archivePath: resolve(process.cwd(), archive),
        targetVaultPath: vault,
      });
      console.log(`✓ restored into ${vault}`);
    } catch (err) {
      console.error(`restore failed: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "verify") {
    const verbose = args.includes("--verbose") || args.includes("-v");
    if (!existsSync(vault)) {
      console.error(`vault path not found: ${vault}`);
      process.exit(1);
    }
    const results = verifyVault(vault);
    // ANSI escapes — small enough to inline, no helper needed.
    const RED = "\x1b[31m";
    const YEL = "\x1b[33m";
    const GRN = "\x1b[32m";
    const DIM = "\x1b[2m";
    const RST = "\x1b[0m";
    let mismatches = 0;
    let missing = 0;
    const domains = new Set<string>();
    for (const r of results) {
      domains.add(r.domain);
      // Print path relative to the vault when possible — keeps output tight.
      const rel = r.file.startsWith(vault) ? r.file.slice(vault.length + 1) : r.file;
      if (r.status === "mismatch") {
        mismatches++;
        const exp = r.expected.slice(0, 8);
        const act = (r.actual ?? "").slice(0, 8);
        console.log(`${RED}! ${rel} @ ${r.entryId} — sha mismatch (stored ${exp}..., computed ${act}...)${RST}`);
      } else if (r.status === "missing") {
        missing++;
        console.log(`${YEL}? ${rel} @ ${r.entryId} — entry not found (was the file edited?)${RST}`);
      } else if (verbose) {
        console.log(`${DIM}✓ ${rel} @ ${r.entryId}${RST}`);
      }
    }
    const issues = mismatches + missing;
    if (issues === 0) {
      console.log(`${GRN}verified ${results.length} entries across ${domains.size} domain${domains.size === 1 ? "" : "s"}. 0 mismatches${RST}`);
    } else {
      console.log(`${RED}FOUND ${issues} issue${issues === 1 ? "" : "s"}${RST} (${mismatches} mismatch${mismatches === 1 ? "" : "es"}, ${missing} missing) across ${domains.size} domain${domains.size === 1 ? "" : "s"}`);
      process.exit(1);
    }
    return;
  }

  console.error(`unknown vault subcommand: ${sub}\n`);
  printVaultHelp();
  process.exit(1);
}

function printVaultHelp(): void {
  console.error("usage:");
  console.error("  prevail vault prune [--older-than <duration>] [--force]");
  console.error("                                          dry-run by default; --force to delete");
  console.error("  prevail vault backup [--output <path>]  default: ~/prevail-backup-<date>.tar.gz");
  console.error("  prevail vault restore <archive>         interactive confirm prompt");
  console.error("  prevail vault verify [--verbose]        re-hash logged entries against _log/.shasum");
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

async function doctor(opts: { debug: boolean } = { debug: false }) {
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
  if (opts.debug) {
    const { readDebugTail, debugLogPath } = await import("./debug-log.ts");
    console.log("");
    console.log(`debug log    ${debugLogPath()}`);
    const tail = readDebugTail(50);
    if (tail.length === 0) {
      console.log("             no debug log yet — nothing has logged");
    } else {
      console.log(`             last ${tail.length} entries:`);
      for (const line of tail) console.log(line);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  if (args.version) {
    const { VERSION } = await import("./version.ts");
    console.log(`prevail ${VERSION}`);
    return;
  }
  if (args.doctor) {
    await doctor({ debug: args.debug });
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
  if (args.connectors) {
    await connectorsCommand(args.connectorsArgs);
    return;
  }
  if (args.mcp) {
    const cfg = readConfig();
    const vault = args.vaultPath ?? cfg?.vaultPath ?? bundledDemoVaultPath();
    const { runMcpServer } = await import("./mcp-server.ts");
    await runMcpServer(vault, { unsafeDetach: args.mcpUnsafeDetach });
    return;
  }
  if (args.bench) {
    await benchCommand(args.benchArgs, args.vaultPath);
    return;
  }
  if (args.vault) {
    await vaultCommand(args.vaultArgs, args.vaultPath);
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
