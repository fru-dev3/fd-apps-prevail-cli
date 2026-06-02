import { existsSync } from "node:fs";
import { detectClis, type AvailableCli, type CliKind } from "./cli-bridge.ts";
import {
  buildCouncilPanel,
  runCouncilOneShot,
  type PanelResult,
} from "./council-runner.ts";
import { isCliKind, readResponseFramework, setResponseFramework } from "./config.ts";
import { FRAMEWORKS, getFramework, isFrameworkId } from "./framework.ts";
import { runChatTurn } from "./cli-bridge.ts";
import { scanVault, type Domain } from "./vault.ts";
import { readTelegramConfig, type TelegramConfig } from "./telegram-config.ts";
import { writeTurnSummary } from "./auto-summary.ts";
import { tickBriefings } from "./briefings.ts";
import { parseVerdict } from "./verdict-parser.ts";

// Per-chat state held in memory for the lifetime of the daemon. Lost on
// restart — acceptable for v1 since the SQLite session log already persists
// chat history per-domain.
interface ChatState {
  chatId: number;
  domain: Domain;
  cli: AvailableCli;
  model: string;
  councilMode: boolean;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type?: string };
    from?: { id: number; first_name?: string };
    text?: string;
  };
}

const TELEGRAM_API = "https://api.telegram.org";

// Telegram sends messages up to 4096 chars. Council verdicts can blow past
// that — split safely on paragraph boundaries so a long reply arrives as a
// readable sequence instead of one truncated chunk.
const MAX_TELEGRAM_LEN = 3800;

export interface DaemonOptions {
  vaultPath: string;
  logger?: (line: string) => void;
}

// Long-poll Telegram, dispatch messages through the same engine path as the
// TUI. Returns a function the caller can use to stop the daemon cleanly.
export async function runTelegramDaemon(opts: DaemonOptions): Promise<{ stop: () => void }> {
  const log = opts.logger ?? ((s) => console.log(`[telegram] ${s}`));
  const cfg = readTelegramConfig();
  if (!cfg) {
    throw new Error(
      "telegram not configured. Run `prevail telegram setup` first, or set PREVAIL_TELEGRAM_TOKEN.",
    );
  }
  if (!cfg.botToken) {
    throw new Error("telegram bot token is empty — set it via `prevail telegram setup`");
  }
  if (cfg.allowList.length === 0) {
    log(
      "WARNING: allowList is empty. The daemon will log incoming chat IDs but won't respond. " +
        "Message the bot once, then run `prevail telegram add-user <chat_id>` with the ID from the log.",
    );
  }

  if (!existsSync(opts.vaultPath)) {
    throw new Error(`vault path not found: ${opts.vaultPath}`);
  }
  const domains = scanVault(opts.vaultPath);
  if (domains.length === 0) {
    throw new Error(`no domains found in vault: ${opts.vaultPath}`);
  }
  const clis = await detectClis();
  if (clis.length === 0) {
    throw new Error("no CLIs detected — install claude/codex/gemini or start ollama first");
  }

  const defaultCli =
    clis.find((c) => c.kind === cfg.defaultCli) ??
    clis.find((c) => c.kind === "claude") ??
    clis[0]!;
  const defaultDomain =
    domains.find((d) => d.name === cfg.defaultDomain) ?? domains[0]!;

  const states = new Map<number, ChatState>();
  let stopped = false;
  let offset = 0;

  log(
    `started. vault=${opts.vaultPath} domains=${domains.length} clis=${clis.map((c) => c.label).join(",")} allowList=${cfg.allowList.length}`,
  );

  // Briefing ticker — fires due briefings every minute. Telegram delivery
  // fans out to every allow-listed chat_id (so a couple's shared bot pings
  // both phones). Returns the number of successful sends.
  const deliverTelegram = async (text: string): Promise<number> => {
    let ok = 0;
    for (const id of cfg.allowList) {
      try {
        await sendLongMessage(cfg.botToken, id, text);
        ok++;
      } catch (err) {
        log(`telegram delivery failed for chat_id=${id}: ${(err as Error).message}`);
      }
    }
    return ok;
  };
  const briefingInterval = setInterval(() => {
    void tickBriefings(opts.vaultPath, deliverTelegram).then((results) => {
      for (const r of results) {
        if (r.error) {
          log(`briefing ${r.id} error: ${r.error}`);
        } else {
          log(`briefing ${r.id} fired · domain=${r.domain} · delivered log=${r.delivered.log} tg=${r.delivered.telegram}`);
        }
      }
    });
  }, 60_000);
  // Stop the ticker when the daemon is asked to stop.
  const originalStop = () => {
    clearInterval(briefingInterval);
  };

  // Long-poll loop. timeout=30 means each request blocks for up to 30s on
  // the server side; messages arrive with near-zero latency on top of that.
  // Drops into a tight catch-and-retry loop if the network blinks — backoff
  // doubles per failure up to 30s so a flapping connection doesn't hammer
  // Telegram's API.
  let backoff = 1000;
  (async () => {
    while (!stopped) {
      try {
        const updates = await tgGetUpdates(cfg.botToken, offset);
        backoff = 1000;
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          await handleUpdate(u, cfg, states, domains, clis, defaultCli, defaultDomain, opts.vaultPath, log);
        }
      } catch (err) {
        log(`poll error: ${(err as Error).message} — retry in ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  })().catch((err) => log(`fatal: ${(err as Error).message}`));

  return {
    stop: () => {
      stopped = true;
      originalStop();
    },
  };
}

async function handleUpdate(
  u: TelegramUpdate,
  cfg: TelegramConfig,
  states: Map<number, ChatState>,
  domains: Domain[],
  clis: AvailableCli[],
  defaultCli: AvailableCli,
  defaultDomain: Domain,
  vaultPath: string,
  log: (s: string) => void,
): Promise<void> {
  const msg = u.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  if (!cfg.allowList.includes(chatId)) {
    log(
      `ignored chat_id=${chatId} (not in allowList). Add with: prevail telegram add-user ${chatId}`,
    );
    // Friendly nudge for the first-time user trying to bootstrap.
    await tgSendMessage(
      cfg.botToken,
      chatId,
      `Hi — this prevail bot doesn't recognize you yet. Ask its owner to run:\n\nprevail telegram add-user ${chatId}\n\nThen try again.`,
    ).catch(() => {});
    return;
  }

  // Ensure per-chat state exists with default cli + domain.
  let state = states.get(chatId);
  if (!state) {
    state = {
      chatId,
      domain: defaultDomain,
      cli: defaultCli,
      model: "",
      councilMode: cfg.councilByDefault ?? false,
    };
    states.set(chatId, state);
  }

  const text = msg.text.trim();
  log(`chat=${chatId} domain=${state.domain.name} cli=${state.cli.kind} council=${state.councilMode} > ${truncateForLog(text)}`);

  // Command dispatch — anything starting with `/` is a command.
  if (text.startsWith("/")) {
    await handleCommand(text, state, states, domains, clis, cfg, vaultPath);
    return;
  }

  // Free-text → prompt. Show typing while the model thinks so the user
  // gets feedback (Telegram shows "..." in the chat header).
  await tgSendChatAction(cfg.botToken, chatId, "typing").catch(() => {});
  if (state.councilMode) {
    const panel = buildCouncilPanel(clis);
    if (panel.length === 0) {
      await tgSendMessage(cfg.botToken, chatId, "council panel is empty — /council off to disable, or fix your council config via the TUI");
      return;
    }
    const result = await runCouncilOneShot({
      prompt: text,
      cwd: state.domain.path,
      panelists: panel,
    });
    await sendCouncilResult(cfg.botToken, chatId, result.panel, result.verdict, result.chairLabel, result.degraded);
    // Self-curating vault: log the verdict, same hook the TUI uses.
    if (result.verdict && !result.verdict.startsWith("(")) {
      writeTurnSummary({
        domainPath: state.domain.path,
        userPrompt: text,
        assistantReply: result.verdict,
        cliLabel: `Council ⚖ ${result.chairLabel} (via telegram)`,
        ts: Date.now(),
        kind: "council-verdict",
      });
    }
  } else {
    try {
      const reply = await runChatTurn({
        prompt: text,
        cwd: state.domain.path,
        cli: state.cli,
        model: state.model,
        isFirst: true,
        bare: true,
      });
      await sendLongMessage(cfg.botToken, chatId, reply);
      writeTurnSummary({
        domainPath: state.domain.path,
        userPrompt: text,
        assistantReply: reply,
        cliLabel: state.model
          ? `${state.cli.label}·${state.model} (via telegram)`
          : `${state.cli.label} (via telegram)`,
        ts: Date.now(),
        kind: "chat",
      });
    } catch (err) {
      await tgSendMessage(cfg.botToken, chatId, `error: ${(err as Error).message}`);
    }
  }
}

async function handleCommand(
  text: string,
  state: ChatState,
  states: Map<number, ChatState>,
  domains: Domain[],
  clis: AvailableCli[],
  cfg: TelegramConfig,
  vaultPath: string,
): Promise<void> {
  const [head, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();
  const chatId = state.chatId;

  switch (head) {
    case "/start":
    case "/help": {
      await tgSendMessage(
        cfg.botToken,
        chatId,
        [
          "prevAIl on Telegram — terminal cockpit, away from the keyboard.",
          "",
          "/domains            list life domains in this vault",
          "/domain <name>      switch active domain (e.g. /domain wealth)",
          "/use <cli> [model]  switch engine (claude/codex/gemini/ollama)",
          "/council on|off     toggle council mode for this chat",
          "/framework <id>     set response framework (bluf/win/scqa/...)",
          "/framework none     clear framework",
          "/frameworks         list available frameworks",
          "/status             show current chat state",
          "",
          `current: ${state.domain.name} via ${state.cli.label}${state.councilMode ? " · council ON" : ""}`,
          "",
          "Anything else you send is forwarded as a prompt.",
        ].join("\n"),
      );
      return;
    }
    case "/domains": {
      const lines = domains.map((d) => {
        const mark = d.name === state.domain.name ? "● " : "  ";
        return `${mark}${d.name}`;
      });
      await tgSendMessage(cfg.botToken, chatId, `Life domains in vault:\n${lines.join("\n")}`);
      return;
    }
    case "/domain": {
      if (!arg) {
        await tgSendMessage(cfg.botToken, chatId, `current domain: ${state.domain.name}\nuse /domain <name>`);
        return;
      }
      const next = domains.find((d) => d.name.toLowerCase() === arg.toLowerCase());
      if (!next) {
        await tgSendMessage(
          cfg.botToken,
          chatId,
          `no domain named "${arg}". /domains to list.`,
        );
        return;
      }
      state.domain = next;
      states.set(chatId, state);
      await tgSendMessage(cfg.botToken, chatId, `→ switched to ${next.name}`);
      return;
    }
    case "/use": {
      if (!arg) {
        await tgSendMessage(cfg.botToken, chatId, `current: ${state.cli.label}${state.model ? ` ${state.model}` : ""}\nuse /use <claude|codex|gemini|ollama> [model]`);
        return;
      }
      const [k, ...mrest] = arg.split(/\s+/);
      if (!isCliKind(k!)) {
        await tgSendMessage(cfg.botToken, chatId, `unknown cli "${k}" — try claude/codex/gemini/ollama`);
        return;
      }
      const kind = k as CliKind;
      const next = clis.find((c) => c.kind === kind);
      if (!next) {
        await tgSendMessage(cfg.botToken, chatId, `${k} not detected on the daemon host`);
        return;
      }
      state.cli = next;
      state.model = mrest.join(" ").trim();
      states.set(chatId, state);
      await tgSendMessage(cfg.botToken, chatId, `→ ${next.label}${state.model ? ` · ${state.model}` : ""}`);
      return;
    }
    case "/council": {
      const a = arg.toLowerCase();
      if (a === "on" || a === "yes" || a === "1") {
        state.councilMode = true;
      } else if (a === "off" || a === "no" || a === "0") {
        state.councilMode = false;
      } else if (a === "") {
        state.councilMode = !state.councilMode;
      } else {
        await tgSendMessage(cfg.botToken, chatId, `usage: /council on|off`);
        return;
      }
      states.set(chatId, state);
      await tgSendMessage(cfg.botToken, chatId, `council mode: ${state.councilMode ? "ON" : "OFF"}`);
      return;
    }
    case "/framework": {
      const a = arg.toLowerCase();
      if (a === "" || a === "list") {
        const lines = FRAMEWORKS.map(
          (f) => `${f.id.padEnd(10)} ${f.label}  ·  ${f.blurb}`,
        );
        await tgSendMessage(
          cfg.botToken,
          chatId,
          `Frameworks:\n${lines.join("\n")}\n\nactive: ${readResponseFramework() ?? "none"}\n\n/framework <id> to set, /framework none to clear`,
        );
        return;
      }
      if (a === "none" || a === "off" || a === "clear") {
        setResponseFramework(null);
        await tgSendMessage(cfg.botToken, chatId, "framework cleared");
        return;
      }
      if (!isFrameworkId(a)) {
        await tgSendMessage(cfg.botToken, chatId, `unknown framework "${a}". /framework list to see options.`);
        return;
      }
      setResponseFramework(a);
      const f = getFramework(a);
      await tgSendMessage(cfg.botToken, chatId, `framework: ${f?.label ?? a}`);
      return;
    }
    case "/frameworks": {
      const lines = FRAMEWORKS.map((f) => `${f.id.padEnd(10)} ${f.label}  ·  ${f.blurb}`);
      await tgSendMessage(cfg.botToken, chatId, `Frameworks:\n${lines.join("\n")}`);
      return;
    }
    case "/status": {
      const fw = readResponseFramework();
      await tgSendMessage(
        cfg.botToken,
        chatId,
        [
          `vault:     ${vaultPath}`,
          `domain:    ${state.domain.name}`,
          `cli:       ${state.cli.label}${state.model ? ` · ${state.model}` : ""}`,
          `council:   ${state.councilMode ? "ON" : "OFF"}`,
          `framework: ${fw ?? "(none)"}`,
        ].join("\n"),
      );
      return;
    }
    default:
      await tgSendMessage(
        cfg.botToken,
        chatId,
        `unknown command: ${head}\n/help for the list`,
      );
  }
}

async function sendCouncilResult(
  token: string,
  chatId: number,
  panel: PanelResult[],
  verdict: string,
  chairLabel: string,
  degraded: boolean,
): Promise<void> {
  // Send each panel response as its own message so each panelist gets
  // visual separation.
  for (const p of panel) {
    const tag = p.model ? `${p.cli.label}·${p.model}` : p.cli.label;
    const header = p.ok ? `🟦 ${tag}` : `⚠ ${tag}`;
    await sendLongMessage(token, chatId, `${header}\n\n${p.reply}`);
  }
  // Verdict delivery: when the chair produced the four-section format,
  // ship Divergence and Verdict as separate messages so the disagreement
  // surfaces with its own header on the user's phone instead of getting
  // buried mid-paragraph. Same principle as the TUI's hero block.
  const parsed = parseVerdict(verdict);
  const chairTag = chairLabel ? ` · ${chairLabel}` : "";
  const degradedTag = degraded ? " (⚠ degraded — single provider)" : "";
  if (parsed.structured) {
    if (parsed.panelistSaid) {
      await sendLongMessage(token, chatId, `▸ What each panelist said\n\n${parsed.panelistSaid}`);
    }
    if (parsed.consensus) {
      await sendLongMessage(token, chatId, `✅ Consensus\n\n${parsed.consensus}`);
    }
    if (parsed.divergence && parsed.hasDivergence) {
      await sendLongMessage(token, chatId, `🔀 Where panelists disagreed\n\n${parsed.divergence}`);
    }
    if (parsed.verdict) {
      await sendLongMessage(token, chatId, `⚖ Verdict${chairTag}${degradedTag}\n\n${parsed.verdict}`);
    }
  } else {
    // Chair ignored the format — fall back to single-message verdict so
    // we never silently drop content.
    await sendLongMessage(token, chatId, `⚖ Verdict${chairTag}${degradedTag}\n\n${verdict}`);
  }
}

// Split on paragraph boundaries to stay under Telegram's 4096-char ceiling.
// If a single paragraph is too long, hard-split on character count — better
// to deliver in pieces than to truncate the answer.
async function sendLongMessage(token: string, chatId: number, text: string): Promise<void> {
  const chunks: string[] = [];
  let cur = "";
  for (const para of text.split(/\n\n+/)) {
    const next = cur ? `${cur}\n\n${para}` : para;
    if (next.length > MAX_TELEGRAM_LEN) {
      if (cur) chunks.push(cur);
      if (para.length > MAX_TELEGRAM_LEN) {
        for (let i = 0; i < para.length; i += MAX_TELEGRAM_LEN) {
          chunks.push(para.slice(i, i + MAX_TELEGRAM_LEN));
        }
        cur = "";
      } else {
        cur = para;
      }
    } else {
      cur = next;
    }
  }
  if (cur) chunks.push(cur);
  for (const c of chunks) {
    await tgSendMessage(token, chatId, c);
  }
}

// --- Telegram Bot API plumbing ------------------------------------------------

async function tgGetUpdates(token: string, offset: number): Promise<TelegramUpdate[]> {
  const url = `${TELEGRAM_API}/bot${token}/getUpdates?offset=${offset}&timeout=30`;
  // Hard timeout slightly past the 30s long-poll so a wedged connection
  // doesn't pin the daemon forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`getUpdates HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { ok: boolean; result?: TelegramUpdate[]; description?: string };
    if (!json.ok) throw new Error(`getUpdates: ${json.description ?? "unknown error"}`);
    return json.result ?? [];
  } finally {
    clearTimeout(timer);
  }
}

async function tgSendMessage(token: string, chatId: number, text: string): Promise<void> {
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`sendMessage HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function tgSendChatAction(token: string, chatId: number, action: string): Promise<void> {
  const url = `${TELEGRAM_API}/bot${token}/sendChatAction`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncateForLog(s: string): string {
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}
