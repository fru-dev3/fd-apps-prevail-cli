// chat-json — the `prevail chat --domain X --json` handler.
//
// Runs a single chat turn in a domain and emits an NDJSON stream of
// ChatEvent objects (docs/schemas/ChatEvent.json) — one JSON object per
// line, flushed as it happens. Typical order:
//
//   start → (delta*) → assistant → usage → done
//
// On failure it emits a single `error` event (and still exits non-zero).
//
// This is the machine-facing twin of the interactive chat pane. It reuses
// the existing cli-bridge `runChatTurn` streaming path (onChunk → delta
// events) so the engine behavior is identical to the TUI. The finalized turn
// (user + assistant) is persisted append-only to the JSONL source-of-truth at
// <vault>/<domain>/_threads/<sessionId>.jsonl via session.ts, and mirrored
// into the rebuildable SQLite/FTS index — keeping JSONL canonical and the
// .db a regenerable cache (VAULT-SPEC §4).

import { resolve } from "node:path";

import {
  detectClis,
  defaultModelFor,
  runChatTurn,
  type AvailableCli,
  type CliKind,
} from "./cli-bridge.ts";
import { scanVault, type Domain } from "./vault.ts";
import { isCliKind } from "./config.ts";
import {
  makeSessionId,
  makeTurnId,
  persistMessage,
  writeThreadTurn,
  importDesktopThreads,
  type ThreadTurn,
} from "./session.ts";

// One ChatEvent as emitted on the NDJSON stream. Shape tracks
// docs/schemas/ChatEvent.json — kept as a local interface (rather than
// importing a generated type) so chat-json owns its wire contract.
export interface ChatEvent {
  type: "start" | "user" | "delta" | "assistant" | "tool" | "usage" | "error" | "done";
  thread: string;
  ts: number;
  domain?: string;
  role?: "user" | "assistant" | "system" | "tool";
  text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
  };
  engine?: string;
  error?: string;
}

// Options for one JSON chat turn.
export interface ChatJsonOptions {
  vaultPath: string;
  domain: string;
  message: string;
  // Engine overrides. When absent, fall back to the first detected CLI and
  // that CLI's default model. (Per-domain manifest defaults are layered in by
  // the engine track via manifest.ts; this handler stays self-contained so it
  // typechecks and runs without that module.)
  cli?: CliKind;
  model?: string;
  // Resume an existing thread (append to <sessionId>.jsonl) instead of opening
  // a new one. When absent a fresh session id is minted.
  sessionId?: string;
  // Honor the global --local-only flag: forbid non-local engines for this run.
  localOnly?: boolean;
  // Where to write each NDJSON line. Defaults to process.stdout. Injectable
  // for tests.
  write?: (line: string) => void;
}

// Rough token/cost estimate for one turn. None of the subprocess CLIs report
// real token usage on stdout, so — like council-cost.ts — we approximate from
// character counts (~4 chars/token) and a per-CLI per-1K-token price. This is
// explicitly a heuristic; the `usage` event documents spend order-of-magnitude,
// not billing truth.
const USD_PER_1K_TOKENS: Record<string, { in: number; out: number }> = {
  claude: { in: 0.003, out: 0.015 },
  codex: { in: 0.0025, out: 0.01 },
  antigravity: { in: 0.00125, out: 0.005 },
  ollama: { in: 0, out: 0 },
};

function estimateUsage(
  cliKind: string,
  promptChars: number,
  replyChars: number,
): NonNullable<ChatEvent["usage"]> {
  const inputTokens = Math.ceil(promptChars / 4);
  const outputTokens = Math.ceil(replyChars / 4);
  const price = USD_PER_1K_TOKENS[cliKind] ?? USD_PER_1K_TOKENS.claude!;
  const cost = (inputTokens / 1000) * price.in + (outputTokens / 1000) * price.out;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    // Round to a sane number of significant digits.
    cost_usd: Math.round(cost * 1e6) / 1e6,
  };
}

// "claude:opus-4-8"-style engine label for the start/assistant events.
function engineLabel(cli: AvailableCli, model: string): string {
  const m = model.trim() || defaultModelFor(cli.kind);
  return `${cli.kind}:${m}`;
}

function findDomain(vaultPath: string, name: string): Domain | null {
  const domains = scanVault(vaultPath);
  return domains.find((d) => d.name === name) ?? null;
}

// Pick the engine for this turn. Preference order:
//   1. explicit opts.cli (must be detected; under --local-only must be ollama)
//   2. first detected CLI (ollama first under --local-only)
function pickCli(
  available: AvailableCli[],
  wanted: CliKind | undefined,
  localOnly: boolean,
): AvailableCli | null {
  const pool = localOnly ? available.filter((c) => c.kind === "ollama") : available;
  if (pool.length === 0) return null;
  if (wanted) {
    const hit = pool.find((c) => c.kind === wanted);
    if (hit) return hit;
    return null; // requested engine not available (or not local under local-only)
  }
  return pool[0]!;
}

// Run one chat turn and stream ChatEvent NDJSON. Resolves to the process exit
// code (0 ok, non-zero on error) so the index command wrapper can exit with it.
export async function runChatJson(opts: ChatJsonOptions): Promise<number> {
  const write = opts.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const emit = (ev: ChatEvent) => write(JSON.stringify(ev));

  const vaultPath = resolve(opts.vaultPath);
  const sessionId = opts.sessionId?.trim() || makeSessionId();
  const thread = sessionId;

  const fail = (error: string): number => {
    emit({ type: "error", thread, ts: Date.now(), error });
    return 1;
  };

  const message = opts.message?.trim();
  if (!message) return fail("empty message");

  const domain = findDomain(vaultPath, opts.domain);
  if (!domain) return fail(`unknown domain: ${opts.domain}`);

  // Lazy back-compat: fold any desktop-style _threads/<slug>.md transcripts
  // into JSONL so a freshly-imported vault has a uniform source of truth
  // before we append this turn. Idempotent — no-op once converted.
  importDesktopThreads(vaultPath, opts.domain);

  // Validate an explicitly requested cli string early (defends the public
  // entry point against junk passed by a caller that didn't go through the
  // index parser).
  let wantedCli: CliKind | undefined = opts.cli;
  if (opts.cli !== undefined && !isCliKind(opts.cli)) {
    return fail(`unknown cli: ${opts.cli}`);
  }

  const available = await detectClis();
  const cli = pickCli(available, wantedCli, opts.localOnly ?? false);
  if (!cli) {
    if (opts.localOnly) return fail("no local engine available (ollama not detected)");
    if (wantedCli) return fail(`engine not available: ${wantedCli}`);
    return fail("no AI CLI detected (claude/codex/antigravity/ollama)");
  }

  const model = (opts.model ?? "").trim();
  const engine = engineLabel(cli, model);
  const startTs = Date.now();

  // Pi-style branchable nodes: the user turn roots off the last node already
  // in the thread (null if this is a brand-new thread); the assistant turn
  // parents off the user turn. Reading the file back is the engine track's
  // job — here we just need the parent for the user node, and JSONL files are
  // append-only so the contract holds even if we don't read prior nodes.
  const userTurn: ThreadTurn = {
    id: makeTurnId(),
    parentId: null,
    role: "user",
    cli: cli.kind,
    model,
    content: message,
    ts: startTs,
  };

  // start
  emit({ type: "start", thread, ts: startTs, domain: opts.domain, engine });
  // echo the user turn so a consumer building UI from the stream alone has it
  emit({ type: "user", thread, ts: startTs, role: "user", text: message });

  // Persist the user turn before the model call so a crash mid-stream still
  // leaves the prompt on disk (JSONL source of truth + rebuildable index).
  writeThreadTurn(vaultPath, opts.domain, sessionId, userTurn);
  persistMessage({
    domain: opts.domain,
    session_id: sessionId,
    role: "user",
    content: message,
    ts: startTs,
    cli: cli.kind,
    model,
  });

  let reply = "";
  try {
    reply = await runChatTurn({
      prompt: message,
      cwd: domain.path,
      cli,
      model,
      isFirst: !opts.sessionId, // resume → not first (claude uses --continue)
      onChunk: (delta: string) => {
        if (!delta) return;
        reply += delta;
        emit({ type: "delta", thread, ts: Date.now(), text: delta });
      },
    });
  } catch (err) {
    return fail((err as Error)?.message ?? "chat turn failed");
  }

  const doneTs = Date.now();
  // assistant (finalized full reply)
  emit({
    type: "assistant",
    thread,
    ts: doneTs,
    role: "assistant",
    text: reply,
    engine,
  });

  // usage (heuristic — see estimateUsage)
  emit({
    type: "usage",
    thread,
    ts: doneTs,
    usage: estimateUsage(cli.kind, message.length, reply.length),
  });

  // Persist the assistant turn (JSONL canonical + FTS index).
  const assistantTurn: ThreadTurn = {
    id: makeTurnId(),
    parentId: userTurn.id,
    role: "assistant",
    cli: cli.kind,
    model,
    content: reply,
    ts: doneTs,
  };
  writeThreadTurn(vaultPath, opts.domain, sessionId, assistantTurn);
  persistMessage({
    domain: opts.domain,
    session_id: sessionId,
    role: "assistant",
    content: reply,
    ts: doneTs,
    cli: cli.kind,
    model,
  });

  // done
  emit({ type: "done", thread, ts: Date.now() });
  return 0;
}

// argv handler for `prevail chat --domain X --json`. Parses the flags this
// command accepts, reads the message from --message or stdin, runs the turn,
// and returns the exit code. The index command dispatcher calls this; it lives
// here so all chat-json wire logic stays in one owned module.
export async function chatJsonCommand(
  args: string[],
  vaultOverride: string | null,
): Promise<number> {
  let domain = "";
  let message: string | undefined;
  let cli: string | undefined;
  let model: string | undefined;
  let sessionId: string | undefined;
  let localOnly = false;
  let vaultPath = vaultOverride ?? "";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === "--domain") { domain = next ?? ""; i++; }
    else if (a.startsWith("--domain=")) domain = a.slice("--domain=".length);
    else if (a === "--message") { message = next ?? ""; i++; }
    else if (a.startsWith("--message=")) message = a.slice("--message=".length);
    else if (a === "--cli") { cli = next; i++; }
    else if (a.startsWith("--cli=")) cli = a.slice("--cli=".length);
    else if (a === "--model") { model = next; i++; }
    else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    else if (a === "--session") { sessionId = next; i++; }
    else if (a.startsWith("--session=")) sessionId = a.slice("--session=".length);
    else if (a === "--local-only") localOnly = true;
    else if (a === "--vault") { vaultPath = resolve(process.cwd(), next ?? ""); i++; }
    else if (a.startsWith("--vault=")) vaultPath = resolve(process.cwd(), a.slice("--vault=".length));
    // --json is implied by this command path; tolerate it being present.
  }

  if (message === undefined) {
    // Read the message from stdin (matches ENGINE-JSON-API: "user message is
    // read from stdin or a --message flag").
    message = await readStdin();
  }

  return runChatJson({
    vaultPath,
    domain,
    message: message ?? "",
    cli: cli as CliKind | undefined,
    model,
    sessionId,
    localOnly,
  });
}

async function readStdin(): Promise<string> {
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Uint8Array);
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  } catch {
    return "";
  }
}
