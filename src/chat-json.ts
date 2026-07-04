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
import { mkdirSync } from "node:fs";

import {
  detectClis,
  defaultModelFor,
  runChatTurn,
  MODEL_QUICKPICKS_FALLBACK,
  type AvailableCli,
  type CliKind,
} from "./cli-bridge.ts";
import { isLocalCliKind } from "./model-pricing.ts";
import {
  normalizeBias,
  deriveHeuristics,
  makeCandidate,
  routeWithFallback,
  shouldRunClassifier,
  classifyPrompt,
  metaFor,
  cascadeEnabled,
  pickCheaperCandidate,
  cascadeShouldEscalate,
  type RouteCandidate,
} from "./model-routing.ts";
import { readRouteOverrides, type RouteOverride } from "./route-learning.ts";
import { generalDir } from "./decisions.ts";
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
  type: "start" | "user" | "delta" | "assistant" | "tool" | "usage" | "error" | "done" | "route";
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
  // Emitted once, before the turn, when model === "auto": the model the router
  // chose and why. Consumers render this as a routing chip. Absent on every
  // non-auto turn (the stream is byte-identical to before in that case).
  route?: {
    cli: string;
    model: string;
    reason: string;
    confidence: number;
    difficulty?: number;
    bias?: string;
  };
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
  // Per-turn web-access override (desktop "Web access" Modes toggle). "deny"
  // hard-blocks web for this turn; absent => fall back to the global setting.
  webAccess?: "allow" | "deny";
  // Economy / Balanced / Quality bias for the Auto router. Only consulted when
  // model === "auto"; absent => PREVAIL_ROUTE_BIAS env => "balanced".
  routeBias?: string;
  // Layer 4 cascade escalation (opt-in, default OFF). Only consulted when
  // model === "auto"; absent => PREVAIL_ROUTE_CASCADE env => off. When on AND the
  // router lands in the ambiguous middle band, the turn runs the cheaper pick
  // first and escalates to the normal pick only if a confidence check fails.
  routeCascade?: boolean;
  // The user's Google-account chip selection (composer Modes). Threaded to the
  // google_workspace connector as its authoritative default target account.
  // Comma-joined list allowed; absent => the connector's own default account.
  googleAccount?: string;
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
  // A network/exFAT vault makes macOS drop AppleDouble "._<thread>.md" sidecars;
  // if one is ever picked up as the active thread, the resume id arrives as
  // "._<slug>" and threadJsonlPath rejects it, blocking every follow-up. Strip a
  // leading dot/underscore prefix so it maps back to the real "<slug>" thread
  // (continuity preserved), and drop any other disallowed char before use.
  const rawSession = (opts.sessionId ?? "").trim().replace(/^\._?/, "").replace(/[^A-Za-z0-9_-]/g, "");
  const sessionId = rawSession || makeSessionId();
  const thread = sessionId;

  const fail = (error: string): number => {
    emit({ type: "error", thread, ts: Date.now(), error });
    return 1;
  };

  const message = opts.message?.trim();
  if (!message) return fail("empty message");

  let domain = findDomain(vaultPath, opts.domain);
  // General may not be scaffolded on disk yet (no chats stored there). It's a
  // real, addressable space, so synthesize it at general_dir rather than
  // failing — this is what lets domainless General chat run.
  const wantName = (opts.domain ?? "").trim();
  if (!domain && (wantName === "general" || wantName === "__general__" || wantName === "")) {
    const gdir = generalDir(vaultPath);
    try { mkdirSync(gdir, { recursive: true }); } catch { /* best effort */ }
    domain = { name: "general", path: gdir, hasState: false, openLoopCount: 0, stateMtime: null, skills: [] };
  }
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

  // Resolve the model. The ONLY behavioral change from before is guarded behind
  // the single `model === "auto"` sentinel check: with any other model value the
  // stream is byte-identical to before. In auto mode we run the router (over
  // THIS cli's catalog, after privacy has already restricted the cli under
  // Bunker/local-only), pick a concrete model, and emit a `route` event.
  let model = (opts.model ?? "").trim();
  let routeInfo: NonNullable<ChatEvent["route"]> | null = null;
  // Layer 4 cascade plan, set only when cascade is on AND the router lands in the
  // ambiguous middle band AND a cheaper candidate exists. Null => the single-turn
  // path runs unchanged (cascade off / obvious band / no cheaper model).
  let cascadePlan: {
    cheapModel: string;
    targetModel: string;
    difficulty: number;
    confidence: number;
    bias: string;
  } | null = null;
  if (model === "auto") {
    const localOnly = opts.localOnly ?? false;
    const bias = normalizeBias(opts.routeBias ?? process.env.PREVAIL_ROUTE_BIAS);
    // Candidate models = what this runtime offers. Empty catalog => the runtime
    // default (Auto is then a no-op with zero added latency).
    const catalog = MODEL_QUICKPICKS_FALLBACK[cli.kind] ?? [];
    const modelIds = catalog.length ? catalog : [defaultModelFor(cli.kind)].filter((m) => m.length > 0);
    const candidates: RouteCandidate[] = modelIds.map((m) => makeCandidate(cli.kind, m));

    // Layer 1 heuristics decide whether the ambiguous-middle classifier is worth
    // a call. The classifier runs on THIS cli (already local under Bunker), on
    // its cheapest model, and fails open to heuristics.
    let classified = null as Awaited<ReturnType<typeof classifyPrompt>>;
    const h = deriveHeuristics(message);
    const classifierIsLocal = isLocalCliKind(cli.kind);
    if (
      candidates.length > 1 &&
      shouldRunClassifier({ ambiguous: h.ambiguous, hasClassifierCli: true, localOnly, classifierIsLocal })
    ) {
      const cheapest = [...candidates].sort((a, b) => metaFor(a.model).tier - metaFor(b.model).tier)[0]!;
      classified = await classifyPrompt({ message, cwd: domain.path, cli, model: cheapest.model });
    }

    // Learned router (v1): consult the user's LOCAL override history so Auto can
    // personalize per bucket. Defensive read: a missing/empty/corrupt store yields
    // [], which makes chooseModel byte-identical to the heuristic+classifier pick.
    let overrides: RouteOverride[] = [];
    try { overrides = readRouteOverrides(vaultPath); } catch { overrides = []; }

    const decision = routeWithFallback(
      { message, candidates, bias, localOnly, classified, domain: opts.domain, overrides },
      { cli: cli.kind, model: "" },
    );
    model = decision.model;
    routeInfo = {
      cli: decision.cli,
      model: decision.model,
      reason: decision.reason,
      confidence: decision.confidence,
      difficulty: decision.difficulty,
      bias: decision.bias,
    };

    // Layer 4 cascade: opt-in, and ONLY in the ambiguous middle band. Obvious-easy
    // and obvious-hard prompts never cascade (h.ambiguous is false for them), so
    // they keep today's single-turn behavior even with cascade on. When a cheaper
    // candidate than the router's pick exists, run it first and escalate only if
    // the confidence check fails; otherwise there is nothing cheaper to try and we
    // just run the normal pick once.
    if (cascadeEnabled(opts.routeCascade, process.env.PREVAIL_ROUTE_CASCADE) && h.ambiguous) {
      const cheap = pickCheaperCandidate(candidates, decision.tier);
      if (cheap && cheap.model && cheap.model !== decision.model) {
        cascadePlan = {
          cheapModel: cheap.model,
          targetModel: decision.model,
          difficulty: decision.difficulty,
          confidence: decision.confidence,
          bias: decision.bias,
        };
        // The turn STARTS on the cheaper model, so the initial route chip reflects
        // that honestly. If we escalate, a second `route` event announces it.
        model = cheap.model;
        routeInfo.model = cheap.model;
        routeInfo.reason = `cascade: trying ${cheap.model} first (${decision.reason})`;
      }
    }
  }
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
  // route (auto only) — the chosen model + why, for the routing chip. Emitted
  // before the model call so the UI can label the turn as it streams.
  if (routeInfo) {
    emit({ type: "route", thread, ts: startTs, domain: opts.domain, engine, route: routeInfo });
  }

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
  // The model that actually produced the final reply. Equals `model` on every
  // non-cascade turn (so the assistant/usage/persistence are byte-identical); on
  // a cascade escalation it becomes the escalated target.
  let ranModel = model;
  try {
    if (cascadePlan) {
      // 1) Cheap pass, BUFFERED (no deltas) so it can be discarded silently if we
      //    escalate - the consumer never sees a throwaway partial answer.
      const cheapReply = await runChatTurn({
        prompt: message,
        cwd: domain.path,
        cli,
        model: cascadePlan.cheapModel,
        isFirst: !opts.sessionId,
        webAccess: opts.webAccess,
        googleAccount: opts.googleAccount,
      });
      if (cascadeShouldEscalate({ difficulty: cascadePlan.difficulty, confidence: cascadePlan.confidence, reply: cheapReply })) {
        // 2) Escalate: announce it transparently with a second `route` event, then
        //    re-run on the router's normal pick WITH streaming (the normal UX).
        ranModel = cascadePlan.targetModel;
        emit({
          type: "route",
          thread,
          ts: Date.now(),
          domain: opts.domain,
          engine: engineLabel(cli, ranModel),
          route: {
            cli: cli.kind,
            model: ranModel,
            reason: `escalated from ${cascadePlan.cheapModel}: the cheaper model was not confident enough`,
            confidence: cascadePlan.confidence,
            difficulty: cascadePlan.difficulty,
            bias: cascadePlan.bias,
          },
        });
        reply = await runChatTurn({
          prompt: message,
          cwd: domain.path,
          cli,
          model: ranModel,
          isFirst: !opts.sessionId,
          webAccess: opts.webAccess,
          googleAccount: opts.googleAccount,
          onChunk: (delta: string) => {
            if (!delta) return;
            reply += delta;
            emit({ type: "delta", thread, ts: Date.now(), text: delta });
          },
        });
      } else {
        // The cheap answer stands. Emit it as one delta so a stream-only consumer
        // still renders the text, then fall through to the shared finalize path.
        reply = cheapReply;
        if (reply) emit({ type: "delta", thread, ts: Date.now(), text: reply });
      }
    } else {
      reply = await runChatTurn({
        prompt: message,
        cwd: domain.path,
        cli,
        model,
        isFirst: !opts.sessionId, // resume → not first (claude uses --continue)
        webAccess: opts.webAccess,
        googleAccount: opts.googleAccount,
        onChunk: (delta: string) => {
          if (!delta) return;
          reply += delta;
          emit({ type: "delta", thread, ts: Date.now(), text: delta });
        },
      });
    }
  } catch (err) {
    return fail((err as Error)?.message ?? "chat turn failed");
  }

  const doneTs = Date.now();
  // On a cascade escalation the reply came from the escalated model, so label the
  // finalized events with it; otherwise this is byte-identical to `engine`.
  const finalEngine = ranModel === model ? engine : engineLabel(cli, ranModel);
  // assistant (finalized full reply)
  emit({
    type: "assistant",
    thread,
    ts: doneTs,
    role: "assistant",
    text: reply,
    engine: finalEngine,
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
    model: ranModel,
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
    model: ranModel,
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
  let webAccess: "allow" | "deny" | undefined;
  let routeBias: string | undefined;
  let routeCascade: boolean | undefined;
  let googleAccount: string | undefined;
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
    else if (a === "--web") { const v = (next ?? "").toLowerCase(); if (v === "allow" || v === "deny") webAccess = v; i++; }
    else if (a.startsWith("--web=")) { const v = a.slice("--web=".length).toLowerCase(); if (v === "allow" || v === "deny") webAccess = v; }
    else if (a === "--route-bias") { routeBias = next; i++; }
    else if (a.startsWith("--route-bias=")) routeBias = a.slice("--route-bias=".length);
    else if (a === "--route-cascade") routeCascade = true;
    else if (a === "--no-route-cascade") routeCascade = false;
    else if (a.startsWith("--route-cascade=")) { const v = a.slice("--route-cascade=".length).toLowerCase(); routeCascade = v === "1" || v === "true" || v === "on" || v === "yes"; }
    else if (a === "--google-account") { googleAccount = next; i++; }
    else if (a.startsWith("--google-account=")) googleAccount = a.slice("--google-account=".length);
    else if (a === "--vault") { vaultPath = resolve(process.cwd(), next ?? ""); i++; }
    else if (a.startsWith("--vault=")) vaultPath = resolve(process.cwd(), a.slice("--vault=".length));
    // --json is implied by this command path; tolerate it being present.
  }

  // General is a first-class domain: an empty/omitted --domain means the
  // domainless General space, which lives at general_dir (data/domains/general
  // or the vault root) — the same place the desktop persists General threads.
  // Normalizing here lets OpenRouter / LM Studio / MLX chat in General.
  if (!domain.trim()) domain = "general";

  if (message === undefined) {
    // Read the message from stdin (matches ENGINE-JSON-API: "user message is
    // read from stdin or a --message flag").
    message = await readStdin();
  }

  // Bunker Mode (set by the desktop via PREVAIL_BUNKER=1): force local-only as
  // a defense-in-depth backstop, independent of the --local-only flag, so the
  // engine can never dispatch to a cloud provider while the app is locked down.
  if (process.env.PREVAIL_BUNKER === "1") localOnly = true;

  return runChatJson({
    vaultPath,
    domain,
    message: message ?? "",
    cli: cli as CliKind | undefined,
    model,
    sessionId,
    localOnly,
    webAccess,
    routeBias,
    routeCascade,
    googleAccount,
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
