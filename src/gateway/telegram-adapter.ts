// =============================================================================
// TelegramAdapter — wraps the existing telegram.ts Bot API plumbing behind the
// generalized ChannelAdapter interface.
//
// TRACK E8 (additive). This does NOT rewrite the daemon (runTelegramDaemon stays
// as-is for the legacy `prevail daemon --telegram` path). Instead it DELEGATES
// to telegram.ts's exported primitives (gatewayTgGetUpdates / gatewayTgSend /
// readTelegramConfig), translating Telegram updates into the normalized
// InboundMessage envelope and outbound text back through the same sender.
//
// Allow-listing + private-chat-only enforcement are preserved here so the
// generalized path is no more permissive than the daemon: only allow-listed
// private 1:1 chats reach the handler.
// =============================================================================

import type { ChannelAdapter, InboundHandler, InboundMessage } from "./adapter.ts";
import { gatewayTgGetUpdates, gatewayTgSend } from "../telegram.ts";
import { readTelegramConfig, type TelegramConfig } from "../telegram-config.ts";

export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram";

  private cfg: TelegramConfig;
  private stopped = false;
  private offset = 0;
  private logger: (line: string) => void;

  constructor(opts?: { config?: TelegramConfig; logger?: (line: string) => void }) {
    const cfg = opts?.config ?? readTelegramConfig();
    if (!cfg) {
      throw new Error(
        "telegram not configured. Run `prevail telegram setup` first, or set PREVAIL_TELEGRAM_TOKEN.",
      );
    }
    if (!cfg.botToken) {
      throw new Error("telegram bot token is empty — set it via `prevail telegram setup`");
    }
    this.cfg = cfg;
    this.logger = opts?.logger ?? ((s) => console.log(`[gateway:telegram] ${s}`));
  }

  /** Begin long-polling. Delegates the wire fetch to telegram.ts and hands each
   *  allow-listed private message to the gateway handler as an InboundMessage. */
  async start(handler: InboundHandler): Promise<void> {
    this.stopped = false;
    let backoff = 1000;
    void (async () => {
      while (!this.stopped) {
        try {
          const updates = await gatewayTgGetUpdates(this.cfg.botToken, this.offset);
          backoff = 1000;
          for (const u of updates) {
            this.offset = Math.max(this.offset, u.update_id + 1);
            const msg = this.toInbound(u);
            if (msg) await handler(msg);
          }
        } catch (err) {
          if (this.stopped) break;
          this.logger(`poll error: ${(err as Error).message} — retry in ${backoff / 1000}s`);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    })().catch((err) => this.logger(`fatal: ${(err as Error).message}`));
  }

  stop(): void {
    this.stopped = true;
  }

  /** Deliver an outbound text reply. chatId arrives as a string (the normalized
   *  envelope shape); Telegram needs a numeric id, so parse defensively. */
  async send(chatId: string, text: string): Promise<void> {
    const id = Number(chatId);
    if (!Number.isFinite(id)) {
      throw new Error(`telegram send: non-numeric chatId "${chatId}"`);
    }
    await gatewayTgSend(this.cfg.botToken, id, text);
  }

  // --- internals ------------------------------------------------------------

  /** Translate a raw Telegram update into a normalized InboundMessage, applying
   *  the same security gates the daemon uses: private chats only, and BOTH the
   *  chat AND sender must be allow-listed. Returns null to drop the update. */
  private toInbound(u: { message?: { chat: { id: number; type?: string }; from?: { id: number }; text?: string } }): InboundMessage | null {
    const m = u.message;
    if (!m || !m.text) return null;
    const chatId = m.chat.id;
    const fromId = m.from?.id;
    const chatType = m.chat.type ?? "private";

    // SECURITY: private 1:1 only — mirrors handleUpdate in telegram.ts.
    if (chatType !== "private") {
      this.logger(`ignored chat_id=${chatId} type=${chatType} (only private chats supported)`);
      return null;
    }
    // SECURITY: require both the chat AND the sender to be allow-listed.
    if (
      !fromId ||
      !this.cfg.allowList.includes(fromId) ||
      !this.cfg.allowList.includes(chatId)
    ) {
      this.logger(
        `ignored chat_id=${chatId} from=${fromId ?? "?"} (not in allowList). Add with: prevail telegram add-user ${chatId}`,
      );
      return null;
    }

    return {
      channel: this.id,
      chatId: String(chatId),
      text: m.text.trim(),
      ts: Date.now(),
    };
  }
}
