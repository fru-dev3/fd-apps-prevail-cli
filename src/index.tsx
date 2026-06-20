#!/usr/bin/env bun
// PERF: the TUI framework (@opentui) + the App/wizard component trees are heavy
// and are ONLY needed for the interactive cockpit. They used to be imported at
// the top level, so EVERY headless command (score, recommendations, connectors,
// daemon, chat-json…) paid ~400ms loading the whole terminal UI it never renders.
// They're now dynamically imported inside runWizard()/launchCockpit() only.
import { resolve, join, basename, dirname } from "node:path";
import { resolveDomainDir, buildRoot } from "./path-safety.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { bundledDemoVaultPath, readConfig, writeConfig, } from "./config.ts";

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
  recommendations: boolean;
  recommendationsArgs: string[];
  suggestApps: boolean;
  suggestAppsArgs: string[];
  scout: boolean;
  scoutArgs: string[];
  mcp: boolean;
  mcpUnsafeDetach: boolean;
  mcpNetwork: boolean;
  bench: boolean;
  benchArgs: string[];
  usage: boolean;
  usageArgs: string[];
  pack: boolean;
  packArgs: string[];
  appmode: boolean;
  appmodeArgs: string[];
  models: boolean;
  modelsArgs: string[];
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
  alignment: boolean;
  alignmentArgs: string[];
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
  let recommendations = false;
  let recommendationsArgs: string[] = [];
  let suggestApps = false;
  let suggestAppsArgs: string[] = [];
  let scout = false;
  let scoutArgs: string[] = [];
  let mcp = false;
  let mcpUnsafeDetach = false;
  let mcpNetwork = false;
  let bench = false;
  let benchArgs: string[] = [];
  let usage = false;
  let usageArgs: string[] = [];
  let pack = false;
  let packArgs: string[] = [];
  let appmode = false;
  let appmodeArgs: string[] = [];
  let models = false;
  let modelsArgs: string[] = [];
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
  let alignment = false;
  let alignmentArgs: string[] = [];
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
    } else if (a === "recommendations" || a === "recommend") {
      recommendations = true;
      recommendationsArgs = argv.slice(i + 1);
      break;
    } else if (a === "suggest-apps") {
      suggestApps = true;
      suggestAppsArgs = argv.slice(i + 1);
      break;
    } else if (a === "scout-models") {
      scout = true;
      scoutArgs = argv.slice(i + 1);
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
        // MCP-1: --network opts INTO per-request token auth (for any non-stdio /
        // network-exposed transport). Default stdio relies on parent verification.
        else if (f === "--network" || f === "--require-token") mcpNetwork = true;
        // BUGFIX (B2-11): the MCP launch config passes `mcp --vault <path>`, but
        // this loop used to ignore --vault and then break out of arg parsing, so
        // the server started on the WRONG vault and failed to connect. Parse it
        // here too. (Handles a path with spaces fine - it's a single argv token.)
        else if (f === "--vault" || f === "-d") { if (argv[j + 1]) { vaultPath = resolve(process.cwd(), argv[j + 1]); j++; } }
        else if (f.startsWith("--vault=")) { vaultPath = resolve(process.cwd(), f.slice("--vault=".length)); }
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
    } else if (a === "models") {
      models = true;
      modelsArgs = argv.slice(i + 1);
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
    } else if (a === "alignment" || a === "align") {
      alignment = true;
      alignmentArgs = argv.slice(i + 1);
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
    recommendations,
    recommendationsArgs,
    suggestApps,
    suggestAppsArgs,
    scout,
    scoutArgs,
    mcp,
    mcpUnsafeDetach,
    mcpNetwork,
    bench,
    benchArgs,
    usage,
    usageArgs,
    pack,
    packArgs,
    appmode,
    appmodeArgs,
    models,
    modelsArgs,
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
    alignment,
    alignmentArgs,
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

// Build DeliveryHooks for briefing delivery channels.
// Checks which connectors are authenticated and returns hooks that call
// the appropriate connector skill. Channels not backed by a live connector
// are omitted — the caller will log "skipped (no connector)".
async function buildBriefingHooks(
  vault: string,
  channels: string[],
): Promise<import("./briefings.ts").DeliveryHooks> {
  const hooks: import("./briefings.ts").DeliveryHooks = {};
  if (!channels.length) return hooks;

  const { scanCommunityApps } = await import("./vault.ts");
  const { loadSkillsForConnector, runSkill } = await import("./connector-skills.ts");
  const { probeConnector } = await import("./connector-probe.ts");
  const apps = scanCommunityApps();

  if (channels.includes("email")) {
    const gmailApp = apps.find((a) => a.id === "gmail");
    if (gmailApp) {
      const probe = await probeConnector(gmailApp, (gmailApp.authCheck as import("./connector-probe.ts").AuthCheckSpec | null) ?? null);
      if (probe.ok) {
        const skills = loadSkillsForConnector(gmailApp);
        const sendSkill = skills.find((s) => s.id === "send-reply");
        if (sendSkill) {
          hooks.email = async (subject: string, body: string) => {
            const r = await runSkill(sendSkill, { subject, body }, { autonomy: "act" });
            if (!r.ok) throw new Error(r.message);
            return r.summary ?? "sent";
          };
        }
      }
    }
  }

  if (channels.includes("drive")) {
    const driveApp = apps.find((a) => a.id === "google-drive" || a.id === "gdrive");
    if (driveApp) {
      const probe = await probeConnector(driveApp, (driveApp.authCheck as import("./connector-probe.ts").AuthCheckSpec | null) ?? null);
      if (probe.ok) {
        const skills = loadSkillsForConnector(driveApp);
        const saveSkill = skills.find((s) => s.id === "save-doc" || s.id === "upload");
        if (saveSkill) {
          hooks.drive = async (subject: string, body: string) => {
            const r = await runSkill(saveSkill, { subject, body }, { autonomy: "act" });
            if (!r.ok) throw new Error(r.message);
            return r.summary ?? "saved";
          };
        }
      }
    }
  }

  return hooks;
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
    let channels: ("email" | "drive")[] = [];
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
      } else if ((a === "--channels" || a === "--channel") && v) {
        channels = v.split(",").map((s) => s.trim()).filter((s): s is "email" | "drive" => s === "email" || s === "drive");
        i++;
      }
    }
    if (!cron || !domain || !prompt) {
      console.error('usage: prevail briefing add --cron "<cron>" --domain <name> --prompt "<text>" [--mode council] [--deliver telegram|both] [--channels email,drive]');
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
      channels: channels.length ? channels : undefined,
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
    if (channels.length) console.log(`  channels: ${channels.join(", ")}`);
    if (deliver !== "log") {
      console.log("");
      console.log("note: telegram delivery requires the daemon: prevail daemon --telegram");
    }
    if (channels.length) {
      console.log("");
      console.log("note: email/drive channels require the connector to be authenticated.");
      console.log("  Gmail: prevail connectors oauth gmail");
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
    // Parse optional flags for this subcommand.
    let id = "";
    let extraChannels: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if ((a === "--channels" || a === "--channel") && args[i + 1]) {
        extraChannels = args[i + 1]!.split(",").map((s) => s.trim()).filter(Boolean);
        i++;
      } else if (!a.startsWith("--") && !id) {
        id = a;
      }
    }
    if (!id) {
      console.error("usage: prevail briefing run <id> [--channels email,drive]");
      process.exit(1);
    }
    const list = loadBriefings(vault);
    const entry = list.find((b) => b.id === id);
    if (!entry) {
      console.error(`no briefing with id ${id}`);
      process.exit(1);
    }
    console.log(`running ${entry.id}: ${entry.name}`);

    // Build DeliveryHooks so email/drive channels actually fire.
    // Extra channels from --channels flag are merged with entry.channels.
    const activeChannels = [...new Set([...(entry.channels ?? []), ...extraChannels])];
    const hooks = await buildBriefingHooks(vault, activeChannels);

    const r = await runBriefing({ ...entry, channels: activeChannels }, vault, undefined, undefined, hooks);
    if (r.error) {
      console.error(`error: ${r.error}`);
      process.exit(1);
    }
    entry.last_run = r.ts;
    saveBriefings(vault, list);
    console.log("");
    console.log(r.output);
    console.log("");
    const chLine = r.delivered.channels
      ? Object.entries(r.delivered.channels).map(([k, v]) => `${k}: ${v}`).join(", ")
      : "";
    console.log(`delivered to log: ${r.delivered.log}, telegram: ${r.delivered.telegram}${chLine ? ", channels: " + chLine : ""}`);
    return;
  }

  console.error(`unknown briefing subcommand: ${sub}\n`);
  console.error("usage:");
  console.error("  prevail briefing list");
  console.error('  prevail briefing add --cron "<cron>" --domain <name> --prompt "<text>" [--mode council] [--deliver telegram|both]');
  console.error("  prevail briefing remove <id>");
  console.error("  prevail briefing run <id> [--channels email,drive]");
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
    const { vreadFile } = await import("./vault-session.ts");
    let runName: string | null = null;
    let noJudge = false;
    let scoreAll = false;
    let rescore = false;
    let batchId: string | null = null;
    let judgeCliKind: string | null = null;
    let judgeModel: string | null = null;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const v = args[i + 1];
      if (a === "--run" && v) { runName = v; i++; }
      else if (a === "--no-judge") noJudge = true;
      else if (a === "--all") scoreAll = true;
      else if (a === "--batch" && v) { batchId = v; i++; }
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
      let allClis = await detectClis();
      // Bunker Mode: the judge is an LLM call too. Only a local judge may run;
      // with none available, degrade to the mechanical keyword pass instead of
      // failing the whole scoring run.
      if (process.env.PREVAIL_BUNKER === "1") {
        const LOCAL_CLIS = new Set(["ollama", "lmstudio", "mlx"]);
        if (judgeCliKind && !LOCAL_CLIS.has(judgeCliKind)) {
          console.error(`Blocked by Bunker Mode: judge ${judgeCliKind} is a cloud provider. Using keyword scoring only.`);
          judgeCliKind = null;
          noJudge = true;
        }
        allClis = allClis.filter((c) => LOCAL_CLIS.has(c.kind));
        if (!noJudge && allClis.length === 0) {
          console.error("Blocked by Bunker Mode: no local judge available. Using keyword scoring only.");
          noJudge = true;
        }
      }
      if (!noJudge) {
        judgeCli = judgeCliKind
          ? allClis.find((c) => c.kind === judgeCliKind)
          : allClis.find((c) => c.kind === "claude") ?? allClis[0];
        if (!judgeCli) {
          console.error("no CLI available to act as judge. install one or pass --no-judge.");
          process.exit(1);
        }
      }
    }
    // --batch <id>: score ONLY the run dirs from one batch (the models launched
    // together) - what the desktop uses after a run, so it never re-scores the
    // whole history. --all: score every unscored run. Both write score.json.
    if (scoreAll || batchId) {
      const dirs = readdirSync(root)
        .map((n) => join(root, n))
        .filter((d) => existsSync(join(d, "results.json")))
        .filter((d) => {
          if (batchId) {
            try { return (JSON.parse(vreadFile(join(d, "batch.json"))) as { id?: string }).id === batchId; }
            catch { return false; }
          }
          return true;
        })
        .filter((d) => rescore || !existsSync(join(d, "score.json")));
      if (dirs.length === 0) {
        console.log(batchId ? `nothing to score for batch ${batchId}.` : "nothing to score — every run already has a score.json (use --rescore to redo).");
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

  if (sub === "export-results") {
    // Public Prevail Benchmark export: model x domain matrix + leaderboard.
    const { buildPublicResults } = await import("./canonical-bench.ts");
    let output: string | null = null;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if ((a === "--output" || a === "-o") && args[i + 1]) { output = resolve(process.cwd(), args[i + 1]); i++; }
    }
    // Stamp time outside the pure builder (kept deterministic for tests).
    const results = buildPublicResults(vault, new Date().toISOString());
    const json = JSON.stringify(results, null, 2);
    if (output) {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(join(output, ".."), { recursive: true });
      writeFileSync(output, json + "\n");
      console.error(`wrote ${results.models.length} models x ${results.domains.length} domains -> ${output}`);
    } else {
      process.stdout.write(json + "\n");
    }
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
    let batchId: string | null = null;
    let batchLabel: string | null = null;
    let useCouncil = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const v = args[i + 1];
      if (a === "--canonical") continue;
      if (a === "--domain" && v) { domain = v; i++; }
      else if (a === "--question" && v) { questionId = v; i++; }
      else if (a === "--cli" && v) { targetCliKind = v; i++; }
      else if (a === "--model" && v) { targetModel = v; i++; }
      else if (a === "--batch" && v) { batchId = v; i++; }
      else if (a === "--batch-label" && v) { batchLabel = v; i++; }
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
    let allClis = await detectClis();
    if (allClis.length === 0) {
      console.error("no CLIs detected — install claude / codex / gemini / ollama first");
      process.exit(1);
    }
    // Bunker Mode (PREVAIL_BUNKER=1, set by the desktop): benchmarks may only
    // run local providers. A cloud target is REFUSED, never silently switched:
    // a benchmark that quietly swaps models would lie about what it measured.
    const LOCAL_CLIS = new Set(["ollama", "lmstudio", "mlx"]);
    if (process.env.PREVAIL_BUNKER === "1") {
      if (useCouncil) {
        console.error("Blocked by Bunker Mode: council benchmarks convene cloud models. Turn Bunker Mode off, or run a local model instead.");
        process.exit(1);
      }
      if (targetCliKind && !LOCAL_CLIS.has(targetCliKind)) {
        console.error(`Blocked by Bunker Mode: ${targetCliKind} is a cloud provider. Pick a local model (ollama, lmstudio, mlx).`);
        process.exit(1);
      }
      allClis = allClis.filter((c) => LOCAL_CLIS.has(c.kind));
      if (allClis.length === 0) {
        console.error("Blocked by Bunker Mode: no local model provider is running. Start Ollama (or LM Studio / MLX) first.");
        process.exit(1);
      }
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
        // Newline-terminated markers so each reaches the desktop immediately (a
        // no-newline in-flight write can sit in Bun's pipe buffer until the slow
        // model answer lands, making the run look frozen). The desktop shows the
        // current question from the `> ` start line and counts the `  id… info`
        // completion lines.
        if (status === "start") console.log(`> ${id}`);
        else if (status === "ok") console.log(`  ${id}… ${info ?? "ok"}`);
        else console.log(`  ${id}… ✗ ${info ?? "error"}`);
      },
    });
    const dir = writeRunDirectory({
      vaultPath: vault,
      records,
      targetCli,
      targetModel: targetModel ?? undefined,
      batchId: batchId ?? undefined,
      batchLabel: batchLabel ?? undefined,
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

  if (sub === "suggest") {
    // AI-draft canonical questions from each domain's own context.
    // Usage: prevail bench suggest --domain <name|all|a,b,c> [--count <n>] [--cli <kind>] [--model <id>]
    const { writeDraftQuestion, ensureScaffold } = await import("./canonical-bench.ts");
    const { detectClis } = await import("./cli-bridge.ts");
    const { existsSync: exists, readFileSync: readFile, readdirSync: readDir } = await import("node:fs");
    const { join } = await import("node:path");

    let domainArg: string | null = null;
    let count = 3;
    let cliKind: string | null = null;
    let model: string | null = null;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const v = args[i + 1];
      if (a === "--domain" && v) { domainArg = v.toLowerCase(); i++; }
      else if (a === "--count" && v) { count = Math.max(1, Math.min(10, parseInt(v, 10) || 3)); i++; }
      else if (a === "--cli" && v) { cliKind = v; i++; }
      else if (a === "--model" && v) { model = v; i++; }
    }
    if (!domainArg) {
      console.error("usage: prevail bench suggest --domain <name|all|a,b,c> [--count <n>] [--cli <kind>] [--model <id>]");
      process.exit(1);
    }

    // Resolve the domain list: "all" = every vault domain; csv also works.
    let domains: string[];
    if (domainArg === "all") {
      const { scanVault } = await import("./vault.ts");
      domains = scanVault(vault).map((d) => d.name.toLowerCase());
      if (domains.length === 0) {
        console.error("no domains found in vault");
        process.exit(1);
      }
    } else {
      domains = domainArg.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    }

    let clis = await detectClis();
    // Bunker Mode: drafting is an LLM call; only local providers may run.
    if (process.env.PREVAIL_BUNKER === "1") {
      const LOCAL_CLIS = new Set(["ollama", "lmstudio", "mlx"]);
      if (cliKind && !LOCAL_CLIS.has(cliKind)) {
        console.error(`Blocked by Bunker Mode: ${cliKind} is a cloud provider. Pick a local model (ollama, lmstudio, mlx).`);
        process.exit(1);
      }
      clis = clis.filter((c) => LOCAL_CLIS.has(c.kind));
      if (clis.length === 0) {
        console.error("Blocked by Bunker Mode: no local model provider is running. Start Ollama (or LM Studio / MLX) first.");
        process.exit(1);
      }
    }
    const cli = cliKind ? clis.find((c) => c.kind === cliKind) : clis.find((c) => c.kind === "claude") ?? clis[0];
    if (!cli) {
      console.error("no AI CLI available. Install claude, codex, or another supported CLI first.");
      process.exit(1);
    }
    console.log(`using ${cli.kind}${model ? ` (${model})` : " (default model)"} to draft ${count} question${count === 1 ? "" : "s"} per domain, ${domains.length} domain${domains.length === 1 ? "" : "s"}`);

    const { runChatTurn } = await import("./cli-bridge.ts");
    ensureScaffold(vault);
    let totalWritten = 0;
    let okDomains = 0;
    const failures: string[] = [];

    for (const domain of domains) {
      const domainDir = resolveDomainDir(vault, domain);
      if (!exists(domainDir)) {
        failures.push(`${domain}: domain directory not found`);
        continue;
      }
      const readCtx = (file: string, max: number): string => {
        try {
          const p = join(domainDir, file);
          if (!exists(p)) return "";
          const t = readFile(p, "utf8");
          return t.length > max ? t.slice(0, max) + "\n…(truncated)" : t;
        } catch { return ""; }
      };
      // Context: recorded state when there is one, plus (or, for a fresh
      // domain, instead) whatever the domain does have on disk. A domain
      // with no chats yet can still get sensible starter questions from its
      // goals/config/soul.
      let threadCtx = "";
      try {
        const tdir = join(domainDir, "_threads");
        if (exists(tdir)) {
          const mds = readDir(tdir).filter((f) => f.endsWith(".md")).sort();
          const latest = mds[mds.length - 1];
          if (latest) {
            const t = readFile(join(tdir, latest), "utf8");
            threadCtx = t.length > 2000 ? t.slice(0, 2000) + "\n…(truncated)" : t;
          }
        }
      } catch { /* no threads */ }
      // BENCH-3: also ground in the domain's recent decision logs (_log/*.md) —
      // the self-curating record of what actually happened. Questions drawn from
      // real logged decisions test accuracy against the user's real life, not
      // synthetic prompts.
      let logCtx = "";
      try {
        const ldir = join(domainDir, "_log");
        if (exists(ldir)) {
          const logs = readDir(ldir).filter((f) => f.endsWith(".md")).sort();
          const recent = logs.slice(-3); // most recent few days
          const parts = recent.map((f) => `## ${f}\n${readFile(join(ldir, f), "utf8")}`);
          logCtx = parts.join("\n\n");
          if (logCtx.length > 2500) logCtx = logCtx.slice(0, 2500) + "\n…(truncated)";
        }
      } catch { /* no logs */ }
      // K6: ground drafts in the user's cross-cutting truth — their profile (who
      // they are, real numbers/constraints) and ideal-state constitution (how
      // THEY weigh trade-offs). Without these the model drafts generic textbook
      // questions; with them it captures this person's specific nuance.
      const readVaultRoot = (file: string, max: number): string => {
        try {
          const p = join(vault, file);
          if (!exists(p)) return "";
          const t = readFile(p, "utf8");
          return t.length > max ? t.slice(0, max) + "\n…(truncated)" : t;
        } catch { return ""; }
      };
      // Profile + ideal-state are app-support: they live under build/ (canonical),
      // not the vault root. Read from buildRoot, with root kept only as a legacy
      // fallback for un-migrated vaults.
      const readBuild = (file: string, max: number): string => {
        try {
          const p = join(buildRoot(vault), file);
          if (!exists(p)) return "";
          const t = readFile(p, "utf8");
          return t.length > max ? t.slice(0, max) + "\n…(truncated)" : t;
        } catch { return ""; }
      };
      const profileCtx = readBuild("_profile.md", 2500) || readBuild("profile.md", 2500) || readVaultRoot("profile.md", 2500) || readVaultRoot("user.md", 2500);
      const idealCtx = readBuild("ideal-state.md", 1500) || readVaultRoot("ideal-state.md", 1500);
      const sections = ([
        ["WHO THEY ARE — user profile", profileCtx],
        ["HOW THEY DECIDE — ideal-state constitution", idealCtx],
        ["_state.md", readCtx("_state.md", 3000) || readCtx("state.md", 3000)],
        ["goals.md", readCtx("goals.md", 1500)],
        ["config.md", readCtx("config.md", 800)],
        ["soul.md", readCtx("soul.md", 800)],
        ["_tasks.md", readCtx("_tasks.md", 800)],
        ["_memory.md", readCtx("_memory.md", 1200)],
        ["recent _log decisions", logCtx],
        ["latest thread", threadCtx],
      ] as [string, string][]).filter(([, t]) => t);
      if (sections.length === 0) {
        failures.push(`${domain}: nothing to draft from (no state, goals, config, soul, tasks, or threads)`);
        continue;
      }

      const prompt = [
        `You are helping build a personal canonical benchmark for the "${domain}" life domain.`,
        `Based on the context below, generate exactly ${count} high-quality benchmark question${count === 1 ? "" : "s"}.`,
        "",
        "Each question must be something this person would actually ask their AI council — grounded in their real situation, open-ended enough to reveal model quality, and answerable with a clear recommendation.",
        "",
        "Make every question SPECIFIC to THIS person: reference their real numbers, names, accounts, deadlines, and constraints from the context, and the particular way they weigh trade-offs (from their profile and constitution). A good question is one only they would ask, with their details baked in. Reject generic, textbook questions anyone could ask — the entire value is in their nuance. Favor cross-domain tension where it exists (e.g. a choice that pits one domain's goal against another's).",
        "",
        "REQUIRED OUTPUT: a single JSON object, no preamble, no markdown fences, no explanation.",
        `Shape: {"questions":[{"prompt":"...","expected_decision":"...","expected_verdict_keywords":["kw1","kw2","kw3"]},...]}`,
        "",
        "Fields:",
        `- prompt: the question as the user would type it (1-3 sentences, specific to their situation)`,
        `- expected_decision: one short sentence — what a good answer SHOULD recommend`,
        `- expected_verdict_keywords: 2-4 substrings a correct answer must contain (lowercase)`,
        ...sections.flatMap(([name, text]) => ["", `=== ${domain}/${name} ===`, text]),
      ].join("\n");

      console.log(`${domain}: drafting…`);
      let raw = "";
      try {
        raw = await runChatTurn({ prompt, cwd: domainDir, cli, model: model ?? "", isFirst: true });
      } catch (e) {
        failures.push(`${domain}: LLM call failed: ${e}`);
        continue;
      }

      // Parse response — strip fences, find JSON
      let text = raw.trim();
      const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
      if (fence) text = fence[1].trim();
      const startIdx = text.indexOf("{");
      if (startIdx < 0) {
        failures.push(`${domain}: could not parse LLM response as JSON`);
        continue;
      }
      let parsed: { questions?: unknown[] } | null = null;
      try { parsed = JSON.parse(text.slice(startIdx)) as typeof parsed; } catch {}
      if (!parsed || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
        failures.push(`${domain}: LLM returned no questions`);
        continue;
      }

      let written = 0;
      for (const q of parsed.questions) {
        if (!q || typeof q !== "object") continue;
        const qo = q as Record<string, unknown>;
        const qPrompt = typeof qo.prompt === "string" ? qo.prompt.trim() : "";
        if (!qPrompt) continue;
        const path = writeDraftQuestion({
          vaultPath: vault,
          domain,
          prompt: qPrompt,
          expected_decision: typeof qo.expected_decision === "string" ? qo.expected_decision : undefined,
          expected_verdict_keywords: Array.isArray(qo.expected_verdict_keywords)
            ? (qo.expected_verdict_keywords as unknown[]).filter((k) => typeof k === "string") as string[]
            : undefined,
        });
        written++;
        console.log(`  wrote: ${path}`);
      }
      if (written === 0) {
        failures.push(`${domain}: no valid questions found in LLM response`);
        continue;
      }
      totalWritten += written;
      okDomains++;
    }

    for (const f of failures) console.error(`failed: ${f}`);
    if (totalWritten === 0) {
      console.error("no questions drafted");
      process.exit(1);
    }
    console.log(`\ndrafted ${totalWritten} question${totalWritten === 1 ? "" : "s"} across ${okDomains} domain${okDomains === 1 ? "" : "s"}. Review expected_decision + keywords before running.`);
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
  const { readSyncState } = await import("./daemon-sync.ts");
  const apps = scanCommunityApps();
  const sub = args[0];
  if (!sub || sub === "list" || sub === "ls") {
    if (args.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify(
          apps.map((a) => {
            // Per-app sync state (next due + recent run log) so the desktop can
            // show "next sync" and a recent-activity log, not just last success.
            let nextDueTs: number | null = null;
            let runs: Array<Record<string, unknown>> = [];
            let firstFetchOk = false;
            try { const st = readSyncState(a); nextDueTs = st.next_due_ts; runs = (st.runs ?? []).slice(-5); firstFetchOk = st.first_fetch_ok; } catch { /* none yet */ }
            return {
            id: a.id,
            title: a.title,
            integration: a.integration ?? "manual",
            path: a.path,
            // Enriched for the desktop Apps view: real connection + sync state.
            status: a.status,
            configured: a.configured,
            domains: a.domains ?? [],
            lastSuccessTs: a.lastSuccessTs ?? null,
            lastError: a.lastError ?? null,
            account: a.account ?? null,
            refresh: a.refresh ?? null,
            autonomy: a.autonomy ?? null,
            // Absent in the manifest = enabled; only an explicit false disables.
            enabled: a.enabled ?? true,
            community: a.community,
            connections: a.connections ?? null,
            nextDueTs,
            runs,
            // The fetch gate: has this connector EVER pulled real data? The
            // desktop uses it (with lastSuccessTs) to separate a fetch-verified
            // "connected" from "authorized · verifying".
            firstFetchOk,
            // Generic per-method auth: credential env-var names + MCP setup hint.
            authEnvVars: a.authEnvVars ?? [],
            mcpSetup: a.mcpSetup ?? null,
            };
          }),
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
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ id: app.id, ...r })}\n`);
      process.exit(0); // structured callers read `ok`/`status`, not the exit code
    }
    console.log(`${app.title}: ${r.status}`);
    console.log(`  ${r.message}`);
    if (r.fixHint) console.log(`  fix: ${r.fixHint}`);
    if (r.missing && r.missing.length > 0) console.log(`  missing: ${r.missing.join(", ")}`);
    process.exit(r.ok ? 0 : 2);
  }
  if (sub === "remove" || sub === "rm" || sub === "delete") {
    // Fully delete a user-installed connector (its whole folder under
    // ~/.prevail/apps). Bundled connectors are read-only and refused. This is the
    // mirror of `connect` - it lets the user recreate a connector cleanly.
    const id = args[1];
    if (!id) { console.error("usage: prevail connectors remove <id>"); process.exit(1); }
    const app = apps.find((a) => a.id === id);
    const { rmSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { resolve, sep } = await import("node:path");
    const fail = (msg: string) => {
      if (args.includes("--json")) { process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`); process.exit(0); }
      console.error(msg); process.exit(1);
    };
    if (!app) return fail(`no connector with id "${id}"`);
    // Guard: only remove folders under the user apps dir (or the dev override).
    const userRoots = [resolve(homedir(), ".prevail", "apps")];
    if (process.env.PREVAIL_APPS_DIR) userRoots.push(resolve(process.env.PREVAIL_APPS_DIR));
    const resolved = resolve(app.path);
    const underUser = userRoots.some((root) => resolved === root || resolved.startsWith(root + sep));
    if (!underUser) return fail(`"${id}" is a bundled connector and cannot be deleted; only connectors you installed (under ~/.prevail/apps) can be removed.`);
    try {
      rmSync(app.path, { recursive: true, force: true });
    } catch (e) {
      return fail(`could not delete "${id}": ${e instanceof Error ? e.message : String(e)}`);
    }
    if (args.includes("--json")) { process.stdout.write(`${JSON.stringify({ ok: true, id, removed: app.path })}\n`); process.exit(0); }
    console.log(`removed connector "${id}" (${app.path})`);
    return;
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
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(skills.map((s) => ({ id: s.id, runner: s.runner, trigger: s.trigger ?? "on-demand" })))}\n`);
      return;
    }
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
  if (sub === "browser-login") {
    // Agentic browser auth: open a REAL browser to the site's login page so the
    // user does only the irreducible step (their own password / 2FA), then persist
    // the session to <app>/auth/state.json so every later headless scrape reuses
    // it. This is how a browser-automation connector (Airbnb, Booking, etc.) gets
    // PAST an auth wall - Prevail drives it, the user just logs in.
    const id = args[1];
    const json = args.includes("--json");
    const fail = (msg: string) => {
      if (json) { process.stdout.write(`${JSON.stringify({ ok: false, error: msg })}\n`); process.exit(0); }
      console.error(msg); process.exit(1);
    };
    if (!id) return fail("usage: prevail connectors browser-login <id> [--url <login-url>]");
    const app = apps.find((a) => a.id === id);
    if (!app) return fail(`no connector with id "${id}"`);
    // Resolve the login URL with fallbacks so login ALWAYS has somewhere to open:
    //   1) explicit --url, 2) the manifest's login_url/homepage,
    //   3) a homepage DERIVED from the connector id (e.g. airbnb -> airbnb.com,
    //      booking-com -> booking.com, credit-karma -> creditkarma.com).
    // The user never has to hand-edit a manifest just to log in.
    let url = "";
    const uflag = args.indexOf("--url");
    if (uflag >= 0 && args[uflag + 1]) url = args[uflag + 1]!;
    if (!url) {
      try {
        const { readFileSync } = await import("node:fs");
        const m = JSON.parse(readFileSync(join(app.path, "manifest.json"), "utf8")) as Record<string, unknown>;
        url = (typeof m.login_url === "string" && m.login_url) || (typeof m.homepage === "string" && m.homepage) || "";
      } catch { /* no manifest url */ }
    }
    if (!url) {
      const s = id.toLowerCase().trim();
      const tld = s.match(/-(com|org|net|io|co|app|ai|dev)$/);
      url = tld
        ? `https://www.${s.slice(0, -tld[0].length).replace(/-/g, "")}.${tld[1]}`
        : `https://www.${s.replace(/[^a-z0-9]/g, "")}.com`;
    }
    if (!json) console.log(`opening a browser to ${url} - log in, then close the window…`);
    const { runBrowserLogin } = await import("./runners.ts");
    const r = await runBrowserLogin(app.path, url);
    if (json) { process.stdout.write(`${JSON.stringify(r)}\n`); process.exit(0); }
    if (r.ok) { console.log(`✓ ${r.message}`); console.log(`\nverify with: prevail connectors sync ${id}`); }
    else { console.error(`✗ ${r.message}`); process.exit(1); }
    return;
  }
  if (sub === "connect") {
    // prevail connectors connect --name <app> --goal <what to pull> --vault <path> [--cli] [--model] [--json]
    // The Connection Agent: research the best way to connect this app RIGHT NOW
    // (MCP > API/CLI > Composio > browser), scaffold the app, and return a plan
    // with the ONE auth step the user must do. Describe-the-goal, not forms.
    const flag = (name: string): string | undefined => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const name = flag("--name");
    const goal = flag("--goal") ?? "";
    const vaultArg = flag("--vault");
    const provider = flag("--cli") ?? "claude";
    const model = flag("--model") ?? "";
    // Re-evaluate mode: don't scaffold (the app already exists) — just research
    // and report whether a better method exists now. --current is the app's
    // current integration so the agent can give a meaningful comparison.
    const reevaluate = args.includes("--reevaluate");
    const current = flag("--current") ?? "";
    if (!name || !vaultArg) {
      console.error("usage: prevail connectors connect --name <app> --goal <text> --vault <path>");
      process.exit(1);
    }
    const { detectClis, runChatTurn } = await import("./cli-bridge.ts");
    const { scanVault, scaffoldCommunityApp } = await import("./vault.ts");
    const domainNames = scanVault(vaultArg).map((d) => d.name);
    const clis = await detectClis();
    const cli = clis.find((c) => c.kind === provider) ?? clis[0];
    if (!cli) { process.stdout.write(`${JSON.stringify({ ok: false, error: "no CLI available" })}\n`); process.exit(0); }
    const prompt = [
      `You are Prevail's Connection Agent. The user wants to connect an app so it syncs real data into their personal life-OS vault on a schedule.`,
      `APP: ${name}`,
      `GOAL: ${goal || "(pull the most useful data this app offers)"}`,
      `THE USER'S DOMAINS: ${domainNames.join(", ") || "(none yet)"}`,
      reevaluate && current ? `\nThis app is ALREADY connected via "${current}". Re-check whether a BETTER method exists now; if "${current}" is still best, return it.` : "",
      "",
      `Determine the BEST available way to connect this app RIGHT NOW. Prefer headless, in this order: an MCP server > an official API/SDK or an already-installed CLI (e.g. gcloud, gh) > the Composio gateway > browser automation (a one-time login is acceptable). Use web search to check what actually exists today for this specific app.`,
      "",
      `Also provide an auth_check: a CONCRETE test Prevail can run to VERIFY the connection works, so the user doesn't have to. For an installed CLI use {"kind":"command","command":"gh","args":["auth","status"]} (exits 0 iff authed). For an HTTP API use {"kind":"http","url":"<a lightweight authed GET endpoint>","auth_header_env":"PREVAIL_<APP>_KEY","expect_status":200}. If nothing can be tested without a secret the user hasn't provided yet, omit it (kind "none").`,
      "",
      `Return ONLY a JSON object (no prose, no fences):`,
      `{"app_id":"kebab-case-id","title":"display name","integration":"mcp|api|cli|composio|browser","why":"one line: why this is the best method now","auth_step":{"kind":"none|oauth-cli|api-key|browser-login|manual","instruction":"the ONE thing the user must do to authorize, or empty if none"},"auth_check":{"kind":"command|http|none","command":"","args":[],"url":"","auth_header_env":"","expect_status":200},"schedule":{"every":"1d"},"domains":["which of the user's domains this should feed"],"data":"one line: what it will pull in"}`,
    ].join("\n");
    const out = await runChatTurn({ prompt, cwd: vaultArg, cli, model, isFirst: true, bare: true, act: true });
    const s = out.indexOf("{"), e = out.lastIndexOf("}");
    let plan: Record<string, unknown> | null = null;
    if (s >= 0 && e > s) { try { plan = JSON.parse(out.slice(s, e + 1)); } catch { plan = null; } }
    if (!plan || typeof plan.app_id !== "string") {
      process.stdout.write(`${JSON.stringify({ ok: false, error: "could not determine a connection method", raw: out.slice(0, 300) })}\n`);
      process.exit(0);
    }
    // Re-evaluate is research-only: report the plan without scaffolding (the app
    // already exists, and scaffolding would fail with "already exists").
    if (reevaluate) {
      process.stdout.write(`${JSON.stringify({ ok: true, plan, reevaluated: true })}\n`);
      process.exit(0);
    }
    const integ = (["api", "oauth", "browser", "mcp", "cli", "manual"].includes(plan.integration as string) ? plan.integration : "manual") as "api" | "oauth" | "browser" | "mcp" | "cli" | "manual";
    const planDomains = Array.isArray(plan.domains) ? (plan.domains as string[]).filter((d) => domainNames.includes(d)) : [];
    const authCheck = (plan.auth_check && typeof plan.auth_check === "object" && (plan.auth_check as Record<string, unknown>).kind && (plan.auth_check as Record<string, unknown>).kind !== "none")
      ? (plan.auth_check as Record<string, unknown>) : null;
    const refreshEvery = (plan.schedule && typeof plan.schedule === "object") ? ((plan.schedule as Record<string, unknown>).every as string | undefined) ?? null : null;
    const scaffold = scaffoldCommunityApp({ id: plan.app_id as string, title: (plan.title as string) || name, integration: integ, domains: planDomains, authCheck, refreshEvery });
    // Autonomous verify: if no user action is required (auth_step.kind === "none")
    // and we have a testable auth_check, run it NOW and report proof — the agent
    // confirms success instead of telling the user to. When a secret IS required,
    // we return the single auth step; the desktop re-runs this check after it.
    let verified: boolean | null = null;
    let proof: string | null = null;
    const authStepKind = (plan.auth_step && typeof plan.auth_step === "object") ? (plan.auth_step as Record<string, unknown>).kind : "none";
    if (scaffold.ok && authCheck && (authStepKind === "none" || !authStepKind)) {
      try {
        const { probeConnector } = await import("./connector-probe.ts");
        const { scanApps } = await import("./vault.ts");
        const fresh = scanApps(vaultArg).find((a) => a.id === (plan.app_id as string));
        if (fresh) {
          const r = await probeConnector(fresh, authCheck as unknown as import("./connector-probe.ts").AuthCheckSpec);
          verified = r.ok;
          proof = r.ok ? (r.message || "connection test passed") : (r.fixHint || r.message || `test failed (${r.status})`);
        }
      } catch (e) { verified = false; proof = `could not run the test: ${e}`; }
    }
    process.stdout.write(`${JSON.stringify({ ok: scaffold.ok, plan, path: scaffold.path, error: scaffold.error, verified, proof })}\n`);
    process.exit(0);
  }
  if (sub === "add") {
    // prevail connectors add --id <id> --title <t> --integration <api|oauth|browser|mcp|cli|manual> --domains a,b [--json]
    const flag = (name: string): string | undefined => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const id = flag("--id");
    const title = flag("--title") ?? id;
    const integration = (flag("--integration") ?? "manual") as "api" | "oauth" | "browser" | "mcp" | "cli" | "manual";
    const domains = (flag("--domains") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!id) {
      console.error("usage: prevail connectors add --id <id> --title <t> --integration <api|oauth|browser|mcp|cli|manual> --domains a,b");
      process.exit(1);
    }
    const { scaffoldCommunityApp } = await import("./vault.ts");
    const r = scaffoldCommunityApp({ id, title: title!, integration, domains });
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(r)}\n`);
      process.exit(r.ok ? 0 : 1);
    }
    if (r.ok) console.log(`added connector "${id}" at ${r.path}`);
    else { console.error(r.error); process.exit(1); }
    return;
  }
  if (sub === "set") {
    // prevail connectors set <id> domains a,b,c [--json]
    //   rewrites the app→domain binding (many-to-many). Add or remove domains
    //   by passing the full desired list.
    // prevail connectors set <id> enabled <true|false> [--json]
    //   toggles whether the sync daemon may refresh this app. Disabled apps
    //   stay configured and chattable.
    const id = args[1];
    const field = args[2];
    const value = args[3];
    if (id && field === "enabled") {
      const enabled = value === "true" || value === "1" || value === "on";
      const { setCommunityAppEnabled } = await import("./vault.ts");
      const r = setCommunityAppEnabled(id, enabled);
      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify(r)}\n`);
        process.exit(r.ok ? 0 : 1);
      }
      if (r.ok) console.log(`${id} is now ${enabled ? "enabled" : "disabled"}`);
      else { console.error(r.error); process.exit(1); }
      return;
    }
    // APP-4: prevail connectors set <id> refresh <cadence> [at HH:MM] [on day]
    //   cadence ∈ hourly | 2h..23h | daily | weekly; "off"/"none" clears it.
    if (id && field === "refresh") {
      let at: string | undefined;
      let on: string | undefined;
      for (let k = 4; k < args.length; k++) {
        if (args[k] === "at" && args[k + 1]) { at = args[k + 1]; k++; }
        else if (args[k] === "on" && args[k + 1]) { on = args[k + 1]; k++; }
      }
      const { setCommunityAppSchedule } = await import("./vault.ts");
      const r = setCommunityAppSchedule(id, value ?? "", at, on);
      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify(r)}\n`);
        process.exit(r.ok ? 0 : 1);
      }
      if (r.ok) console.log(r.refresh ? `schedule for "${id}": every ${r.refresh.every}${r.refresh.at ? ` at ${r.refresh.at}` : ""}${r.refresh.on ? ` on ${r.refresh.on}` : ""}` : `schedule cleared for "${id}"`);
      else { console.error(r.error); process.exit(1); }
      return;
    }
    // A2: prevail connectors set <id> integration <api|oauth|browser|mcp|manual>
    if (id && field === "integration") {
      const { setCommunityAppIntegration } = await import("./vault.ts");
      const r = setCommunityAppIntegration(id, value ?? "");
      if (args.includes("--json")) { process.stdout.write(`${JSON.stringify(r)}\n`); process.exit(r.ok ? 0 : 1); }
      if (r.ok) console.log(`integration for "${id}" set to ${r.integration}`);
      else { console.error(r.error); process.exit(1); }
      return;
    }
    if (!id || field !== "domains") {
      console.error("usage: prevail connectors set <id> domains <a,b,c>");
      console.error("       prevail connectors set <id> enabled <true|false>");
      console.error("       prevail connectors set <id> refresh <hourly|Nh|daily|weekly|off> [at HH:MM] [on day]");
      console.error("       prevail connectors set <id> integration <api|oauth|browser|mcp|manual>");
      process.exit(1);
    }
    const domains = (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const { setCommunityAppDomains } = await import("./vault.ts");
    const r = setCommunityAppDomains(id, domains);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(r)}\n`);
      process.exit(r.ok ? 0 : 1);
    }
    if (r.ok) console.log(`set domains for "${id}": ${(r.domains ?? []).join(", ") || "(none)"}`);
    else { console.error(r.error); process.exit(1); }
    return;
  }
  if (sub === "runs" || sub === "history") {
    // Per-app run history: the bounded ring the sync layer records in the
    // connector's sync-state.json (last ~20 runs, manual + autonomous).
    const id = args[1];
    if (!id) { console.error("usage: prevail connectors runs <id>"); process.exit(1); }
    const app = apps.find((a) => a.id === id);
    if (!app) { console.error(`no connector with id "${id}"`); process.exit(1); }
    const { readSyncState } = await import("./daemon-sync.ts");
    const st = readSyncState(app);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({
        lastRunTs: st.last_run_ts,
        lastOkTs: st.last_ok_ts,
        lastRunOk: st.last_run_ok,
        lastError: st.last_error,
        nextDueTs: st.next_due_ts,
        consecutiveFailures: st.consecutive_failures,
        runs: st.runs,
      })}\n`);
      return;
    }
    if (st.runs.length === 0) { console.log(`${app.title} has no recorded runs yet`); return; }
    console.log(`${app.title} · last ${st.runs.length} run${st.runs.length === 1 ? "" : "s"}:`);
    for (const r of [...st.runs].reverse()) {
      const when = new Date(r.ts).toISOString();
      console.log(`  ${when}  ${r.ok ? "ok " : "ERR"}  ${r.skill}  ${r.duration_ms}ms  ${r.artifacts} artifact(s)${r.error ? `  ${r.error}` : ""}`);
    }
    return;
  }
  if (sub === "sync") {
    const id = args[1];
    if (!id) { console.error("usage: prevail connectors sync <id> [--vault <path>]"); process.exit(1); }
    const vflag = args.indexOf("--vault");
    const { readConfig } = await import("./config.ts");
    const { resolveDefaultVaultPath } = await import("./vault.ts");
    const vault = (vflag >= 0 ? args[vflag + 1] : undefined) ?? readConfig()?.vaultPath ?? resolveDefaultVaultPath();
    const { syncApp } = await import("./daemon-sync.ts");
    const r = await syncApp({ vaultPath: vault!, tickSec: 60, maxRunsPerTick: 1 }, id);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(r)}\n`);
      process.exit(0);
    }
    if (r.ok) console.log(`synced ${id}: ${r.artifacts} artifact(s) routed`);
    else { console.error(`sync ${id} failed: ${r.error}`); process.exit(1); }
    return;
  }
  if (sub === "sync-due") {
    // One pass over every DUE app (the in-app scheduler calls this on a tick;
    // the headless `daemon --sync` runs the same pass on a loop). Respects each
    // app's own schedule + the enabled flag; never stacks (per-app file lock).
    const vflag = args.indexOf("--vault");
    const { readConfig } = await import("./config.ts");
    const { resolveDefaultVaultPath } = await import("./vault.ts");
    const vault = (vflag >= 0 ? args[vflag + 1] : undefined) ?? readConfig()?.vaultPath ?? resolveDefaultVaultPath();
    const max = (() => { const i = args.indexOf("--max"); return i >= 0 ? Math.max(1, parseInt(args[i + 1], 10) || 2) : 2; })();
    const { syncOnce } = await import("./daemon-sync.ts");
    const r = await syncOnce({ vaultPath: vault!, tickSec: 60, maxRunsPerTick: max });
    if (args.includes("--json")) { process.stdout.write(`${JSON.stringify(r)}\n`); return; }
    console.log(`[sync] ran ${r.ran} connector(s): ${r.ok} ok, ${r.failed} failed`);
    return;
  }
  console.error(`unknown connectors subcommand: ${sub}\n`);
  console.error("usage:");
  console.error("  prevail connectors list");
  console.error("  prevail connectors test <id>");
  console.error("  prevail connectors oauth <id>");
  console.error("  prevail connectors skills <id>                       — list runnable skills");
  console.error("  prevail connectors run <id> <skill> [--input k=v]   — execute a skill");
  console.error("  prevail connectors add --id <id> --title <t> --integration <type> --domains a,b");
  console.error("  prevail connectors set <id> domains <a,b,c>          — rewrite app→domain binding");
  console.error("  prevail connectors set <id> enabled <true|false>     — toggle autonomous sync");
  console.error("  prevail connectors set <id> refresh <cadence> [at HH:MM] [on day]  — set sync schedule (hourly|Nh|daily|weekly|off)");
  console.error("  prevail connectors runs <id>                         — per-app run history");
  console.error("  prevail connectors sync <id> [--vault <path>]       — sync one app now");
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

  // `vault migrate-data` (W4) — relocate the vault's content under a single
  // `<vault>/data/` container so the root is no longer littered with loose files
  // and apps+domains sit together. Non-destructive: copies + verifies, leaves
  // the originals. `vault archive-data --force` is the SEPARATE, opt-in step that
  // moves the now-duplicated originals into a timestamped `_pre-data-*` archive
  // (never deletes) once a verified copy exists under data/.
  if (sub === "migrate-data" || sub === "archive-data") {
    const { migrateToDataLayout, archiveLegacyRoot, isDataLayout, isAlreadyDataRoot } = await import("./vault-data-layout.ts");
    const asJson = args.includes("--json");
    try {
      if (sub === "migrate-data") {
        // Idempotent: if the configured vault IS already a migrated data root
        // (repointed on a prior run), do nothing — never nest data/data/.
        if (isAlreadyDataRoot(vault)) {
          const msg = { alreadyMigrated: true, dataDir: vault, ok: true };
          if (asJson) process.stdout.write(JSON.stringify(msg) + "\n");
          else console.log(`vault is already the data root: ${vault}`);
          return;
        }
        const r = migrateToDataLayout(vault);
        // On a VERIFIED copy, repoint the configured vault to <vault>/data so
        // every surface (CLI, TUI, desktop) operates under data/ transparently —
        // the same repoint pattern `vault embed` uses. The loose root files are
        // now read from data/; archive-data cleans the orphaned originals.
        if (r.ok) {
          writeConfig({ ...(cfg ?? {}), vaultPath: r.dataDir } as never);
        }
        if (asJson) process.stdout.write(JSON.stringify({ ...r, repointed: r.ok }) + "\n");
        else {
          console.log(`copied ${r.copiedFiles}/${r.sourceFiles} files into ${r.dataDir}${r.ok ? "" : "  (verify mismatch — originals left intact!)"}`);
          console.log(`moved entries: ${r.movedEntries.join(", ")}`);
          if (r.ok) console.log(`vault path repointed to ${r.dataDir}. The root now holds just data/ (+ originals until you run 'vault archive-data --force').`);
        }
        if (!r.ok) process.exit(1);
      } else {
        if (!args.includes("--force")) {
          console.error("vault archive-data moves the loose root originals into a backup folder.\nRe-run with --force once you've confirmed the app reads correctly from data/.");
          process.exit(1);
        }
        // After migrate-data repoints config, `vault` IS <root>/data. The
        // originals to archive live one level up, at the true root.
        const root = isAlreadyDataRoot(vault) ? dirname(vault) : vault;
        if (!isDataLayout(root)) { console.error("no data/ layout yet — run 'vault migrate-data' first."); process.exit(1); }
        // Deterministic stamp from the wall clock (UTC, compact).
        const d = new Date();
        const stamp = d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
        const r = archiveLegacyRoot(root, stamp);
        if (asJson) process.stdout.write(JSON.stringify(r) + "\n");
        else {
          console.log(`archived ${r.archived.length} entr(ies) to ${r.archiveDir}: ${r.archived.join(", ") || "(none)"}`);
          if (r.deferred.length) console.log(`deferred ${r.deferred.length} (no verified copy under data/ yet, kept in place): ${r.deferred.join(", ")}`);
          console.log(`nothing was deleted. The vault now reads entirely from ${root}/data.`);
        }
      }
    } catch (e) {
      if (asJson) process.stdout.write(JSON.stringify({ error: String(e) }) + "\n");
      else console.error(`vault ${sub} failed: ${e}`);
      process.exit(1);
    }
    return;
  }

  // `vault migrate-build` (B2-12) — tidy the General/root SUPPORTING runtime files
  // (ledgers, _meta, _threads, benchmark, usage, …) into a single `<vault>/build/`
  // folder so the root holds just content + build/. Non-destructive: copies +
  // verifies, leaves the originals; buildRoot()/runtimePath() resolve to build/ the
  // instant it exists, so no config repoint is needed. `vault archive-build --force`
  // is the SEPARATE opt-in that moves the duplicated originals into a `_pre-build-*`
  // backup (never deletes) once a verified copy exists under build/.
  if (sub === "migrate-build" || sub === "archive-build") {
    const { migrateToBuildLayout, archiveLegacyBuild } = await import("./vault-data-layout.ts");
    const asJson = args.includes("--json");
    try {
      if (sub === "migrate-build") {
        const r = migrateToBuildLayout(vault);
        if (asJson) process.stdout.write(JSON.stringify(r) + "\n");
        else {
          console.log(`copied ${r.copiedFiles}/${r.sourceFiles} files into ${r.buildDir}${r.ok ? "" : "  (verify mismatch — originals left intact!)"}`);
          console.log(`moved entries: ${r.movedEntries.join(", ") || "(none found)"}`);
          if (r.ok) console.log(`the root now reads runtime files from build/ (+ originals until you run 'vault archive-build --force').`);
        }
        if (!r.ok) process.exit(1);
      } else {
        if (!args.includes("--force")) {
          console.error("vault archive-build moves the duplicated root originals into a backup folder.\nRe-run with --force once you've confirmed the app reads correctly from build/.");
          process.exit(1);
        }
        const d = new Date();
        const stamp = d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
        const r = archiveLegacyBuild(vault, stamp);
        if (asJson) process.stdout.write(JSON.stringify(r) + "\n");
        else {
          console.log(`archived ${r.archived.length} entr(ies) to ${r.archiveDir}: ${r.archived.join(", ") || "(none)"}`);
          if (r.deferred.length) console.log(`deferred ${r.deferred.length} (no verified copy under build/ yet, kept in place): ${r.deferred.join(", ")}`);
          console.log(`nothing was deleted. Runtime files now read from build/.`);
        }
      }
    } catch (e) {
      if (asJson) process.stdout.write(JSON.stringify({ error: String(e) }) + "\n");
      else console.error(`vault ${sub} failed: ${e}`);
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
  const restoreArg = sub === "restore" ? args.find((a, i) => i >= 1 && !a.startsWith("--")) : undefined;
  const isArchiveFileRestore = !!restoreArg && (restoreArg.endsWith(".tar.gz") || restoreArg.endsWith(".tgz"));
  if ((sub === "archive" || sub === "restore" || sub === "list-archived") && !isArchiveFileRestore) {
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
    const asJson = args.includes("--json");
    const archive = args.find((a, i) => i >= 1 && !a.startsWith("--"));
    if (!archive) {
      if (asJson) emitJsonError("usage: prevail vault restore <archive>", "MISSING_ARG");
      console.error("usage: prevail vault restore <archive>");
      process.exit(1);
    }
    if (!existsSync(vault) && !asJson) {
      // The target may not exist yet — restore will create it. But warn
      // the user so they don't accidentally extract into the wrong place.
      console.log(`note: target vault ${vault} does not exist; will be created.`);
    }
    const force = args.includes("--force") || args.includes("-f");
    try {
      await restoreVault({
        archivePath: resolve(process.cwd(), archive),
        targetVaultPath: vault,
        // --force (or --json) skips the interactive type-the-name guard; the
        // desktop shows its own confirm dialog before calling this.
        ...(force || asJson ? { confirm: async () => basename(resolve(vault)) } : {}),
      });
      if (asJson) process.stdout.write(`${JSON.stringify({ ok: true, vault })}\n`);
      else console.log(`✓ restored into ${vault}`);
    } catch (err) {
      if (asJson) emitJsonError((err as Error).message, "RESTORE_FAILED");
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
  const wantLearn = args.includes("--learn");
  const wantLoops = args.includes("--loops");
  const wantSync = args.includes("--sync");
  const wantInstall = args.includes("install");
  const wantUninstall = args.includes("uninstall");
  const cfg0 = readConfig();
  const vault0 = vaultOverride ?? cfg0?.vaultPath ?? bundledDemoVaultPath();

  // launchd install/uninstall — run the headless learn daemon at login.
  if (wantInstall || wantUninstall) {
    const { installLaunchAgent, uninstallLaunchAgent } = await import("./daemon-launchd.ts");
    if (wantUninstall) { await uninstallLaunchAgent(); return; }
    await installLaunchAgent(vault0);
    return;
  }

  // --learn: the headless self-learning loop (distill intents -> memory/state).
  if (wantLearn) {
    if (!existsSync(vault0)) { console.error(`vault path not found: ${vault0}`); process.exit(1); }
    const { runLearnDaemon, DEFAULT_LEARN } = await import("./daemon-learn.ts");
    let interval = DEFAULT_LEARN.intervalSec;
    let provider = DEFAULT_LEARN.provider;
    let model = DEFAULT_LEARN.model;
    for (let i = 0; i < args.length; i++) {
      const a = args[i], v = args[i + 1];
      if (a === "--interval" && v) { interval = Math.max(30, parseInt(v, 10) || interval); i++; }
      else if (a === "--cli" && v) { provider = v; i++; }
      else if (a === "--model" && v) { model = v; i++; }
    }
    await runLearnDaemon({ ...DEFAULT_LEARN, vaultPath: vault0, intervalSec: interval, provider, model });
    return;
  }

  // --loops: the loop runner. --once does a single pass and exits (used by the
  // desktop "Run loops now" action and for testing); otherwise it runs forever.
  if (wantLoops) {
    if (!existsSync(vault0)) { console.error(`vault path not found: ${vault0}`); process.exit(1); }
    const { runLoopsDaemon, loopsOnce, DEFAULT_LOOPS } = await import("./daemon-loops.ts");
    let interval = DEFAULT_LOOPS.intervalSec;
    let provider = DEFAULT_LOOPS.provider;
    let model = DEFAULT_LOOPS.model;
    const once = args.includes("--once");
    for (let i = 0; i < args.length; i++) {
      const a = args[i], v = args[i + 1];
      if (a === "--interval" && v) { interval = Math.max(60, parseInt(v, 10) || interval); i++; }
      else if (a === "--cli" && v) { provider = v; i++; }
      else if (a === "--model" && v) { model = v; i++; }
    }
    // Briefing-loop delivery hooks (default channel Gmail). Best-effort: if a
    // connector isn't authenticated, the hook is omitted and a briefing logs only.
    let deliverEmail: ((s: string, b: string) => Promise<string>) | undefined;
    try { deliverEmail = (await buildBriefingHooks(vault0, ["email"])).email; } catch { /* no gmail */ }
    let deliverTelegram: ((t: string) => Promise<number>) | undefined;
    try {
      const { readTelegramConfig } = await import("./telegram-config.ts");
      const { sendLongMessage } = await import("./telegram.ts");
      const tg = readTelegramConfig();
      if (tg?.botToken && tg.allowList?.length) {
        deliverTelegram = async (text: string) => {
          let ok = 0;
          for (const id of tg.allowList) { try { await sendLongMessage(tg.botToken, id, text); ok++; } catch { /* skip */ } }
          return ok;
        };
      }
    } catch { /* no telegram */ }
    const cfg = { ...DEFAULT_LOOPS, vaultPath: vault0, intervalSec: interval, provider, model, deliverEmail, deliverTelegram };
    // --exec: execute one APPROVED action for real via the agent's connectors.
    // Used by the desktop "Execute" button on a pending approval.
    if (args.includes("--exec")) {
      let domain = "", action = "";
      for (let i = 0; i < args.length; i++) {
        const a = args[i], v = args[i + 1];
        if (a === "--domain" && v) { domain = v; i++; }
        else if (a === "--action" && v) { action = v; i++; }
      }
      if (!domain || !action) { console.error("loops --exec needs --domain and --action"); process.exit(1); }
      const { executeAction } = await import("./daemon-loops.ts");
      const report = await executeAction(cfg, domain, action);
      console.log(report);
      return;
    }
    // --run-loop: run ONE loop now (the desktop per-loop "Run now"). Applies per
    // the loop's autonomy and prints a JSON result of what it did (last line).
    if (args.includes("--run-loop")) {
      let domain = "", loop = "";
      for (let i = 0; i < args.length; i++) {
        const a = args[i], v = args[i + 1];
        if (a === "--domain" && v) { domain = v; i++; }
        else if (a === "--loop" && v) { loop = v; i++; }
      }
      if (!domain || !loop) { console.error("loops --run-loop needs --domain and --loop"); process.exit(1); }
      const { runOneLoop } = await import("./daemon-loops.ts");
      // Streaming mode (the desktop adds --json): emit one NDJSON line per phase
      // as the run proceeds so the UI can show live progress instead of a blank
      // spinner, then a final {type:"result"} line. Non-stream mode keeps the
      // single __LOOPRESULT__ line for back-compat.
      const stream = args.includes("--json");
      const onPhase = stream
        ? (phase: string, label: string) => { try { console.log(JSON.stringify({ type: "phase", phase, label })); } catch { /* ignore */ } }
        : undefined;
      const result = await runOneLoop(cfg, domain, loop, onPhase);
      if (stream) console.log(JSON.stringify({ type: "result", result }));
      else console.log(`__LOOPRESULT__${JSON.stringify(result)}`);
      return;
    }
    if (once) {
      const { domains, loops } = await loopsOnce(cfg);
      console.log(`[loops] advanced ${loops} loop(s) across ${domains} domain(s)`);
      return;
    }
    await runLoopsDaemon(cfg);
    return;
  }

  // --sync: the autonomous app-sync daemon — keeps every connected app fresh on
  // its own schedule, headlessly. --once does a single due-pass and exits.
  if (wantSync) {
    if (!existsSync(vault0)) { console.error(`vault path not found: ${vault0}`); process.exit(1); }
    const { runSyncDaemon, syncOnce, DEFAULT_SYNC } = await import("./daemon-sync.ts");
    let tick = DEFAULT_SYNC.tickSec;
    let max = DEFAULT_SYNC.maxRunsPerTick;
    for (let i = 0; i < args.length; i++) {
      const a = args[i], v = args[i + 1];
      if (a === "--interval" && v) { tick = Math.max(30, parseInt(v, 10) || tick); i++; }
      else if (a === "--max" && v) { max = Math.max(1, parseInt(v, 10) || max); i++; }
    }
    const cfg = { vaultPath: vault0, tickSec: tick, maxRunsPerTick: max };
    if (args.includes("--once")) {
      const r = await syncOnce(cfg);
      console.log(`[sync] ran ${r.ran} connector(s): ${r.ok} ok, ${r.failed} failed`);
      return;
    }
    await runSyncDaemon(cfg);
    return;
  }

  if (!wantTelegram) {
    console.error("usage:");
    console.error("  prevail daemon --telegram               two-way Telegram bridge");
    console.error("  prevail daemon --learn [--interval N]   headless self-learning (distill intents)");
    console.error("  prevail daemon --loops [--interval N]   advance domain loops on their cadence");
    console.error("  prevail daemon --sync [--interval N]    keep connected apps fresh on schedule");
    console.error("  prevail daemon install                  run --learn at login (launchd)");
    console.error("  prevail daemon uninstall                remove the login agent");
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
// `prevail models <provider> --json` — live model discovery for a provider
// (ollama/lmstudio/openrouter query a real catalog; others return []). Lets the
// desktop refresh its model list so newly released models appear without a code
// change. Machine-only (JSON).
async function modelsCommand(args: string[]): Promise<number> {
  const provider = args.find((a) => !a.startsWith("--")) ?? "";
  if (!args.includes("--json")) {
    console.error("prevail models is a machine-only command — pass --json.");
    return 1;
  }
  const { discoverModels } = await import("./models.ts");
  const found = await discoverModels(provider);
  process.stdout.write(`${JSON.stringify({ provider, models: found })}\n`);
  return 0;
}

async function appmodeCommand(args: string[]): Promise<number> {
  const sub = args[0];
  const body = sub === "get" || sub === "set" || sub === "init" || sub === "mark-demo" ? args.slice(1) : args;
  const { json, flags, vaultPath } = parseKvArgs(body, null);
  if (!json) {
    console.error("prevail appmode is a machine-only command — pass --json.");
    return 1;
  }
  const cfg = await import("./config.ts");
  // `appmode init` — prepare a clean production workspace and switch to it.
  // Optional --vault <path> (default: embedded ~/.prevail/vault) and
  // --clear-demo <path> (only emptied if it carries the demo marker).
  if (sub === "init") {
    const prod = await import("./production.ts");
    const res = prod.initProduction({ vault: vaultPath ?? undefined, clearDemo: flags["clear-demo"] });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return 0;
  }
  // `appmode mark-demo --vault <path>` — drop the demo marker so a later
  // production switch can safely clear this sandbox.
  if (sub === "mark-demo") {
    const prod = await import("./production.ts");
    if (vaultPath) prod.markDemoVault(vaultPath);
    process.stdout.write(`${JSON.stringify({ ok: !!vaultPath })}\n`);
    return 0;
  }
  if (sub === "set" && (flags.mode === "demo" || flags.mode === "production")) {
    // Pass the optional --vault through so a first-launch `set --mode demo`
    // (when no config exists yet) seeds the config pointed at the real seeded
    // sandbox rather than the bundled default.
    cfg.setAppMode(flags.mode, vaultPath ?? undefined);
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
  if (args.recommendations) {
    // prevail recommendations --vault <path> [--json] — the proactive feed.
    const vflag = args.recommendationsArgs.indexOf("--vault");
    const { readConfig: rc } = await import("./config.ts");
    const { resolveDefaultVaultPath } = await import("./vault.ts");
    const vault = (vflag >= 0 ? args.recommendationsArgs[vflag + 1] : undefined) ?? rc()?.vaultPath ?? resolveDefaultVaultPath();
    const { recommendationsJson, buildRecommendations } = await import("./recommendations.ts");
    if (args.recommendationsArgs.includes("--json")) { process.stdout.write(`${recommendationsJson(vault!)}\n`); return; }
    const recs = buildRecommendations(vault!);
    if (recs.length === 0) { console.log("no recommendations right now — keep using Prevail and they'll appear."); return; }
    console.log(`${recs.length} recommendation${recs.length === 1 ? "" : "s"}:\n`);
    for (const r of recs) console.log(`  [${r.category}] ${r.title}\n    ${r.detail}\n`);
    return;
  }
  if (args.suggestApps) {
    // prevail suggest-apps --domain <name|all> [--cli <kind>] [--model <id>] [--json]
    // Learns from a domain's signals and proposes real apps to connect.
    const a = args.suggestAppsArgs;
    const vflag = a.indexOf("--vault");
    const { readConfig: rc } = await import("./config.ts");
    const { resolveDefaultVaultPath, scanVault, scanCommunityApps } = await import("./vault.ts");
    const vault = (vflag >= 0 ? a[vflag + 1] : undefined) ?? args.vaultPath ?? rc()?.vaultPath ?? resolveDefaultVaultPath();
    const json = a.includes("--json");
    const get = (flag: string): string | null => { const i = a.indexOf(flag); return i >= 0 ? (a[i + 1] ?? null) : null; };
    const domainArg = (get("--domain") ?? "all").toLowerCase();
    const cliKind = get("--cli");
    const model = get("--model");
    const { suggestAppsForDomain, readAppSuggestions } = await import("./app-suggest.ts");
    if (a.includes("--read")) { process.stdout.write(`${JSON.stringify(readAppSuggestions(vault!))}\n`); return; }
    const { detectClis } = await import("./cli-bridge.ts");
    let clis = await detectClis();
    if (process.env.PREVAIL_BUNKER === "1") {
      const LOCAL = new Set(["ollama", "lmstudio", "mlx"]);
      clis = clis.filter((c) => LOCAL.has(c.kind));
    }
    const cli = cliKind ? clis.find((c) => c.kind === cliKind) : clis.find((c) => c.kind === "claude") ?? clis[0];
    if (!cli) { console.error("no AI CLI available for app suggestions"); process.exit(1); }
    const domains = domainArg === "all" ? scanVault(vault!).map((d) => d.name.toLowerCase()) : domainArg.split(",").map((d) => d.trim()).filter(Boolean);
    // Connected apps per domain, to exclude from suggestions.
    const apps = scanCommunityApps();
    for (const domain of domains) {
      if (!json) process.stdout.write(`suggest-apps ${domain}…\n`);
      const connected = apps.filter((ap) => (ap.domains ?? []).some((d) => String(d).toLowerCase() === domain)).map((ap) => ap.title || ap.id);
      try {
        const items = await suggestAppsForDomain({ vault: vault!, domain, cli, model: model ?? undefined, connected });
        if (!json) for (const it of items) process.stdout.write(`  ${it.name} — ${it.reason}\n`);
      } catch (e) {
        if (!json) process.stdout.write(`  (failed: ${(e as Error).message})\n`);
      }
    }
    if (json) process.stdout.write(`${JSON.stringify(readAppSuggestions(vault!))}\n`);
    return;
  }
  if (args.scout) {
    // prevail scout-models [--known a,b,c] [--cli <kind>] [--model <id>] [--json] [--read]
    // Searches the web for AI models worth adding to the Arena benchmark
    // (open-weight + frontier) and writes build/_meta/model_suggestions.json.
    const a = args.scoutArgs;
    const { readConfig: rc } = await import("./config.ts");
    const { resolveDefaultVaultPath } = await import("./vault.ts");
    const vflag = a.indexOf("--vault");
    const vault = (vflag >= 0 ? a[vflag + 1] : undefined) ?? args.vaultPath ?? rc()?.vaultPath ?? resolveDefaultVaultPath();
    const json = a.includes("--json");
    const get = (flag: string): string | null => { const i = a.indexOf(flag); return i >= 0 ? (a[i + 1] ?? null) : null; };
    const { readModelSuggestions, scoutModels } = await import("./model-scout.ts");
    if (a.includes("--read")) { process.stdout.write(`${JSON.stringify(readModelSuggestions(vault!) ?? {})}\n`); return; }
    const known = (get("--known") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const { detectClis } = await import("./cli-bridge.ts");
    let clis = await detectClis();
    if (process.env.PREVAIL_BUNKER === "1") {
      const LOCAL = new Set(["ollama", "lmstudio", "mlx"]);
      clis = clis.filter((c) => LOCAL.has(c.kind));
    }
    const cliKind = get("--cli");
    const model = get("--model");
    const cli = cliKind ? clis.find((c) => c.kind === cliKind) : clis.find((c) => c.kind === "claude") ?? clis[0];
    if (!cli) { console.error("no AI CLI available to scout models"); process.exit(1); }
    if (!json) process.stdout.write("scout-models (searching the web)…\n");
    try {
      const items = await scoutModels({ vault: vault!, cli, model: model ?? undefined, known });
      if (json) process.stdout.write(`${JSON.stringify(readModelSuggestions(vault!) ?? {})}\n`);
      else for (const it of items) process.stdout.write(`  [${it.kind}] ${it.name} (${it.provider}) — ${it.reason}\n`);
    } catch (e) {
      if (json) process.stdout.write(`${JSON.stringify({ error: String(e) })}\n`);
      else process.stdout.write(`  (failed: ${(e as Error).message})\n`);
    }
    return;
  }
  if (args.mcp) {
    const cfg = readConfig();
    const vault = args.vaultPath ?? cfg?.vaultPath ?? bundledDemoVaultPath();
    const { runMcpServer } = await import("./mcp-server.ts");
    await runMcpServer(vault, { unsafeDetach: args.mcpUnsafeDetach, network: args.mcpNetwork });
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
  if (args.models) {
    process.exit(await modelsCommand(args.modelsArgs));
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
  if (args.alignment) {
    const { computeAlignment } = await import("./alignment.ts");
    const vault = args.vaultPath;
    const useModel = args.alignmentArgs.includes("--model");
    let run: ((prompt: string) => Promise<string>) | undefined;
    if (useModel) {
      const { detectClis, runChatTurn } = await import("./cli-bridge.ts");
      const { scanVault } = await import("./vault.ts");
      const clis = await detectClis();
      const cli = clis.find((c) => c.available)?.kind;
      const dom = scanVault(vault)[0]?.name ?? "chief";
      if (cli) run = (prompt) => runChatTurn({ prompt, cwd: `${vault}/${dom}`, cli, isFirst: true, bare: true });
    }
    const report = await computeAlignment(vault, Date.now(), run ? { run } : undefined);
    if (args.alignmentArgs.includes("--json")) process.stdout.write(`${JSON.stringify(report)}\n`);
    else {
      console.log(`alignment (${report.method}) — overall ${report.overall}/100`);
      for (const p of report.pillars) console.log(`  ${p.pillar.padEnd(14)} ${String(p.score).padStart(3)}/100  ${p.rationale}`);
      if (report.actions.length) { console.log("\ntop actions:"); for (const a of report.actions) console.log(`  - ${a}`); }
    }
    process.exit(0);
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
  // Lazy: only the interactive path loads the TUI framework (see top-of-file note).
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const { FirstRunWizard } = await import("./wizard.tsx");
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
  // Lazy: only the interactive path loads the TUI framework (see top-of-file note).
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const { App } = await import("./app.tsx");
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
