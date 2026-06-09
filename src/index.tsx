#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { resolve, join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { App } from "./app.tsx";
import { FirstRunWizard } from "./wizard.tsx";
import { bundledDemoVaultPath, readConfig, } from "./config.ts";

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
  usage: boolean;
  usageArgs: string[];
  pack: boolean;
  packArgs: string[];
  appmode: boolean;
  appmodeArgs: string[];
  lock: boolean;
  lockArgs: string[];
  vault: boolean;
  vaultArgs: string[];
  upgrade: boolean;
  upgradeArgs: string[];
  manifest: boolean;
  manifestArgs: string[];
  chat: boolean;
  chatArgs: string[];
  score: boolean;
  scoreArgs: string[];
  onboard: boolean;
  onboardArgs: string[];
  heartbeat: boolean;
  heartbeatArgs: string[];
  gateway: boolean;
  gatewayArgs: string[];
  domains: boolean;
  domainsArgs: string[];
  council: boolean;
  councilArgs: string[];
  decisions: boolean;
  decisionsArgs: string[];
  memory: boolean;
  memoryArgs: string[];
  frameworks: boolean;
  frameworksArgs: string[];
  lenses: boolean;
  lensesArgs: string[];
  surface: boolean;
  surfaceArgs: string[];
  modes: boolean;
  modesArgs: string[];
  privacy: boolean;
  privacyArgs: string[];
  search: boolean;
  searchArgs: string[];
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
  let usage = false;
  let usageArgs: string[] = [];
  let pack = false;
  let packArgs: string[] = [];
  let appmode = false;
  let appmodeArgs: string[] = [];
  let lock = false;
  let lockArgs: string[] = [];
  let vault = false;
  let vaultArgs: string[] = [];
  let upgrade = false;
  let upgradeArgs: string[] = [];
  let manifest = false;
  let manifestArgs: string[] = [];
  let chat = false;
  let chatArgs: string[] = [];
  let score = false;
  let scoreArgs: string[] = [];
  let onboard = false;
  let onboardArgs: string[] = [];
  let heartbeat = false;
  let heartbeatArgs: string[] = [];
  let gateway = false;
  let gatewayArgs: string[] = [];
  let domains = false;
  let domainsArgs: string[] = [];
  let council = false;
  let councilArgs: string[] = [];
  let decisions = false;
  let decisionsArgs: string[] = [];
  let memory = false;
  let memoryArgs: string[] = [];
  let frameworks = false;
  let frameworksArgs: string[] = [];
  let lenses = false;
  let lensesArgs: string[] = [];
  let surface = false;
  let surfaceArgs: string[] = [];
  let modes = false;
  let modesArgs: string[] = [];
  let privacy = false;
  let privacyArgs: string[] = [];
  let search = false;
  let searchArgs: string[] = [];
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
    } else if (a === "usage") {
      usage = true;
      usageArgs = argv.slice(i + 1);
      break;
    } else if (a === "pack" || a === "packs") {
      pack = true;
      packArgs = argv.slice(i + 1);
      break;
    } else if (a === "appmode") {
      appmode = true;
      appmodeArgs = argv.slice(i + 1);
      break;
    } else if (a === "lock") {
      lock = true;
      lockArgs = argv.slice(i + 1);
      break;
    } else if (a === "vault") {
      vault = true;
      vaultArgs = argv.slice(i + 1);
      break;
    } else if (a === "manifest") {
      manifest = true;
      manifestArgs = argv.slice(i + 1);
      break;
    } else if (a === "chat") {
      chat = true;
      chatArgs = argv.slice(i + 1);
      break;
    } else if (a === "score") {
      score = true;
      scoreArgs = argv.slice(i + 1);
      break;
    } else if (a === "onboard") {
      onboard = true;
      onboardArgs = argv.slice(i + 1);
      break;
    } else if (a === "heartbeat") {
      heartbeat = true;
      heartbeatArgs = argv.slice(i + 1);
      break;
    } else if (a === "gateway") {
      gateway = true;
      gatewayArgs = argv.slice(i + 1);
      break;
    } else if (a === "domains") {
      domains = true;
      domainsArgs = argv.slice(i + 1);
      break;
    } else if (a === "council") {
      council = true;
      councilArgs = argv.slice(i + 1);
      break;
    } else if (a === "decisions" || a === "decision") {
      decisions = true;
      decisionsArgs = argv.slice(i + 1);
      break;
    } else if (a === "memory") {
      memory = true;
      memoryArgs = argv.slice(i + 1);
      break;
    } else if (a === "frameworks" || a === "framework") {
      frameworks = true;
      frameworksArgs = argv.slice(i + 1);
      break;
    } else if (a === "lenses" || a === "lens") {
      lenses = true;
      lensesArgs = argv.slice(i + 1);
      break;
    } else if (a === "surface" || a === "insights") {
      surface = true;
      surfaceArgs = argv.slice(i + 1);
      break;
    } else if (a === "modes" || a === "mode") {
      modes = true;
      modesArgs = argv.slice(i + 1);
      break;
    } else if (a === "privacy") {
      privacy = true;
      privacyArgs = argv.slice(i + 1);
      break;
    } else if (a === "search") {
      search = true;
      searchArgs = argv.slice(i + 1);
      break;
    } else if (a === "upgrade" || a === "update" || a === "self-update") {
      upgrade = true;
      upgradeArgs = argv.slice(i + 1);
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
    usage,
    usageArgs,
    pack,
    packArgs,
    appmode,
    appmodeArgs,
    lock,
    lockArgs,
    vault,
    vaultArgs,
    upgrade,
    upgradeArgs,
    manifest,
    manifestArgs,
    chat,
    chatArgs,
    score,
    scoreArgs,
    onboard,
    onboardArgs,
    heartbeat,
    heartbeatArgs,
    gateway,
    gatewayArgs,
    domains,
    domainsArgs,
    council,
    councilArgs,
    decisions,
    decisionsArgs,
    memory,
    memoryArgs,
    frameworks,
    frameworksArgs,
    lenses,
    lensesArgs,
    surface,
    surfaceArgs,
    modes,
    modesArgs,
    privacy,
    privacyArgs,
    search,
    searchArgs,
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
                              (connectors list --json for the machine list)
  prevail mcp                 run as an MCP server (stdio) — exposes council + vault to other agents
                              auth: clients must send Authorization: prevail-<token> from ~/.prevail/mcp.json
                              parent-check: refuses non-TTY / unknown parents — bypass with --unsafe-detach
  prevail bench [...]         run the public council benchmark suite
                              (bench list --json for the machine question list)
  prevail vault [...]         prune old logs, snapshot/restore the vault
                              archive/restore/list-archived domains (--json)
  prevail manifest get|set <domain> --json
                              read/merge a domain's manifest (engine JSON API)
  prevail chat --domain <d> --json
                              stream one chat turn as NDJSON (engine JSON API)
  prevail score <domain> [--audit] --json
                              compute a domain's context-readiness score
  prevail score --all --json  score every domain + life-readiness roll-up
  prevail score history <domain> --json
                              append-only score history ([{ts,score}])
  prevail onboard recommend --json
                              propose a starter domain set (answers JSON on stdin)
  prevail onboard apply --json
                              scaffold the picked domains (picks JSON on stdin)
  prevail heartbeat install --json
                              install OS scheduler hooks for domain heartbeats
  prevail heartbeat status --json
                              report heartbeat install + routine state
  prevail gateway status --json
                              report channel adapters + deterministic per-domain routing
  prevail domains --json      list life domains in the vault (engine JSON API)
  prevail council run --domain <d> --json
                              fan a prompt across the panel + chair; stream NDJSON;
                              flags: --quorum N --lens <id|all|off> --framework <id|off>
                                     --cli claude,codex,… --local-only --message "…"
                              the verdict is persisted to <domain>/_decisions.jsonl
  prevail council feedback --id <decisionId> --rating up|down|clear [--note "…"] --json
                              rate a recorded verdict (feeds the learning loop)
  prevail decisions [list] [<domain>] --json [--limit N]
                              read the domain's decision log, newest-first
  prevail memory read [<domain>] --json
                              distilled long-term memory (_memory.md) for a domain
  prevail surface [<domain>] --json [--force]
                              proactive questions + next actions (cached 6h)
  prevail frameworks list --json / prevail lenses list --json
                              the response-framework / cognitive-lens catalogs
  prevail modes get|set [<domain>] --json
                              per-domain turn dials: --web --save --serendipity
                                                     --auto --framework --lens
  prevail privacy get|set --json [--bunker on|off]
                              read/set Bunker Mode (global local-only switch)
  prevail search <query> --json [--limit N]
                              full-text search across indexed chat history
  prevail daemon --telegram   run the headless Telegram bot + briefing ticker
  prevail upgrade [...]       self-update from the latest GitHub release
                              flags: --check (no prompt) --force (no confirm) --pre (include prereleases)
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
  click [Claude]/[Codex]/[Antigravity]   switch CLI in current chat
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

// usage — token & shadow-cost accounting (P4.7). Reads/writes the vault-scoped
// usage ledger and emits aggregations the desktop dashboard renders.
//   prevail usage record '<json>'           append one turn (used by front-ends)
//   prevail usage [--json]                   raw ledger (default: pretty totals)
//   prevail usage --by day|domain|model|session|cli|surface [--since 7d] [--json]
async function usageCommand(args: string[], vaultOverride: string | null): Promise<void> {
  const { recordUsage, readUsage, aggregateUsage, parseSince, filterByDomain, summarizeAll } = await import("./usage.ts");
  const cfg = readConfig();
  const vault = vaultOverride ?? cfg?.vaultPath ?? bundledDemoVaultPath();

  const sub = args[0];

  if (sub === "record") {
    // The JSON payload may be the next arg or read from stdin.
    let payload = args[1];
    if (!payload) {
      try { payload = readFileSync(0, "utf8"); } catch { payload = ""; }
    }
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(payload || "{}");
    } catch {
      console.error("usage record: expected a JSON object (arg or stdin)");
      process.exit(1);
    }
    if (!input.session || !input.cli) {
      console.error("usage record: 'session' and 'cli' are required");
      process.exit(1);
    }
    const entry = recordUsage(vault, input as never);
    process.stdout.write(JSON.stringify(entry) + "\n");
    return;
  }

  // Parse query flags.
  let by: string | null = null;
  let since: string | undefined;
  let domain: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--by" && args[i + 1]) { by = args[i + 1]!; i++; }
    else if (a === "--since" && args[i + 1]) { since = args[i + 1]!; i++; }
    else if (a === "--domain" && args[i + 1]) { domain = args[i + 1]!; i++; }
    else if (a === "--json") json = true;
  }
  const sinceMs = parseSince(since) ?? undefined;
  const allEntries = readUsage(vault, sinceMs);

  // `summary` — one combined multi-dimension roll-up for a stats dashboard.
  // Always JSON (it's a machine surface). Honors --domain / --since.
  if (sub === "summary") {
    process.stdout.write(JSON.stringify(summarizeAll(allEntries, sinceMs, domain)) + "\n");
    return;
  }

  // Optional per-domain scope (for the domain-level Usage tab). Applied before
  // any aggregation so totals + buckets are all domain-scoped.
  let entries = allEntries;
  if (domain) entries = filterByDomain(entries, domain);

  const VALID = new Set(["day", "domain", "model", "session", "cli", "surface"]);
  if (by && VALID.has(by)) {
    const report = aggregateUsage(entries, by as "day" | "domain" | "model" | "session" | "cli" | "surface", sinceMs);
    if (json) {
      process.stdout.write(JSON.stringify(report) + "\n");
      return;
    }
    console.log(`usage by ${by}${since ? ` (since ${since})` : ""} — ~$${report.total.est_cost_usd.toFixed(4)} across ${report.total.calls} calls\n`);
    for (const b of report.buckets) {
      console.log(`  ~$${b.est_cost_usd.toFixed(4).padStart(9)}  ${String(b.calls).padStart(4)} calls  ${(b.input_tokens + b.output_tokens).toLocaleString().padStart(10)} tok  ${b.key}`);
    }
    return;
  }

  // Default: raw ledger or a quick total.
  if (json) {
    process.stdout.write(JSON.stringify(entries) + "\n");
    return;
  }
  const total = aggregateUsage(entries, "model", sinceMs).total;
  console.log(`usage${since ? ` (since ${since})` : ""}: ~$${total.est_cost_usd.toFixed(4)} shadow cost across ${total.calls} calls, ${(total.input_tokens + total.output_tokens).toLocaleString()} tokens.`);
  console.log("slice it: prevail usage --by day|domain|model|session [--domain <slug>] [--since 7d] [--json]");
}

// Role packages — list / import / export portable persona bundles
// (prevail.pack/v1). See pack.ts.
async function packCommand(args: string[], vaultOverride: string | null): Promise<void> {
  const { parsePack, applyPack, exportPack, listBundledPacks, bundledPackText } =
    await import("./pack.ts");
  const { readFileSync, existsSync } = await import("node:fs");
  const cfg = readConfig();
  const vault = vaultOverride ?? cfg?.vaultPath ?? bundledDemoVaultPath();
  const sub = args[0];
  const asJson = args.includes("--json");

  if (!sub || sub === "list" || sub === "ls") {
    const packs = listBundledPacks();
    if (asJson) {
      process.stdout.write(
        JSON.stringify(packs.map((p) => ({
          file: p.file,
          name: p.pack.name,
          version: p.pack.version,
          description: p.pack.description ?? null,
          domains: p.pack.domains.map((d) => d.slug),
        }))) + "\n",
      );
      return;
    }
    if (packs.length === 0) { console.log("no bundled packs found."); return; }
    console.log(`${packs.length} bundled pack${packs.length === 1 ? "" : "s"}:`);
    for (const { pack } of packs) {
      console.log(`  ${pack.name} (v${pack.version}) — ${pack.domains.map((d) => d.slug).join(", ")}`);
    }
    return;
  }

  if (sub === "import") {
    // The argument may be a path to a .json pack OR a bundled pack name/file.
    const ref = args[1];
    if (!ref) { console.error("usage: prevail pack import <file.json|bundled-name> [--overwrite]"); process.exit(1); }
    const overwrite = args.includes("--overwrite");
    let text: string | null = null;
    if (existsSync(ref)) {
      text = readFileSync(ref, "utf8");
    } else {
      // Resolve against bundled packs by file name or pack name.
      text = bundledPackText(ref);
    }
    if (text == null) {
      const msg = `pack not found: ${ref}`;
      if (asJson) process.stdout.write(JSON.stringify({ error: msg }) + "\n");
      else console.error(msg);
      process.exit(1);
    }
    try {
      const result = applyPack(vault, parsePack(text), { overwrite });
      if (asJson) process.stdout.write(JSON.stringify(result) + "\n");
      else console.log(`imported into ${vault}: created [${result.created.join(", ")}]${result.skipped.length ? `, skipped existing [${result.skipped.join(", ")}]` : ""}`);
    } catch (e) {
      if (asJson) process.stdout.write(JSON.stringify({ error: String(e) }) + "\n");
      else console.error(`pack import failed: ${e}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "export") {
    const nameIdx = args.indexOf("--name");
    const name = nameIdx >= 0 && args[nameIdx + 1] ? args[nameIdx + 1]! : "My Vault";
    const out = exportPack(vault, name);
    process.stdout.write(JSON.stringify(out, null, asJson ? 0 : 2) + "\n");
    return;
  }

  console.error(`unknown pack subcommand: ${sub} (try: list | import | export)`);
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
    if (args.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify(
          questions.map((q) => ({
            id: q.id,
            domain: q.domain,
            stakes: q.stakes,
            verifiable: q.verifiable,
            prompt: q.prompt,
          })),
        )}\n`,
      );
      return;
    }
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
    let scoreAll = false;
    let rescore = false;
    let judgeCliKind: string | null = null;
    let judgeModel: string | null = null;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const v = args[i + 1];
      if (a === "--run" && v) { runName = v; i++; }
      else if (a === "--no-judge") noJudge = true;
      else if (a === "--all") scoreAll = true;
      else if (a === "--rescore") rescore = true;
      else if (a === "--judge-cli" && v) { judgeCliKind = v; i++; }
      else if (a === "--judge-model" && v) { judgeModel = v; i++; }
    }
    const root = runsDir(vault);
    if (!existsSync(root)) {
      console.error(`no runs found under ${root}. run \`prevail bench run --canonical\` first.`);
      process.exit(1);
    }
    // Resolve the judge engine once (shared across --all).
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
    // --all: score every run dir that has results.json but no score.json
    // (or all of them with --rescore). Robust for multi-model batches where
    // "latest by name" would pick the wrong run.
    if (scoreAll) {
      const dirs = readdirSync(root)
        .map((n) => join(root, n))
        .filter((d) => existsSync(join(d, "results.json")))
        .filter((d) => rescore || !existsSync(join(d, "score.json")));
      if (dirs.length === 0) {
        console.log("nothing to score — every run already has a score.json (use --rescore to redo).");
        return;
      }
      for (const runDir of dirs) {
        console.log(`scoring ${runDir.split("/").pop()}${judgeCli ? ` · judge: ${judgeCli.kind}` : " · keyword-only"}…`);
        const result = await scoreRun({
          vaultPath: vault,
          runDir,
          judgeCli,
          judgeModel: judgeModel ?? undefined,
          onProgress: (id) => process.stdout.write(`  ${id}…\r`),
        });
        console.log("");
        console.log(`  ✓ ${result.questionScores.length} q · judge ${result.judge_avg ?? "—"}/10 · kw ${result.keyword_avg ?? "—"}%`);
      }
      console.log(`✓ scored ${dirs.length} run${dirs.length === 1 ? "" : "s"}`);
      return;
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

  // Tolerant domain-filter match: case-insensitive, comma-separated (so
  // "Wealth, Tax" works), and substring-lenient. A question matches if any
  // filter token equals or is contained in (or contains) its domain.
  function matchesDomainFilter(qDomain: string, filterValue: string): boolean {
    const tokens = filterValue.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (tokens.length === 0) return true;
    const d = qDomain.toLowerCase();
    return tokens.some((t) => d === t || d.includes(t) || t.includes(d));
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
    if (domain) filtered = filtered.filter((q) => matchesDomainFilter(q.domain, domain));
    if (questionId) filtered = filtered.filter((q) => q.id === questionId);
    if (filtered.length === 0) {
      const avail = [...new Set(questions.map((q) => q.domain))].sort().join(", ");
      console.error(`no questions matched "${domain ?? questionId}". Available domains: ${avail || "(none)"}`);
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
        filtered = filtered.filter((q) => matchesDomainFilter(q.domain, v));
        i++;
      } else if (a === "--question" && v) {
        filtered = filtered.filter((q) => q.id === v);
        i++;
      }
    }
    if (filtered.length === 0) {
      const avail = [...new Set(questions.map((q) => q.domain))].sort().join(", ");
      console.error(`no questions matched the filter. Available domains: ${avail || "(none)"}`);
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
    if (args.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify(
          apps.map((a) => ({
            id: a.id,
            title: a.title,
            integration: a.integration ?? "manual",
            path: a.path,
          })),
        )}\n`,
      );
      return;
    }
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

// --- JSON command helpers -------------------------------------------------
//
// The `manifest` / `vault archive|restore|list-archived` commands all break out
// of the global arg loop before it parses --vault/--json, so they pull those
// flags out of their own sub-args here. Positional (non-flag) tokens are
// returned separately so callers can read e.g. the <domain> argument.
interface JsonSubArgs {
  positionals: string[];
  json: boolean;
  vaultPath: string | null;
  localOnly: boolean;
}

function parseJsonSubArgs(args: string[], vaultOverride: string | null): JsonSubArgs {
  const positionals: string[] = [];
  let json = false;
  let vaultPath = vaultOverride;
  let localOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--local-only") localOnly = true;
    else if (a === "--vault" || a === "-d") {
      const next = args[i + 1];
      if (next) {
        vaultPath = resolve(process.cwd(), next);
        i++;
      }
    } else if (a.startsWith("--vault=")) {
      vaultPath = resolve(process.cwd(), a.slice("--vault=".length));
    } else if (!a.startsWith("-")) {
      positionals.push(a);
    }
  }
  return { positionals, json, vaultPath, localOnly };
}

// Write the frozen error envelope from docs/ENGINE-JSON-API.md to stdout and
// exit non-zero. JSON mode only — callers fall back to console.error otherwise.
function emitJsonError(message: string, code: string): never {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message, code })}\n`);
  process.exit(1);
}

// Deep-merge a partial manifest (from stdin) onto the existing one. Plain
// objects merge recursively; arrays and scalars from the patch replace the
// base. Used by `manifest set` per the JSON API contract.
function deepMerge<T>(base: T, patch: unknown): T {
  if (
    patch === null ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    base === null ||
    typeof base !== "object" ||
    Array.isArray(base)
  ) {
    return (patch === undefined ? base : (patch as T));
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge((out[k] as unknown) ?? null, v);
  }
  return out as T;
}

async function readJsonStdin(): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

async function manifestCommand(args: string[], vaultOverride: string | null): Promise<void> {
  const sub = args[0];
  const rest = parseJsonSubArgs(args.slice(1), vaultOverride);
  const cfg = readConfig();
  const vault = rest.vaultPath ?? cfg?.vaultPath ?? bundledDemoVaultPath();
  const domain = rest.positionals[0];

  if (sub !== "get" && sub !== "set") {
    if (rest.json) emitJsonError(`unknown manifest subcommand: ${sub ?? "(none)"}`, "BAD_SUBCOMMAND");
    console.error("usage:");
    console.error("  prevail manifest get <domain> --json");
    console.error("  prevail manifest set <domain> --json   (body on stdin)");
    process.exit(1);
  }
  if (!domain) {
    if (rest.json) emitJsonError("missing required argument: <domain>", "MISSING_ARG");
    console.error(`usage: prevail manifest ${sub} <domain> --json`);
    process.exit(1);
  }
  if (!rest.json) {
    console.error("manifest get/set require --json (machine-only command).");
    process.exit(1);
  }
  if (!existsSync(vault)) emitJsonError(`vault path not found: ${vault}`, "VAULT_NOT_FOUND");

  const { ensureManifest, writeManifest } = await import("./manifest.ts");

  if (sub === "get") {
    try {
      const m = ensureManifest(vault, domain);
      process.stdout.write(`${JSON.stringify(m)}\n`);
    } catch (err) {
      emitJsonError((err as Error).message, "MANIFEST_GET_FAILED");
    }
    return;
  }

  // sub === "set"
  let patch: unknown;
  try {
    patch = await readJsonStdin();
  } catch (err) {
    emitJsonError(`invalid JSON on stdin: ${(err as Error).message}`, "BAD_JSON");
  }
  try {
    const existing = ensureManifest(vault, domain);
    const merged = deepMerge(existing, patch);
    writeManifest(vault, domain, merged);
    // Re-read so we echo the normalized, schema-stamped result.
    const result = ensureManifest(vault, domain);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    emitJsonError((err as Error).message, "MANIFEST_SET_FAILED");
  }
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

  // `vault embed [--from <src>]` — copy the active (or given) vault into the
  // app-owned location ~/.prevail/vault and repoint config there. Non-
  // destructive: the source is left in place. Shared by the desktop "Move vault
  // into the app" action and the CLI.
  if (sub === "embed" || sub === "migrate") {
    const { migrateVaultToEmbedded, embeddedVaultPath } = await import("./vault-embed.ts");
    let from = vault;
    const fromIdx = args.indexOf("--from");
    if (fromIdx >= 0 && args[fromIdx + 1]) from = args[fromIdx + 1]!;
    const asJson = args.includes("--json");
    try {
      const r = migrateVaultToEmbedded(from, embeddedVaultPath());
      // Point config at the embedded vault so every surface uses it next launch.
      if (r.ok) {
        const { writeConfig } = await import("./config.ts");
        writeConfig({ ...(cfg ?? {}), vaultPath: r.dest } as never);
      }
      if (asJson) {
        process.stdout.write(JSON.stringify(r) + "\n");
      } else if (r.alreadyEmbedded) {
        console.log(`vault is already embedded at ${r.dest}`);
      } else {
        console.log(`embedded ${r.copied}/${r.sourceFiles} files into ${r.dest}${r.ok ? "" : "  (verify mismatch!)"}`);
        console.log(`source left intact at ${from}`);
      }
    } catch (e) {
      if (asJson) process.stdout.write(JSON.stringify({ error: String(e) }) + "\n");
      else console.error(`vault embed failed: ${e}`);
      process.exit(1);
    }
    return;
  }

  // Vault encryption (F4 Phase 1). Passcode is read from STDIN, never argv.
  //   encrypt: create/load keyring, encrypt the vault in place, SELF-VERIFY by
  //            reading it back, and AUTO-ROLLBACK (decrypt) if verification fails
  //            — so a wiring gap can never leave the vault unreadable.
  //   decrypt: unlock with the passcode and restore plaintext.
  //   unlock:  return the DEK (base64) for the host to hold + pass to the engine
  //            via PREVAIL_VAULT_KEY on subsequent calls.
  if (sub === "encrypt" || sub === "decrypt" || sub === "unlock") {
    const asJson = args.includes("--json");
    const readStdin = (): string => {
      try { return readFileSync(0, "utf8").replace(/\r?\n$/, ""); } catch { return ""; }
    };
    const passcode = readStdin();
    const crypto = await import("./vault-crypto.ts");
    const ops = await import("./vault-encrypt-ops.ts");
    const session = await import("./vault-session.ts");
    const out = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify(o) + "\n");
    try {
      if (sub === "unlock") {
        const kr = ops.loadKeyring();
        if (!kr) { out({ ok: false, error: "vault is not encrypted" }); return; }
        if (!crypto.verifyKeyringPasscode(passcode, kr)) { out({ ok: false, error: "wrong passcode" }); return; }
        out({ ok: true, key: crypto.unwrapDek(passcode, kr).toString("base64") });
        return;
      }
      if (sub === "decrypt") {
        const kr = ops.loadKeyring();
        if (!kr) { out({ ok: false, error: "vault is not encrypted" }); return; }
        if (!crypto.verifyKeyringPasscode(passcode, kr)) { out({ ok: false, error: "wrong passcode" }); return; }
        const dek = crypto.unwrapDek(passcode, kr);
        const r = ops.decryptVaultInPlace(vault, dek);
        out({ ok: true, files: r.files });
        return;
      }
      // encrypt
      if (passcode.length < 4) { out({ ok: false, error: "passcode must be at least 4 characters" }); return; }
      if (ops.isVaultEncrypted(vault)) { out({ ok: false, error: "vault is already encrypted" }); return; }
      // Baseline: how many domains read in the clear, to verify against later.
      const { scanVault } = await import("./vault.ts");
      const before = scanVault(vault).length;
      // New keyring (with recovery code) unless one already exists.
      let dek: Buffer;
      let recoveryCode: string | undefined;
      const existing = ops.loadKeyring();
      if (existing) {
        if (!crypto.verifyKeyringPasscode(passcode, existing)) { out({ ok: false, error: "wrong passcode" }); return; }
        dek = crypto.unwrapDek(passcode, existing);
      } else {
        const created = crypto.createKeyringWithRecovery(passcode, new Date().toISOString());
        dek = created.dek;
        recoveryCode = created.recoveryCode;
        ops.saveKeyring(created.keyring);
      }
      ops.encryptVaultInPlace(vault, dek);
      // SELF-VERIFY: read the vault back through the session decryptor.
      session.setVaultSession(dek, true);
      const after = scanVault(vault).length;
      session.setVaultSession(null, false);
      if (after < before) {
        // Roll back — encryption made the vault less readable than before.
        ops.decryptVaultInPlace(vault, dek);
        out({ ok: false, error: `verification failed (${after}/${before} domains readable) — rolled back, vault left plaintext` });
        return;
      }
      out({ ok: true, files: before, recoveryCode: recoveryCode ?? null, verified: `${after}/${before} domains` });
    } catch (e) {
      out({ ok: false, error: String(e) });
      process.exit(1);
    }
    return;
  }

  // JSON engine subcommands (archive / restore / list-archived) — defined by
  // docs/ENGINE-JSON-API.md. They read --vault/--json from their own sub-args
  // and emit the frozen error envelope on failure.
  if (sub === "archive" || sub === "restore" || sub === "list-archived") {
    const { archiveDomain, restoreDomain, listArchived } = await import("./vault-ops.ts");
    const rest = parseJsonSubArgs(args.slice(1), vaultOverride);
    const jsonVault = rest.vaultPath ?? cfg?.vaultPath ?? bundledDemoVaultPath();
    if (!rest.json) {
      console.error(`prevail vault ${sub} is a machine-only command — pass --json.`);
      process.exit(1);
    }
    if (!existsSync(jsonVault)) emitJsonError(`vault path not found: ${jsonVault}`, "VAULT_NOT_FOUND");

    if (sub === "list-archived") {
      try {
        process.stdout.write(`${JSON.stringify(listArchived(jsonVault))}\n`);
      } catch (err) {
        emitJsonError((err as Error).message, "LIST_ARCHIVED_FAILED");
      }
      return;
    }

    const domain = rest.positionals[0];
    if (!domain) emitJsonError("missing required argument: <domain>", "MISSING_ARG");

    if (sub === "archive") {
      try {
        await archiveDomain(jsonVault, domain);
        process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
      } catch (err) {
        emitJsonError((err as Error).message, "ARCHIVE_FAILED");
      }
      return;
    }
    // sub === "restore"
    try {
      restoreDomain(jsonVault, domain);
      process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    } catch (err) {
      emitJsonError((err as Error).message, "RESTORE_FAILED");
    }
    return;
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
    let asJson = false;
    let domain: string | null = null;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const v = args[i + 1];
      if (a === "--json") asJson = true;
      else if ((a === "--output" || a === "-o") && v) {
        output = resolve(process.cwd(), v);
        i++;
      } else if (a === "--domain" && v) {
        domain = v;
        i++;
      }
    }
    if (!output) output = defaultBackupPath();
    if (!existsSync(vault)) {
      if (asJson) emitJsonError(`vault path not found: ${vault}`, "VAULT_NOT_FOUND");
      console.error(`vault path not found: ${vault}`);
      process.exit(1);
    }
    if (!asJson) console.log(`backing up ${domain ? `${vault}/${domain}` : vault} → ${output}…`);
    try {
      const r = await backupVault({ vaultPath: vault, outputPath: output, domain: domain ?? undefined });
      if (asJson) {
        // Emit snake_case keys to match the desktop's BackupResult contract.
        process.stdout.write(`${JSON.stringify({
          ok: true,
          archive_path: r.archivePath,
          bytes: r.bytes,
          file_count: r.fileCount,
          domains: r.domains,
          scope: r.scope,
          created_at: r.createdAt,
        })}\n`);
      } else {
        console.log(`✓ wrote ${r.archivePath} (${formatBytes(r.bytes)}, ${r.fileCount} files)`);
      }
    } catch (err) {
      if (asJson) emitJsonError((err as Error).message, "BACKUP_FAILED");
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
  console.error("  prevail vault archive <domain> --json   archive a domain (engine JSON API)");
  console.error("  prevail vault restore <domain> --json   un-archive a domain (engine JSON API)");
  console.error("  prevail vault list-archived --json      list archived domain names");
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

async function upgradeCommand(args: string[]): Promise<void> {
  const {
    checkForUpdate,
    downloadBinary,
    applyUpgrade,
    currentBinaryPath,
    extractIfArchive,
    platformSlug,
  } = await import("./upgrade.ts");
  let checkOnly = false;
  let force = false;
  let includePrerelease = false;
  for (const a of args) {
    if (a === "--check") checkOnly = true;
    else if (a === "--force" || a === "-y") force = true;
    else if (a === "--pre" || a === "--prerelease") includePrerelease = true;
  }
  console.log("checking for updates…");
  let info: Awaited<ReturnType<typeof checkForUpdate>>;
  try {
    info = await checkForUpdate({ includePrerelease });
  } catch (err) {
    console.error(`upgrade check failed: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`current: v${info.current}`);
  console.log(`latest:  v${info.latest} — ${info.releaseUrl}`);
  if (!info.isNewer) {
    console.log(`already on latest (v${info.current}). nothing to do.`);
    return;
  }
  if (checkOnly) {
    // --check just reports; nothing else to do.
    return;
  }
  if (!info.binaryUrl) {
    console.error(
      `release v${info.latest} has no asset matching '${platformSlug()}'. Download it manually from ${info.releaseUrl}.`,
    );
    process.exit(1);
  }
  if (!force) {
    const answer = await promptYesNo("upgrade?");
    if (!answer) {
      console.log("aborted.");
      return;
    }
  }
  // Download into the same directory as the current binary so the eventual
  // rename(2) is atomic (same filesystem). Cross-FS renames silently fall
  // back to copy + unlink, which we explicitly don't want.
  const { tmpdir: _tmpdir } = await import("node:os");
  const { join: joinPath, dirname: _dirname } = await import("node:path");
  const current = currentBinaryPath();
  const stageDir = _dirname(current);
  // Preserve the asset's extension on the staged file so extractIfArchive
  // can tell what to do. The bug was that downloads ended in `.upgrade.<pid>`
  // with no extension; tar would never get invoked even when the asset was
  // a tarball, and applyUpgrade tried to rename a .tar.gz over the live
  // binary — bricking the install on success and silently failing on the
  // download side.
  const downloadName = info.binaryUrl.split("/").pop() ?? "prevail.bin";
  const ext = downloadName.endsWith(".tar.gz")
    ? ".tar.gz"
    : downloadName.endsWith(".tgz")
      ? ".tgz"
      : "";
  const stageName = `.prevail.upgrade.${process.pid}.${Date.now()}${ext}`;
  let stagePath = joinPath(stageDir, stageName);
  // If the binary's directory isn't writable we'll catch that in applyUpgrade,
  // but we should also avoid leaving cruft there — fall back to tmpdir for
  // the download in that case. (applyUpgrade will then fail cleanly with the
  // brew-install hint.)
  try {
    const { accessSync, constants } = await import("node:fs");
    accessSync(stageDir, constants.W_OK);
  } catch {
    stagePath = joinPath(_tmpdir(), stageName);
  }
  console.log(`downloading ${info.binaryUrl} → ${stagePath}…`);
  try {
    await downloadBinary(info.binaryUrl, info.sha256Url, stagePath);
  } catch (err) {
    console.error(`download failed: ${(err as Error).message}`);
    process.exit(1);
  }
  // If the asset was a tarball, extract and apply the binary inside it.
  // For raw binaries this is a no-op (returns the input path unchanged).
  let binaryToApply: string;
  try {
    binaryToApply = extractIfArchive(stagePath);
  } catch (err) {
    console.error(`extract failed: ${(err as Error).message}`);
    process.exit(1);
  }
  try {
    await applyUpgrade(binaryToApply, current);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  console.log(`upgraded to v${info.latest}. relaunch to use the new version.`);
}

function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(`${question} [y/N] `);
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.includes("\n")) {
        process.stdin.off("data", onData);
        try { process.stdin.pause(); } catch { /* ignore */ }
        const answer = buf.trim().toLowerCase();
        resolve(answer === "y" || answer === "yes");
      }
    };
    process.stdin.on("data", onData);
    try { process.stdin.resume(); } catch { /* ignore */ }
  });
}

// --- Wave 2 engine commands (score / onboard / heartbeat) -----------------
//
// These mirror the manifest/vault/chat JSON-API pattern: they break out of the
// global arg loop before --vault/--json are parsed, so each resolves the vault
// default (override → config → bundled demo) and hands the post-subcommand args
// to the engine module, which emits the frozen JSON contract on stdout (or the
// error envelope) and returns a process exit code.

function resolveVault(vaultOverride: string | null): string {
  const cfg = readConfig();
  return vaultOverride ?? cfg?.vaultPath ?? bundledDemoVaultPath();
}

// `prevail score <domain> [--audit] --json` / `score --all --json` /
// `score history <domain> --json`
async function scoreCommand(args: string[], vaultOverride: string | null): Promise<number> {
  const { scoreCommand: runScore } = await import("./score.ts");
  return runScore(args, resolveVault(vaultOverride));
}

// `prevail onboard recommend --json` (answers JSON on stdin) /
// `prevail onboard apply --json` (picks JSON on stdin)
async function onboardCommand(args: string[], vaultOverride: string | null): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  const vault = resolveVault(vaultOverride);
  const { onboardRecommendCommand, onboardApplyCommand } = await import("./onboard.ts");
  if (sub === "recommend") return onboardRecommendCommand(rest, vault);
  if (sub === "apply") return onboardApplyCommand(rest, vault);
  // Unknown/missing subcommand. Honor --json with the frozen error envelope.
  if (args.includes("--json")) {
    emitJsonError(`unknown onboard subcommand: ${sub ?? "(none)"}`, "BAD_SUBCOMMAND");
  }
  console.error("usage:");
  console.error("  prevail onboard recommend --json   (answers JSON on stdin)");
  console.error("  prevail onboard apply --json       (picks JSON on stdin)");
  return 1;
}

// `prevail heartbeat install --json` / `prevail heartbeat status --json`
async function heartbeatCommand(args: string[], vaultOverride: string | null): Promise<number> {
  const sub = args[0];
  const rest = parseJsonSubArgs(args.slice(1), vaultOverride);
  const vault = rest.vaultPath ?? resolveVault(vaultOverride);

  if (sub !== "install" && sub !== "status") {
    if (rest.json) emitJsonError(`unknown heartbeat subcommand: ${sub ?? "(none)"}`, "BAD_SUBCOMMAND");
    console.error("usage:");
    console.error("  prevail heartbeat install --json");
    console.error("  prevail heartbeat status --json");
    return 1;
  }
  if (!rest.json) {
    console.error(`prevail heartbeat ${sub} is a machine-only command — pass --json.`);
    return 1;
  }
  if (!existsSync(vault)) emitJsonError(`vault path not found: ${vault}`, "VAULT_NOT_FOUND");

  const { handleInstall, handleStatus } = await import("./heartbeat.ts");
  try {
    const result = sub === "install" ? handleInstall(vault) : handleStatus(vault);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    emitJsonError((err as Error).message, sub === "install" ? "INSTALL_FAILED" : "STATUS_FAILED");
  }
}

// `prevail gateway status --json` — machine-only deterministic routing status.
// Pure read: scans the vault + manifests, reports configured channels and the
// per-domain routing keywords. No adapters started, no model called.
async function gatewayCommand(args: string[], vaultOverride: string | null): Promise<number> {
  const sub = args[0];
  const rest = parseJsonSubArgs(args.slice(1), vaultOverride);
  const vault = rest.vaultPath ?? resolveVault(vaultOverride);

  if (sub !== "status") {
    if (rest.json) emitJsonError(`unknown gateway subcommand: ${sub ?? "(none)"}`, "BAD_SUBCOMMAND");
    console.error("usage:");
    console.error("  prevail gateway status --json");
    return 1;
  }
  if (!rest.json) {
    console.error("prevail gateway status is a machine-only command — pass --json.");
    return 1;
  }
  if (!existsSync(vault)) emitJsonError(`vault path not found: ${vault}`, "VAULT_NOT_FOUND");

  const { gatewayStatusCommand } = await import("./gateway/gateway.ts");
  try {
    const result = gatewayStatusCommand(vault);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    emitJsonError((err as Error).message, "STATUS_FAILED");
  }
}

// `prevail domains --json` — machine-only list of life domains in the vault.
// Pure read: returns the scanVault projection (name, path, hasState, summary).
async function domainsCommand(args: string[], vaultOverride: string | null): Promise<number> {
  const rest = parseJsonSubArgs(args, vaultOverride);
  const vault = rest.vaultPath ?? resolveVault(vaultOverride);

  if (!rest.json) {
    console.error("prevail domains is a machine-only command — pass --json.");
    return 1;
  }
  if (!existsSync(vault)) emitJsonError(`vault path not found: ${vault}`, "VAULT_NOT_FOUND");

  const { scanVault } = await import("./vault.ts");
  try {
    const domains = scanVault(vault).map((d) => ({
      name: d.name,
      path: d.path,
      hasState: d.hasState,
      openLoopCount: d.openLoopCount,
      stateMtime: d.stateMtime,
      summary: d.manifestSummary?.summary ?? "",
      label: d.manifestSummary?.label ?? d.name,
      emoji: d.manifestSummary?.emoji ?? "",
    }));
    process.stdout.write(`${JSON.stringify(domains)}\n`);
    return 0;
  } catch (err) {
    emitJsonError((err as Error).message, "DOMAINS_FAILED");
  }
}

// Lightweight flag parser for the small machine commands below: collects
// positionals, `--flag value` / `--flag=value` pairs, and bare `--json`.
// Value-less flags (those that never take an argument) are listed in `bools`.
function parseKvArgs(
  args: string[],
  vaultOverride: string | null,
  bools: string[] = [],
): { positionals: string[]; json: boolean; vaultPath: string | null; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  let json = false;
  let vaultPath = vaultOverride;
  const boolSet = new Set(["--json", "--local-only", ...bools]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--vault" || a === "-d") {
      const next = args[i + 1];
      if (next) {
        vaultPath = resolve(process.cwd(), next);
        i++;
      }
    } else if (a.startsWith("--vault=")) {
      vaultPath = resolve(process.cwd(), a.slice("--vault=".length));
    } else if (a.startsWith("--") && a.includes("=")) {
      flags[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      if (boolSet.has(a)) {
        flags[key] = "true";
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = "true";
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, json, vaultPath, flags };
}

// `prevail decisions [list|read] [<domain>] --json [--limit N]` — read the
// domain's append-only decision log newest-first (vault root = General).
async function decisionsCommand(args: string[], vaultOverride: string | null): Promise<number> {
  const head = args[0];
  const body = head === "list" || head === "read" ? args.slice(1) : args;
  const { positionals, json, vaultPath, flags } = parseKvArgs(body, vaultOverride);
  const vault = vaultPath ?? resolveVault(vaultOverride);
  if (!json) {
    console.error("prevail decisions is a machine-only command — pass --json.");
    return 1;
  }
  if (!existsSync(vault)) emitJsonError(`vault path not found: ${vault}`, "VAULT_NOT_FOUND");
  const domain = positionals[0];
  const general = !domain || domain === "general" || domain === "__general__";
  const limit = flags.limit ? Number.parseInt(flags.limit, 10) : undefined;
  const { readDecisions } = await import("./decisions.ts");
  try {
    const out = readDecisions(vault, general ? null : domain, Number.isNaN(limit) ? undefined : limit);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  } catch (err) {
    emitJsonError((err as Error).message, "DECISIONS_FAILED");
  }
}

// `prevail memory read [<domain>] --json` — the distilled long-term memory
// (`<domain>/_memory.md`; vault root for General). { domain, text }.
async function memoryCommand(args: string[], vaultOverride: string | null): Promise<number> {
  const head = args[0];
  const body = head === "read" ? args.slice(1) : args;
  const { positionals, json, vaultPath } = parseKvArgs(body, vaultOverride);
  const vault = vaultPath ?? resolveVault(vaultOverride);
  if (!json) {
    console.error("prevail memory is a machine-only command — pass --json.");
    return 1;
  }
  if (!existsSync(vault)) emitJsonError(`vault path not found: ${vault}`, "VAULT_NOT_FOUND");
  const domain = positionals[0];
  const general = !domain || domain === "general" || domain === "__general__";
  const { domainDir } = await import("./decisions.ts");
  const file = join(domainDir(vault, general ? null : domain), "_memory.md");
  let text = "";
  try {
    if (existsSync(file)) text = readFileSync(file, "utf8");
  } catch (err) {
    emitJsonError((err as Error).message, "MEMORY_READ_FAILED");
  }
  process.stdout.write(`${JSON.stringify({ domain: domain ?? "general", text })}\n`);
  return 0;
}

// `prevail frameworks list --json` — the response-framework catalog.
async function frameworksCommand(args: string[]): Promise<number> {
  const json = args.includes("--json");
  if (!json) {
    console.error("prevail frameworks is a machine-only command — pass --json.");
    return 1;
  }
  const { FRAMEWORKS } = await import("./framework.ts");
  const out = FRAMEWORKS.map((f) => ({ id: f.id, label: f.label, blurb: f.blurb }));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}

// `prevail lenses list --json` — the cognitive-lens catalog.
async function lensesCommand(args: string[]): Promise<number> {
  const json = args.includes("--json");
  if (!json) {
    console.error("prevail lenses is a machine-only command — pass --json.");
    return 1;
  }
  const { LENSES } = await import("./lens.ts");
  const out = LENSES.map((l) => ({ id: l.id, label: l.label, blurb: l.blurb }));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}

// `prevail modes get|set [<domain>] --json` — read/write the per-domain turn
// dials (web/save/serendipity/auto + framework/lens). Set flags:
//   --web allow|deny  --save on|off  --serendipity on|off
//   --auto off|suggest|auto  --framework <id>|off  --lens <id>|all|off
async function modesCommand(args: string[], vaultOverride: string | null): Promise<number> {
  const sub = args[0];
  const body = sub === "get" || sub === "set" ? args.slice(1) : args;
  const { positionals, json, flags } = parseKvArgs(body, vaultOverride);
  if (!json) {
    console.error("prevail modes is a machine-only command — pass --json.");
    return 1;
  }
  const domain = positionals[0];
  const domainKey = !domain || domain === "general" || domain === "__general__" ? undefined : domain;
  const cfg = await import("./config.ts");
  const fw = await import("./framework.ts");
  const ln = await import("./lens.ts");

  if (sub === "set") {
    if (flags.web === "allow" || flags.web === "deny") cfg.setWebAccess(flags.web);
    if (flags.save === "on" || flags.save === "off") cfg.setCheckpoint(flags.save === "on", domainKey);
    if (flags.serendipity === "on" || flags.serendipity === "off")
      cfg.setSerendipity(flags.serendipity === "on", domainKey);
    if (flags.auto === "off" || flags.auto === "suggest" || flags.auto === "auto")
      cfg.setAutoCouncil(flags.auto, domainKey);
    if (flags.framework !== undefined) {
      const v = flags.framework;
      cfg.setResponseFramework(v === "off" || v === "" ? null : fw.isFrameworkId(v) ? v : null, domainKey);
    }
    if (flags.lens !== undefined) {
      const v = flags.lens;
      const sel = v === "off" || v === "" ? null : v === "all" ? "all" : ln.isLensId(v) ? v : null;
      cfg.setResponseLens(sel, domainKey);
    }
  }

  const out = {
    domain: domain ?? "general",
    web: cfg.readWebAccess(),
    save: cfg.readCheckpoint(domainKey),
    serendipity: cfg.readSerendipity(domainKey),
    auto: cfg.readAutoCouncil(domainKey),
    framework: cfg.resolveResponseFramework(domainKey),
    lens: cfg.resolveResponseLens(domainKey),
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}

// `prevail privacy get|set --json [--bunker on|off]` — Bunker Mode (local-only)
// is a persisted, global flag. Frontends read it to decide whether to pass
// --local-only on every engine call (the desktop sets PREVAIL_BUNKER).
async function privacyCommand(args: string[]): Promise<number> {
  const sub = args[0];
  const body = sub === "get" || sub === "set" ? args.slice(1) : args;
  const { json, flags } = parseKvArgs(body, null);
  if (!json) {
    console.error("prevail privacy is a machine-only command — pass --json.");
    return 1;
  }
  const cfg = await import("./config.ts");
  if (sub === "set" && (flags.bunker === "on" || flags.bunker === "off")) {
    cfg.setBunker(flags.bunker === "on");
  }
  process.stdout.write(`${JSON.stringify({ bunker: cfg.readBunker() })}\n`);
  return 0;
}

// `prevail appmode get|set --json [--mode demo|production]` — the demo vs
// production flag. Frontends read it to show the demo badge and gate the
// switch-to-production flow. Machine-only (JSON).
async function appmodeCommand(args: string[]): Promise<number> {
  const sub = args[0];
  const body = sub === "get" || sub === "set" ? args.slice(1) : args;
  const { json, flags } = parseKvArgs(body, null);
  if (!json) {
    console.error("prevail appmode is a machine-only command — pass --json.");
    return 1;
  }
  const cfg = await import("./config.ts");
  if (sub === "set" && (flags.mode === "demo" || flags.mode === "production")) {
    cfg.setAppMode(flags.mode);
  }
  process.stdout.write(`${JSON.stringify({ mode: cfg.readAppMode() })}\n`);
  return 0;
}

// `prevail lock status|set|verify|clear --json` — app passcode gate (Phase 0).
// The passcode is read from STDIN (never argv, so it can't leak into the
// process list or shell history). Machine-only (JSON).
async function lockCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!args.includes("--json")) {
    console.error("prevail lock is a machine-only command — pass --json.");
    return 1;
  }
  const lock = await import("./lock.ts");
  const readStdin = (): string => {
    try { return readFileSync(0, "utf8").replace(/\r?\n$/, ""); } catch { return ""; }
  };
  if (sub === "status") {
    process.stdout.write(`${JSON.stringify({ set: lock.isLockSet() })}\n`);
    return 0;
  }
  // For verify/set/clear the JSON {ok} field IS the contract — a wrong passcode
  // or validation failure is a normal result, not an execution error, so we
  // always exit 0 (a non-zero exit would make a calling process treat
  // "wrong passcode" as a spawn failure).
  if (sub === "set") {
    const pass = readStdin();
    try {
      await lock.setPasscode(pass, new Date().toISOString());
      process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    } catch (e) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: String(e) })}\n`);
    }
    return 0;
  }
  if (sub === "verify") {
    const ok = await lock.verifyPasscode(readStdin());
    process.stdout.write(`${JSON.stringify({ ok })}\n`);
    return 0;
  }
  if (sub === "clear") {
    // Require the current passcode to authorize removal.
    if (!(await lock.verifyPasscode(readStdin()))) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: "wrong passcode" })}\n`);
      return 0;
    }
    lock.clearLock();
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    return 0;
  }
  console.error(`unknown lock subcommand: ${sub} (status | set | verify | clear)`);
  return 1;
}

// `prevail search <query> --json [--limit N]` — full-text search across the
// indexed chat history (the FTS5 index in ~/.prevail/sessions.db).
async function searchCommand(args: string[]): Promise<number> {
  const { positionals, json, flags } = parseKvArgs(args, null);
  if (!json) {
    console.error("prevail search is a machine-only command — pass --json.");
    return 1;
  }
  const query = positionals.join(" ").trim();
  if (!query) emitJsonError("missing search query", "MISSING_ARG");
  const limit = flags.limit ? Number.parseInt(flags.limit, 10) : 20;
  const { searchMessages } = await import("./session.ts");
  try {
    const hits = searchMessages(query, Number.isNaN(limit) ? 20 : limit);
    process.stdout.write(`${JSON.stringify(hits)}\n`);
    return 0;
  } catch (err) {
    emitJsonError((err as Error).message, "SEARCH_FAILED");
  }
}

async function main() {
  // Pick up an encrypted-vault session key (base64 DEK in PREVAIL_VAULT_KEY,
  // supplied by the host) before any vault read happens. No key / plaintext
  // vault = pure passthrough, so this is a no-op for the common case.
  const { initVaultSession } = await import("./vault-session.ts");
  initVaultSession();
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
  if (args.usage) {
    await usageCommand(args.usageArgs, args.vaultPath);
    return;
  }
  if (args.pack) {
    await packCommand(args.packArgs, args.vaultPath);
    return;
  }
  if (args.appmode) {
    process.exit(await appmodeCommand(args.appmodeArgs));
  }
  if (args.lock) {
    process.exit(await lockCommand(args.lockArgs));
  }
  if (args.vault) {
    await vaultCommand(args.vaultArgs, args.vaultPath);
    return;
  }
  if (args.manifest) {
    await manifestCommand(args.manifestArgs, args.vaultPath);
    return;
  }
  if (args.chat) {
    const { chatJsonCommand } = await import("./chat-json.ts");
    const code = await chatJsonCommand(args.chatArgs, args.vaultPath);
    process.exit(code);
  }
  if (args.score) {
    const code = await scoreCommand(args.scoreArgs, args.vaultPath);
    process.exit(code);
  }
  if (args.onboard) {
    const code = await onboardCommand(args.onboardArgs, args.vaultPath);
    process.exit(code);
  }
  if (args.heartbeat) {
    const code = await heartbeatCommand(args.heartbeatArgs, args.vaultPath);
    process.exit(code);
  }
  if (args.gateway) {
    const code = await gatewayCommand(args.gatewayArgs, args.vaultPath);
    process.exit(code);
  }
  if (args.domains) {
    const code = await domainsCommand(args.domainsArgs, args.vaultPath);
    process.exit(code);
  }
  if (args.council) {
    const { councilCommand } = await import("./council-json.ts");
    const code = await councilCommand(args.councilArgs, args.vaultPath);
    process.exit(code);
  }
  if (args.decisions) {
    const code = await decisionsCommand(args.decisionsArgs, args.vaultPath);
    process.exit(code);
  }
  if (args.memory) {
    const code = await memoryCommand(args.memoryArgs, args.vaultPath);
    process.exit(code);
  }
  if (args.frameworks) {
    const code = await frameworksCommand(args.frameworksArgs);
    process.exit(code);
  }
  if (args.lenses) {
    const code = await lensesCommand(args.lensesArgs);
    process.exit(code);
  }
  if (args.surface) {
    const { surfaceCommand } = await import("./surface.ts");
    const code = await surfaceCommand(args.surfaceArgs, args.vaultPath);
    process.exit(code);
  }
  if (args.modes) {
    const code = await modesCommand(args.modesArgs, args.vaultPath);
    process.exit(code);
  }
  if (args.privacy) {
    const code = await privacyCommand(args.privacyArgs);
    process.exit(code);
  }
  if (args.search) {
    const code = await searchCommand(args.searchArgs);
    process.exit(code);
  }
  if (args.daemon) {
    await daemonCommand(args.daemonArgs, args.vaultPath);
    return;
  }
  if (args.upgrade) {
    await upgradeCommand(args.upgradeArgs);
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
