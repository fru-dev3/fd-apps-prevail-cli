import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Stored alongside the rest of the prevail config in ~/.prevail/. Chmod'd to
// 0600 because it holds the bot token, which is equivalent to a password for
// the bot account.
export interface TelegramConfig {
  // Bot token from @BotFather. Required.
  botToken: string;
  // Telegram chat IDs allowed to talk to this bot. Each user gets their
  // chat ID by messaging the bot once and reading the daemon log — manual
  // bootstrap, but it means we never accept commands from strangers.
  allowList: number[];
  // Optional: which CLI to use when an allowlisted user sends a non-command
  // message. Defaults to the first detected CLI at daemon start.
  defaultCli?: "claude" | "codex" | "gemini" | "ollama";
  // Optional: starting domain when a new chat session is opened.
  defaultDomain?: string;
  // Whether council mode is the default for new chats. Off by default —
  // council is N+1× the API cost, so opt-in.
  councilByDefault?: boolean;
}

export function telegramConfigFile(): string {
  return join(homedir(), ".prevail", "telegram.json");
}

export function readTelegramConfig(): TelegramConfig | null {
  // Env var wins over file so a daemon can be run with a one-off token
  // without writing it to disk (useful for systemd unit files).
  const envToken = process.env.PREVAIL_TELEGRAM_TOKEN;
  const envAllow = process.env.PREVAIL_TELEGRAM_ALLOW;
  let fileCfg: TelegramConfig | null = null;
  const f = telegramConfigFile();
  if (existsSync(f)) {
    try {
      fileCfg = JSON.parse(readFileSync(f, "utf8")) as TelegramConfig;
    } catch {
      fileCfg = null;
    }
  }
  if (!envToken && !fileCfg) return null;
  return {
    botToken: envToken ?? fileCfg!.botToken,
    allowList: envAllow
      ? envAllow
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n))
      : (fileCfg?.allowList ?? []),
    defaultCli: fileCfg?.defaultCli,
    defaultDomain: fileCfg?.defaultDomain,
    councilByDefault: fileCfg?.councilByDefault,
  };
}

export function writeTelegramConfig(cfg: TelegramConfig): void {
  const f = telegramConfigFile();
  const dir = dirname(f);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(f, JSON.stringify(cfg, null, 2));
  try {
    chmodSync(f, 0o600);
  } catch {
    // chmod can fail on some filesystems (Windows, certain network mounts).
    // The data is still written; just less locked down.
  }
}

export function setTelegramToken(token: string): void {
  const cur = readTelegramConfig() ?? { botToken: "", allowList: [] };
  writeTelegramConfig({ ...cur, botToken: token });
}

export function addAllowedChatId(chatId: number): boolean {
  const cur = readTelegramConfig();
  if (!cur) {
    throw new Error("telegram not configured — run `prevail telegram setup` first");
  }
  if (cur.allowList.includes(chatId)) return false;
  writeTelegramConfig({ ...cur, allowList: [...cur.allowList, chatId] });
  return true;
}

export function removeAllowedChatId(chatId: number): boolean {
  const cur = readTelegramConfig();
  if (!cur) return false;
  if (!cur.allowList.includes(chatId)) return false;
  writeTelegramConfig({
    ...cur,
    allowList: cur.allowList.filter((id) => id !== chatId),
  });
  return true;
}
