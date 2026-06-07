// =============================================================================
// Gateway — owns N ChannelAdapters and routes their normalized inbound messages
// to a domain DETERMINISTICALLY via manifest.routing.keywords (falling back to
// the manifest.routing.default domain, then the vault's first domain). It then
// dispatches the prompt through the EXISTING chat path (cli-bridge.runChatTurn,
// the same call telegram.ts and the TUI use) and sends the reply back through
// the originating adapter.
//
// TRACK E8 (additive). Key invariant: the MODEL NEVER PICKS THE CHANNEL OR THE
// DOMAIN. Routing is a pure keyword match computed here, before any model call,
// so the same message always lands in the same domain. WhatsApp is a TODO note
// (see registerWhatsAppTODO) — only Telegram is wired today.
// =============================================================================

import { detectClis, runChatTurn, type AvailableCli } from "../cli-bridge.ts";
import { scanVault, type Domain } from "../vault.ts";
import { readManifest } from "../manifest.ts";
import { writeTurnSummary } from "../auto-summary.ts";
import { readTelegramConfig } from "../telegram-config.ts";
import type { ChannelAdapter, InboundMessage } from "./adapter.ts";

/** Outcome of routing a message to a domain. Exposed for logging/tests so the
 *  routing decision is inspectable without a model call. */
export interface RouteDecision {
  domain: Domain;
  matchedKeyword: string | null;
  reason: "keyword" | "default" | "first";
}

export interface GatewayOptions {
  vaultPath: string;
  logger?: (line: string) => void;
}

/** Lowercase + collapse whitespace for case/format-insensitive keyword match. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export class Gateway {
  private readonly vaultPath: string;
  private readonly log: (line: string) => void;
  private readonly adapters = new Map<string, ChannelAdapter>();

  private domains: Domain[] = [];
  private clis: AvailableCli[] = [];
  private defaultCli: AvailableCli | null = null;
  private running = false;
  private readonly abort = new AbortController();

  constructor(opts: GatewayOptions) {
    this.vaultPath = opts.vaultPath;
    this.log = opts.logger ?? ((s) => console.log(`[gateway] ${s}`));
  }

  /** Register an adapter. Idempotent per adapter id (last registration wins). */
  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /** List the ids of all registered adapters. */
  adapterIds(): string[] {
    return [...this.adapters.keys()];
  }

  /** Bring the gateway up: scan the vault, detect CLIs, and start every
   *  registered adapter with a handler that routes → dispatches → replies. */
  async start(): Promise<void> {
    this.domains = scanVault(this.vaultPath);
    if (this.domains.length === 0) {
      throw new Error(`no domains found in vault: ${this.vaultPath}`);
    }
    this.clis = await detectClis();
    if (this.clis.length === 0) {
      throw new Error("no CLIs detected — install claude/codex/gemini or start ollama first");
    }
    this.defaultCli = this.clis.find((c) => c.kind === "claude") ?? this.clis[0]!;
    this.running = true;

    for (const adapter of this.adapters.values()) {
      await adapter.start((msg) => this.dispatch(adapter, msg));
      this.log(`adapter '${adapter.id}' started`);
    }
    this.log(
      `started. vault=${this.vaultPath} domains=${this.domains.length} adapters=${this.adapterIds().join(",")}`,
    );
  }

  /** Stop every adapter and abort any in-flight model calls. */
  stop(): void {
    this.running = false;
    for (const adapter of this.adapters.values()) adapter.stop();
    this.abort.abort();
  }

  /**
   * Deterministic routing: pick the domain whose manifest.routing.keywords
   * first matches the message text (domains scanned in canonical order,
   * keywords in manifest order). Fallback chain: keyword → routing.default →
   * first domain. The model is never consulted.
   */
  route(text: string): RouteDecision {
    const haystack = norm(text);
    let defaultDomain: Domain | null = null;

    for (const d of this.domains) {
      const m = readManifest(this.vaultPath, d.name);
      if (!m) continue;
      if (m.routing.default && defaultDomain === null) defaultDomain = d;
      if (haystack.length > 0) {
        for (const kw of m.routing.keywords) {
          const k = norm(kw);
          if (k.length > 0 && haystack.includes(k)) {
            return { domain: d, matchedKeyword: kw, reason: "keyword" };
          }
        }
      }
    }

    if (defaultDomain) {
      return { domain: defaultDomain, matchedKeyword: null, reason: "default" };
    }
    return { domain: this.domains[0]!, matchedKeyword: null, reason: "first" };
  }

  /** Route one inbound message to a domain and run it through the existing chat
   *  path, then reply on the same adapter. Errors are reported back to the user
   *  channel rather than crashing the poll loop. */
  private async dispatch(adapter: ChannelAdapter, msg: InboundMessage): Promise<void> {
    if (!this.running || !this.defaultCli) return;
    const decision = this.route(msg.text);
    this.log(
      `${msg.channel}:${msg.chatId} → domain=${decision.domain.name} (${decision.reason}${decision.matchedKeyword ? `:${decision.matchedKeyword}` : ""}) > ${truncate(msg.text)}`,
    );

    try {
      const reply = await runChatTurn({
        prompt: msg.text,
        cwd: decision.domain.path,
        cli: this.defaultCli,
        model: "",
        isFirst: true,
        bare: true,
        signal: this.abort.signal,
      });
      await adapter.send(msg.chatId, reply);
      // Self-curating vault: same auto-summary hook the daemon + TUI use.
      writeTurnSummary({
        domainPath: decision.domain.path,
        userPrompt: msg.text,
        assistantReply: reply,
        cliLabel: `${this.defaultCli.label} (via ${msg.channel})`,
        ts: Date.now(),
        kind: "chat",
      });
    } catch (err) {
      await adapter
        .send(msg.chatId, `error: ${(err as Error).message}`)
        .catch(() => {});
    }
  }
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

// =============================================================================
// `prevail gateway status --json` — machine-only status object. Mirrors the
// shape conventions of heartbeat.status() (ok:true + flat fields). Reports the
// configured channels and, per domain, its routing keywords + default flag so
// an operator can see exactly how inbound messages will be routed WITHOUT
// starting the gateway or invoking a model.
//
// WhatsApp: TODO — not yet implemented. It will appear here as
// { id: "whatsapp", configured: false } once an adapter lands.
// =============================================================================

export interface GatewayChannelStatus {
  id: string;
  configured: boolean;
}

export interface GatewayDomainRouting {
  domain: string;
  keywords: string[];
  default: boolean;
}

export interface GatewayStatus {
  ok: true;
  vault: string;
  channels: GatewayChannelStatus[];
  routing: GatewayDomainRouting[];
}

/** Build the status object for `prevail gateway status --json`. Pure read — no
 *  adapters are started and no model is called. */
export function gatewayStatusCommand(vaultPath: string): GatewayStatus {
  let telegramConfigured = false;
  try {
    telegramConfigured = !!readTelegramConfig()?.botToken;
  } catch {
    telegramConfigured = false;
  }

  const channels: GatewayChannelStatus[] = [
    { id: "telegram", configured: telegramConfigured },
    // WhatsApp: TODO — adapter not implemented yet.
    { id: "whatsapp", configured: false },
  ];

  let routing: GatewayDomainRouting[] = [];
  try {
    routing = scanVault(vaultPath).map((d) => {
      const m = readManifest(vaultPath, d.name);
      return {
        domain: d.name,
        keywords: m?.routing.keywords ?? [],
        default: m?.routing.default ?? false,
      };
    });
  } catch {
    routing = [];
  }

  return { ok: true, vault: vaultPath, channels, routing };
}
