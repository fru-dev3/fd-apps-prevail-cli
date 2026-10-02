// chat-json — the `prevail chat --domain X --json` handler.
//
// Runs a single chat turn in a domain and emits an NDJSON stream of
// ChatEvent objects (docs/schemas/ChatEvent.json) — one JSON object per
// line, flushed as it happens. Typical order:
//
//   start → (delta*) → assistant → usage → done → (touched)
//
// `touched` comes after `done`, just before the process exits: the reply is
// never held up for it. It says which other domains and which of the user's
// own entities the exchange also concerns (linking.ts), and is absent when
// nothing was touched, the step was skipped, or it ran past its deadline.
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
  MODEL_QUICKPICKS_FALLBACK,
  type AvailableCli,
  type CliKind,
  type ToolEvent,
} from "./cli-bridge.ts";
import { stepLabel, stepDetail } from "./tool-labels.ts";
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
import { updateMirrorStatus } from "./apps-mirror.ts";
import { appReadTools, initAppProblems, appToolAccess, mirrorApps, planAppRouting } from "./app-scope.ts";
import type { MirrorApp } from "./apps-mirror.ts";
import { turnSources } from "./trusted-sources.ts";
import { APP_SCOPE_PREFIX } from "./path-safety.ts";
import { isCliKind } from "./config.ts";
import { classifyTouches } from "./route.ts";
import { runTouchStep, userText } from "./linking.ts";
import { decisionLayer } from "./decision-config.ts";
import { readManifest } from "./manifest.ts";
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
  type: "start" | "user" | "delta" | "assistant" | "tool" | "usage" | "error" | "done" | "route"
    | "routed" | "app_unavailable" | "app_needs_auth" | "touched" | "job" | "bring_in" | "mission_start" | "filed" | "decision_offer";
  thread: string;
  ts: number;
  domain?: string;
  role?: "user" | "assistant" | "system" | "tool";
  text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
    // True when the counts are a character-based estimate (about 4 characters
    // a token), not the runtime's own numbers. The real per-turn tokens come
    // from the runtime's transcript (`prevail ai usage`).
    estimated?: boolean;
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
  // A live execution step: one REAL tool call, streamed during the turn so the
  // desktop can render a checklist of what the model is actually doing (Reading
  // Gmail, Creating a Google Doc, Saving to Drive...) instead of an opaque
  // spinner. Emitted on `type: "tool"` events. `text` mirrors `step.label` for
  // back-compat with older consumers. `status` flips running -> done/failed when
  // the tool returns, matched by `id`. Present on app AND domain chats (both go
  // through the same turn path). Absent on turns with no tools, so those stream
  // byte-for-byte as before.
  step?: {
    id: string;
    label: string;
    status: "running" | "done" | "failed";
    // The concrete target of the call (query / file / command / connector argv)
    // while running, and the error snippet when failed - the debugging line.
    detail?: string;
  };
  // The model's declared plan for a multi-step job (from its TodoWrite list),
  // rendered as a header above the live checklist. Re-sent whenever the model
  // revises the plan. Absent on simple one-shot replies.
  plan?: string[];
  // Apps as chat scopes. `app` is the referenced app's id on app_unavailable /
  // app_needs_auth, and on a `tool` event whose tool belongs to a mirrored app.
  app?: string;
  // On a `tool` event with `app`: the tool's short name (search, send_message)
  // and its access class, from the same classifier as the app access log.
  tool?: string;
  access?: "read" | "write" | "blocked";
  // routed: the engine kind the turn moved to, and why.
  runtime?: string;
  reason?: string;
  // app_unavailable: the engine kind that owns the app's connector.
  runtime_needed?: string;
  // app_needs_auth: the app's display name and, when known, where to sign in.
  name?: string;
  signin_url?: string;
  // touched: the other domains this exchange concerns, one fact line each, and
  // the user's own entities it named (ids). `domains` never holds the
  // conversation's own domain.
  domains?: { slug: string; fact: string }[];
  entities?: string[];
  // job: the chief of staff staffed this message as a job (jobs.ts). The
  // turn's reply is one line; the card polls `prevail job show <id>`.
  // bring_in: a mission turn reached outside the mission; the user says yes
  // (for this question or for the mission) or no. Nothing was read.
  bringIn?: { mission: string; domains: string[]; never: boolean; why: string };
  // mission_start: the message sounds like a mission; a Start card the user
  // confirms (prevail missions create). Never started without a yes.
  missionDraft?: { name: string; outcome: string; owner?: string; consulted: string[]; specialists: string[]; target?: string };
  /** A commitment or waiting-for filed from what the user said (Today T2), with its id for Undo. */
  filed?: { id: string; kind: "commitment" | "waiting"; domain: string; text: string; due?: string; person?: string };
  /** A deliberation noticed in chat (Today T4): offer to open a decision record. */
  decisionOffer?: { question: string; domain: string; due: string };
  job?: { id: string; status: string; startsAlone: boolean; askReason?: string; owner: string; consulted: string[]; informed: string[]; team: { step: number; specialists: string[]; gate?: boolean }[]; effort: string; budget: { usd: number; minutes: number }; why: string; mention?: string };
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
  // "all": reads fan out across every account, writes go to the default one.
  // "claude": Claude's own one-account connector (no gws pick).
  googleAccount?: string;
  // App-chat passthrough: let the turn also see the user's own Claude Code MCP
  // servers (their claude.ai connectors). Strict surface otherwise.
  inheritUserMcp?: boolean;
  // The Prevail thread this turn belongs to, for approval linkage: exported to
  // the model CLI as PREVAIL_THREAD_ID so a held act records its conversation.
  // Defaults to an explicit sessionId; a freshly minted session carries none
  // (nothing outside this process could map it back to a conversation).
  threadId?: string;
  // Context sent to the model ahead of the message but NOT persisted as part
  // of the user turn (a scheduled turn passes the thread's recent history).
  preamble?: string;
  // Start a fresh model session even when resuming a thread (a scheduled turn
  // supplies its context through `preamble` instead).
  fresh?: boolean;
  // Mission chat (--mission <slug>): the turn runs in data/missions/<slug>,
  // its thread lives in the mission's memory/threads, and dispatch is scoped
  // to the mission's domains, apps and specialists (scope.ts, jobs.ts).
  mission?: string;
  // Entity chat: an entity id (person/foo). Every turn gets the entity's
  // context block (entities.ts entityChatBlock) ahead of the message, rebuilt
  // from the page each turn and never persisted with the user turn.
  // Several may be given (one block each, sharing ENTITY_BUDGET); the first is
  // exported to the turn as PREVAIL_ENTITY_ID.
  entity?: string | string[];
  // Apps referenced on this turn (--app, repeatable): an APP CONTEXT block
  // each, runtime routing, and sign-in notices. Rebuilt every turn.
  apps?: string[];
  // The app whose own chat space this thread lives in (--scope-app). Implies
  // it is referenced too; the turn runs in data/apps/<id>/_scope.
  scopeApp?: string;
  // Other domains referenced on this turn (--ref-domain, repeatable): a compact
  // state block each.
  refDomains?: string[];
  // Incognito: nothing about this conversation spreads past its own thread
  // (no touch step). Also PREVAIL_INCOGNITO=1.
  incognito?: boolean;
  // Test seams: stand-ins for engine detection, the model turn and the
  // ~/.prevail message log. Production never sets these.
  deps?: {
    detectClis?: typeof detectClis;
    runChatTurn?: typeof runChatTurn;
    persistMessage?: typeof persistMessage;
    mirrorApps?: (vault: string) => MirrorApp[];
    updateMirrorStatus?: (vault: string, id: string, status: string) => void;
    // The touch classifier. When any deps are given (tests) and this is not,
    // the touch step is off, so a test never reaches a model.
    classifyTouches?: typeof classifyTouches;
    // The chief of staff's dispatch (jobs.ts). Off in tests unless given.
    dispatch?: typeof import("./jobs.ts").dispatch;
    startJob?: (vault: string, id: string) => void;
  };
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
    estimated: true,
  };
}

// "claude:opus-4-8"-style engine label for the start/assistant events.
function engineLabel(cli: AvailableCli, model: string): string {
  const m = model.trim() || defaultModelFor(cli.kind);
  return `${cli.kind}:${m}`;
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

  // One scope resolver for every chat: domain, an app's own space, an entity
  // chat, or a mission (scope.ts). It picks the folder, the thread key and the
  // context blocks; this function only runs the turn.
  const { resolveScope, ScopeError, leadText } = await import("./scope.ts");
  let scope: Awaited<ReturnType<typeof resolveScope>>;
  try {
    scope = await resolveScope(vaultPath, {
      domain: opts.domain, scopeApp: opts.scopeApp, mission: opts.mission, entity: opts.entity, apps: opts.apps,
      refDomains: opts.refDomains, googleAccount: opts.googleAccount, message: userText(message),
      mirrorApps: opts.deps?.mirrorApps ?? mirrorApps,
    });
  } catch (e) {
    if (e instanceof ScopeError) return fail(e.message);
    throw e;
  }
  const domain = scope.domain;
  const scopeApp = scope.kind === "app" ? scope.key.slice(APP_SCOPE_PREFIX.length) : "";
  const appIds = scope.appIds;
  // Everything below persists under the resolved key (`_app-<id>` for an app
  // scope, `_mission-<slug>` for a mission).
  opts = { ...opts, domain: scope.key };

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

  const runTurn = opts.deps?.runChatTurn ?? runChatTurn;
  const persist = opts.deps?.persistMessage ?? persistMessage;
  const available = await (opts.deps?.detectClis ?? detectClis)();
  let cli = pickCli(available, wantedCli, (opts.localOnly ?? false) || scope.privacy.localOnly);
  // Privacy + cost guard for every turn on this path. runChatTurn's guard was
  // opt-in and NO caller passed it, so a domain whose manifest says
  // privacy.localOnly still ran on a cloud CLI, and budget caps never fired.
  // With the guard present, resolveModelForDomain redirects a cloud pick to the
  // local engine for local-only domains (and under Bunker / --local-only).
  const turnGuard = { localOnly: (opts.localOnly ?? process.env.PREVAIL_BUNKER === "1") || scope.privacy.localOnly };
  if (!cli) {
    if (opts.localOnly || scope.privacy.localOnly) return fail(scope.privacy.localOnly ? "this mission is local-only and no local engine is available (ollama not detected)" : "no local engine available (ollama not detected)");
    if (wantedCli) return fail(`engine not available: ${wantedCli}`);
    return fail("no AI CLI detected (claude/codex/antigravity/ollama)");
  }

  // Apps: each connector belongs to one runtime. When this engine lacks a
  // referenced app and one runtime owns them all, run the turn there.
  const apps = scope.apps;
  const appPlan = appIds.length
    ? planAppRouting(appIds, apps, cli.kind, (k) => !turnGuard.localOnly && !opts.localOnly && available.some((c) => c.kind === k))
    : null;
  if (appPlan?.route) {
    cli = available.find((c) => c.kind === appPlan.route!.runtime)!;
    // A model id belongs to the engine it was picked for; the routed engine
    // starts on its own default (Auto still routes within it).
    if ((opts.model ?? "").trim() !== "auto") opts = { ...opts, model: "" };
  }

  // The Compass conversation lives in the chief of staff's chat (General):
  // "set up my Compass" starts or resumes it, and while it is active each
  // message is an answer. Code only, no model: the reply is the next question.
  if (opts.domain === "general" && !scopeApp && !opts.incognito && process.env.PREVAIL_INCOGNITO !== "1") {
    const iv = await import("./interview.ts");
    const said = userText(message).trim();
    const trigger = iv.isInterviewTrigger(said);
    if (trigger || iv.interviewActive(vaultPath)) {
      const r = trigger ? iv.startInterview(vaultPath) : iv.answerInterview(vaultPath, said);
      const ts = Date.now();
      emit({ type: "start", thread, ts, domain: opts.domain, engine: "chief-of-staff" });
      emit({ type: "user", thread, ts, role: "user", text: message });
      writeThreadTurn(vaultPath, opts.domain, sessionId, { id: makeTurnId(), parentId: null, role: "user", cli: cli.kind, model: "", content: message, ts });
      emit({ type: "delta", thread, ts, text: r.reply });
      emit({ type: "assistant", thread, ts, role: "assistant", text: r.reply, engine: "chief-of-staff" });
      writeThreadTurn(vaultPath, opts.domain, sessionId, { id: makeTurnId(), parentId: null, role: "assistant", cli: cli.kind, model: "", content: r.reply, ts });
      emit({ type: "done", thread, ts: Date.now() });
      return 0;
    }
  }

  // A promise told to the chief of staff ("remind me I owe Sam the deck by
  // Friday") is filed at once on this domain's board, with a receipt and Undo;
  // code only, no model call (Today T2).
  if (!scopeApp && scope.kind !== "entity" && scope.kind !== "app" && !opts.incognito && process.env.PREVAIL_INCOGNITO !== "1") {
    const said = userText(message).trim();
    const cm = await import("./commitments.ts");
    const told = cm.toldCommitment(said, Date.now());
    if (told) {
      const home = scope.kind === "mission" ? `_mission-${scope.mission!.slug}` : opts.domain || "general";
      const r = cm.fileCommitment(vaultPath, told, { domain: home, src: `chat:${((opts.threadId ?? "").trim() || sessionId).slice(0, 40)}:${Date.now().toString(36)}` });
      if (r) {
        const who = told.person ? told.person.replace(/^person\//, "").split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : "";
        const reply = told.kind === "waiting"
          ? `Noted: ${who} owes you this${told.due ? `, by ${told.due}` : ""}. It is on the board as a waiting-for; I will bring it up if it slips.`
          : `Noted: a promise to ${who}${told.due ? `, due ${told.due}` : ""}. It is on the board, and Today will show it before it slips.`;
        const ts = Date.now();
        emit({ type: "start", thread, ts, domain: opts.domain, engine: "chief-of-staff" });
        emit({ type: "user", thread, ts, role: "user", text: message });
        writeThreadTurn(vaultPath, opts.domain, sessionId, { id: makeTurnId(), parentId: null, role: "user", cli: cli.kind, model: "", content: message, ts });
        emit({ type: "filed", thread, ts, filed: { id: r.id, kind: r.kind, domain: r.domain, text: r.text, ...(told.due ? { due: told.due } : {}), ...(told.person ? { person: told.person } : {}) } });
        emit({ type: "delta", thread, ts, text: reply });
        emit({ type: "assistant", thread, ts, role: "assistant", text: reply, engine: "chief-of-staff" });
        writeThreadTurn(vaultPath, opts.domain, sessionId, { id: makeTurnId(), parentId: null, role: "assistant", cli: cli.kind, model: "", content: `${reply}\n\n[filed:${r.id}]`, ts });
        emit({ type: "done", thread, ts: Date.now() });
        return 0;
      }
    }
  }

  // The chief of staff: is this message a job rather than a question? An
  // "@Researcher ..." hands it to one specialist by hand; a message shaped like
  // a job (find, compare, plan, draft...) is staffed with a team. The job runs
  // in its own process; this turn answers in one line and emits a `job` card.
  // Never on an app or entity chat, incognito, or a local-only turn (dispatch
  // and specialists run on a cloud model).
  {
    const dispatchFn = opts.deps ? opts.deps.dispatch : (await import("./jobs.ts")).dispatch;
    const said = userText(message);
    const localTurn = !!opts.localOnly || turnGuard.localOnly;
    if (dispatchFn && scope.dispatch.allowed && !opts.incognito && process.env.PREVAIL_INCOGNITO !== "1" && !localTurn) {
      const { readChiefOfStaff } = await import("./chief-of-staff.ts");
      const mode = readChiefOfStaff(vaultPath).handoff;
      if (mode !== "off" || said.trim().startsWith("@")) {
        let d: Awaited<ReturnType<NonNullable<typeof dispatchFn>>> | null = null;
        const ms = scope.mission;
        // A domain the user brought in for this question (--ref-domain) counts as read for this turn.
        const forThisTurn = (opts.refDomains ?? []).filter((x) => x && !ms?.domains.some((y) => y.slug === x)).map((slug) => ({ slug, role: "consulted" as const }));
        const missionScope = ms ? { slug: ms.slug, name: ms.name, domains: [...ms.domains, ...forThisTurn], specialists: ms.specialists, apps: ms.apps, ceiling: ms.ceiling, budgetLeftUsd: scope.dispatch.budgetLeftUsd ?? null } : undefined;
        try { d = await dispatchFn({ vault: vaultPath, message: said, domain: opts.domain, thread: (opts.threadId ?? "").trim() || sessionId, ...(missionScope ? { scope: missionScope } : {}) }); } catch { d = null; }
        // A card the user answers: bring a domain into the mission, or start a
        // mission. Nothing outside the scope is read and nothing starts without a yes.
        if ((d?.kind === "bring-in" && d.bringIn) || (d?.kind === "mission" && d.mission)) {
          const reply = d.kind === "bring-in"
            ? `This needs ${d.bringIn!.domains.join(" and ")}, which ${d.bringIn!.domains.length === 1 ? "is" : "are"} not in the mission${d.bringIn!.never ? " (and on your never-read list)" : ""}. Bring ${d.bringIn!.domains.length === 1 ? "it" : "them"} in for this question, for the mission, or not?`
            : `This sounds like a mission: ${d.mission!.name}. Start it? I drafted the outcome, a target and who to bring in; adjust anything first.`;
          const ts = Date.now();
          emit({ type: "start", thread, ts, domain: opts.domain, engine: "chief-of-staff" });
          emit({ type: "user", thread, ts, role: "user", text: message });
          writeThreadTurn(vaultPath, opts.domain, sessionId, { id: makeTurnId(), parentId: null, role: "user", cli: cli.kind, model: "", content: message, ts });
          if (d.kind === "bring-in") emit({ type: "bring_in", thread, ts, bringIn: { ...d.bringIn!, mission: scope.mission!.slug } });
          else emit({ type: "mission_start", thread, ts, missionDraft: d.mission! });
          emit({ type: "delta", thread, ts, text: reply });
          emit({ type: "assistant", thread, ts, role: "assistant", text: reply, engine: "chief-of-staff" });
          writeThreadTurn(vaultPath, opts.domain, sessionId, { id: makeTurnId(), parentId: null, role: "assistant", cli: cli.kind, model: "", content: reply, ts });
          emit({ type: "done", thread, ts: Date.now() });
          return 0;
        }
        if (d?.kind === "job" && d.job) {
          const jobs = await import("./jobs.ts");
          const job = d.job;
          const start = job.startsAlone && (!!d.mention || mode === "auto");
          jobs.saveJob(vaultPath, job);
          if (start) { try { (opts.deps?.startJob ?? ((v: string, id: string) => { jobs.startJob(v, id); }))(vaultPath, job.id); } catch { /* the card shows it as proposed */ } }
          const names = job.team.flatMap((t) => t.specialists).map((x) => x.charAt(0).toUpperCase() + x.slice(1));
          const reply = start
            ? `On it. ${names.join(", ")} ${names.length === 1 ? "is" : "are"} on it; the result lands in ${job.domains.owner}.`
            : `This looks like a job for ${names.join(", ")}. ${job.askReason ? `I am asking first because ${job.askReason}. ` : ""}Start it, adjust it, or say no.`;
          const ts = Date.now();
          emit({ type: "start", thread, ts, domain: opts.domain, engine: "chief-of-staff" });
          emit({ type: "user", thread, ts, role: "user", text: message });
          writeThreadTurn(vaultPath, opts.domain, sessionId, { id: makeTurnId(), parentId: null, role: "user", cli: cli.kind, model: "", content: message, ts });
          emit({ type: "job", thread, ts, job: { id: job.id, status: start ? "running" : job.status, startsAlone: job.startsAlone, ...(job.askReason ? { askReason: job.askReason } : {}), owner: job.domains.owner, consulted: job.domains.consulted, informed: job.domains.informed, team: job.team, effort: job.effort, budget: job.budget, why: job.why, ...(d.mention ? { mention: d.mention } : {}), ...(job.compass ? { compass: job.compass } : {}) } });
          emit({ type: "delta", thread, ts, text: reply });
          emit({ type: "assistant", thread, ts, role: "assistant", text: reply, engine: "chief-of-staff" });
          writeThreadTurn(vaultPath, opts.domain, sessionId, { id: makeTurnId(), parentId: null, role: "assistant", cli: cli.kind, model: "", content: `${reply}\n\n[job:${job.id}]`, ts });
          emit({ type: "done", thread, ts: Date.now() });
          return 0;
        }
      }
    }
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
  const threadId = (opts.threadId ?? "").trim() || (rawSession || undefined);
  // "claude" names Claude's own one-account connector: no gws pick.
  const googlePick = opts.googleAccount?.trim() && opts.googleAccount.trim().toLowerCase() !== "claude" ? opts.googleAccount.trim() : undefined;
  const entityIds = scope.entityIds;
  // The scope's blocks lead (what the conversation is about, then the apps and
  // domains it names), then any preamble. Rebuilt every turn, never saved.
  const lead = leadText(scope.blocks, opts.preamble);
  const modelPrompt = lead ? `${lead}\n\n---\n\n${message}` : message;

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
  if (appPlan?.route) {
    emit({ type: "routed", thread, ts: startTs, runtime: appPlan.route.runtime, reason: appPlan.route.reason });
  }
  for (const u of appPlan?.unavailable ?? []) {
    emit({ type: "app_unavailable", thread, ts: startTs, app: u.app, runtime_needed: u.runtime_needed });
  }
  for (const n of appPlan?.needsAuth ?? []) {
    emit({ type: "app_needs_auth", thread, ts: startTs, app: n.app, name: n.name, ...(n.signin_url ? { signin_url: n.signin_url } : {}) });
  }
  if (routeInfo) {
    emit({ type: "route", thread, ts: startTs, domain: opts.domain, engine, route: routeInfo });
  }

  // Persist the user turn before the model call so a crash mid-stream still
  // leaves the prompt on disk (JSONL source of truth + rebuildable index).
  writeThreadTurn(vaultPath, opts.domain, sessionId, userTurn);
  persist({
    domain: opts.domain,
    session_id: sessionId,
    role: "user",
    content: message,
    ts: startTs,
    cli: cli.kind,
    model,
  });

  let reply = "";
  // Live step reporting: turn each REAL tool call into a structured `tool` event
  // so the desktop renders a checklist of what the model is doing. Best-effort
  // and display-only - it never affects the reply text or control flow. Shared by
  // app and domain chats (both reach this same turn path). runChatTurn only
  // switches to the structured (stream-json) runner when tools are actually
  // injected, so a tool-less turn streams byte-for-byte as before.
  const stepLabels = new Map<string, string>();
  // Which mirrored app each step's tool belongs to (by MCP server name), with
  // the tool's short name and access class (the access log's classifier).
  const stepApps = new Map<string, { app: string; tool: string; access: "read" | "write" | "blocked" }>();
  const appFields = (name: string | undefined, id: string) => {
    const known = stepApps.get(id);
    if (known) return known;
    const h = appToolAccess(toolApps, name ?? "");
    return h ? { app: h.app.id, tool: h.tool, access: h.access } : null;
  };
  const toolApps = apps.length ? apps : (opts.deps?.mirrorApps ?? mirrorApps)(vaultPath);
  let stepSeq = 0;
  // Tool results on this turn, for the touch step (all failed = no touches).
  let toolResults = 0;
  let toolFailures = 0;
  const onTool = (ev: ToolEvent) => {
    try {
      // The model's own plan: a TodoWrite call carries a todo list we surface as a
      // Plan header, not as a checklist step. Re-emitted on every revision.
      if (ev.phase === "call" && ev.name === "TodoWrite") {
        const todos = (ev.input as { todos?: Array<{ content?: unknown }> } | undefined)?.todos;
        if (Array.isArray(todos)) {
          const plan = todos
            .map((t) => (typeof t?.content === "string" ? t.content.trim() : ""))
            .filter((s) => s.length > 0);
          if (plan.length) emit({ type: "tool", thread, ts: Date.now(), plan });
        }
        return;
      }
      const id = ev.id || `step-${++stepSeq}`;
      if (ev.phase === "call") {
        const label = stepLabel(ev.name, ev.input);
        const detail = stepDetail(ev.name, ev.input);
        stepLabels.set(id, label);
        const app = appFields(ev.name, id);
        if (app) stepApps.set(id, app);
        emit({ type: "tool", thread, ts: Date.now(), text: label, ...(app ?? {}), step: { id, label, status: "running", ...(detail ? { detail } : {}) } });
      } else {
        const label = stepLabels.get(id) ?? stepLabel(ev.name);
        const failed = ev.ok === false;
        toolResults++;
        if (failed) toolFailures++;
        // On failure the detail line becomes WHY it failed (the tool's own error
        // snippet); successful results keep the call-time detail already shown.
        const detail = failed && ev.resultText ? ev.resultText : undefined;
        const app = appFields(ev.name, id);
        emit({
          type: "tool",
          thread,
          ts: Date.now(),
          text: label,
          ...(app ?? {}),
          step: { id, label, status: failed ? "failed" : "done", ...(detail ? { detail } : {}) },
        });
      }
    } catch { /* display only - never let step reporting break a turn */ }
  };
  // The model that actually produced the final reply. Equals `model` on every
  // non-cascade turn (so the assistant/usage/persistence are byte-identical); on
  // a cascade escalation it becomes the escalated target.
  let ranModel = model;
  // What every model call on this turn shares. A turn that references an app
  // also sees the user's own runtime connectors (that is where app tools live),
  // under the act gate like any app chat.
  const turnBase = {
    prompt: modelPrompt,
    threadId,
    entityId: scope.kind === "mission" ? undefined : entityIds[0],
    cwd: domain.path,
    cli,
    guard: turnGuard,
    isFirst: opts.fresh === true || !opts.sessionId, // resume → not first (claude uses --continue)
    webAccess: opts.webAccess,
    incognito: !!opts.incognito,
    googleAccount: googlePick,
    inheritUserMcp: opts.inheritUserMcp || appIds.length > 0,
    // The referenced apps' read tools, pre-allowed (headless Claude refuses
    // anything not allowed up front). Writes still queue at the act gate.
    ...(() => { const r = appReadTools(apps, appIds); return r.length ? { appReadTools: r } : {}; })(),
    // Live connector status from Claude's init event: a referenced app whose
    // server needs sign-in (or did not load) is reported at once, and the
    // mirror learns it so the Apps page shows it too.
    ...(appIds.length ? {
      onInit: (init: { servers: { name: string; status: string }[] }) => {
        const p = initAppProblems(appIds, apps, init);
        for (const n of p.needsAuth) {
          if (!appPlan?.needsAuth.some((x) => x.app === n.app)) {
            emit({ type: "app_needs_auth", thread, ts: Date.now(), app: n.app, name: n.name, ...(n.signin_url ? { signin_url: n.signin_url } : {}) });
          }
          try { (opts.deps?.updateMirrorStatus ?? updateMirrorStatus)(vaultPath, n.app, n.status); } catch { /* display state only */ }
        }
        for (const u of p.unavailable) emit({ type: "app_unavailable", thread, ts: Date.now(), app: u.app, reason: u.reason });
      },
    } : {}),
    // Referenced trusted sources: remote MCP servers and fetchable hosts.
    ...(() => {
      const t = turnSources(apps.filter((a) => appIds.includes(a.id)));
      return { ...(Object.keys(t.remoteMcp).length ? { remoteMcp: t.remoteMcp } : {}), ...(t.fetchHosts.length ? { fetchHosts: t.fetchHosts } : {}) };
    })(),
  };
  try {
    if (cascadePlan) {
      // 1) Cheap pass, BUFFERED (no deltas) so it can be discarded silently if we
      //    escalate - the consumer never sees a throwaway partial answer.
      const cheapReply = await runTurn({ ...turnBase, model: cascadePlan.cheapModel });
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
        reply = await runTurn({
          ...turnBase,
          model: ranModel,
          onTool,
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
      reply = await runTurn({
        ...turnBase,
        model,
        onTool,
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
  persist({
    domain: opts.domain,
    session_id: sessionId,
    role: "assistant",
    content: reply,
    ts: doneTs,
    cli: cli.kind,
    model: ranModel,
  });

  // A message that deliberates ("should I...?") gets a one-tap offer to open
  // a decision record (Today T4); nothing is opened without the user's yes.
  if (!opts.incognito && process.env.PREVAIL_INCOGNITO !== "1" && !scopeApp && scope.kind !== "entity") {
    try {
      const offer = (await import("./decisions-open.ts")).decisionOffer(vaultPath, userText(message), opts.domain);
      if (offer) emit({ type: "decision_offer", thread, ts: Date.now(), decisionOffer: offer });
    } catch { /* never blocks a turn */ }
  }

  // done
  emit({ type: "done", thread, ts: Date.now() });

  // What the user said, noticed by code: Compass candidates in their own
  // words (offered in the weekly review) and numbers they mention (content
  // free events). Never on an incognito turn.
  if (!opts.incognito && process.env.PREVAIL_INCOGNITO !== "1" && !scopeApp) {
    try { (await import("./said.ts")).noteSaid(vaultPath, { text: userText(message), thread: threadId ?? sessionId, domain: opts.domain, ...(scope.mission ? { mission: scope.mission.slug } : {}) }); } catch { /* never blocks a turn */ }
    // In a mission's chat, "paid $120 for the term fee" is a ledger line (MS4).
    if (scope.mission) { try { (await import("./mission-progress.ts")).missionSaid(vaultPath, scope.mission.slug, userText(message), threadId ?? sessionId); } catch { /* never blocks a turn */ } }
  }

  // touched: after the reply is complete, bounded by TOUCH_TIMEOUT_MS.
  const classify = opts.deps?.classifyTouches ?? (opts.deps ? null : classifyTouches);
  if (classify) {
    let manifestLocal = false;
    try { manifestLocal = readManifest(vaultPath, opts.domain)?.privacy.localOnly ?? false; } catch { /* no manifest */ }
    const layer = opts.deps ? null : decisionLayer();
    const touched = await runTouchStep({
      vault: vaultPath, home: opts.domain, thread, message, reply,
      ...(scope.mission ? { prefer: scope.mission.domains.map((x) => x.slug) } : {}),
      toolsAllFailed: toolResults > 0 && toolFailures === toolResults,
      localOnly: !!opts.localOnly || turnGuard.localOnly || manifestLocal || process.env.PREVAIL_BUNKER === "1",
      incognito: !!opts.incognito || process.env.PREVAIL_INCOGNITO === "1",
      classify,
      // The decision layer narrows candidates only when it is live.
      provider: layer?.live ? layer.provider : null,
    });
    if (touched) emit({ type: "touched", thread, ts: Date.now(), domains: touched.domains, entities: touched.entities });
  }
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
  let inheritUserMcp = false;
  let threadId: string | undefined;
  const entity: string[] = [];
  const apps: string[] = [];
  const refDomains: string[] = [];
  let scopeApp: string | undefined;
  let mission: string | undefined;
  let incognito = false;
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
    // --thread: link held approvals to a desktop conversation without changing
    // which engine session the turn resumes or persists to.
    else if (a === "--thread") { threadId = next; i++; }
    else if (a.startsWith("--thread=")) threadId = a.slice("--thread=".length);
    // --entity: scope the conversation to an entity (person/foo); see
    // ChatJsonOptions.entity.
    // Repeatable: one context block each.
    else if (a === "--entity") { entity.push(next ?? ""); i++; }
    else if (a.startsWith("--entity=")) entity.push(a.slice("--entity=".length));
    // --app <id> (repeatable): reference an app; --scope-app <id>: this thread
    // belongs to the app (stored in data/apps/<id>/_scope). --ref-domain <slug>
    // (repeatable): reference another domain's state.
    else if (a === "--app") { apps.push(next ?? ""); i++; }
    else if (a.startsWith("--app=")) apps.push(a.slice("--app=".length));
    else if (a === "--scope-app") { scopeApp = next; i++; }
    else if (a.startsWith("--scope-app=")) scopeApp = a.slice("--scope-app=".length);
    else if (a === "--mission") { mission = next; i++; }
    else if (a.startsWith("--mission=")) mission = a.slice("--mission=".length);
    else if (a === "--ref-domain") { refDomains.push(next ?? ""); i++; }
    else if (a.startsWith("--ref-domain=")) refDomains.push(a.slice("--ref-domain=".length));
    else if (a === "--local-only") localOnly = true;
    else if (a === "--incognito") incognito = true;
    else if (a === "--web") { const v = (next ?? "").toLowerCase(); if (v === "allow" || v === "deny") webAccess = v; i++; }
    else if (a.startsWith("--web=")) { const v = a.slice("--web=".length).toLowerCase(); if (v === "allow" || v === "deny") webAccess = v; }
    else if (a === "--route-bias") { routeBias = next; i++; }
    else if (a.startsWith("--route-bias=")) routeBias = a.slice("--route-bias=".length);
    else if (a === "--route-cascade") routeCascade = true;
    else if (a === "--no-route-cascade") routeCascade = false;
    else if (a.startsWith("--route-cascade=")) { const v = a.slice("--route-cascade=".length).toLowerCase(); routeCascade = v === "1" || v === "true" || v === "on" || v === "yes"; }
    else if (a === "--inherit-user-mcp") inheritUserMcp = true;
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

  // The retired entity kind: `--entity project/<slug>` is the mission's chat now.
  if (!mission) {
    const old = entity.find((e) => /^project\//.test(e));
    if (old && vaultPath) {
      const { missionExists, missionSlugOf } = await import("./missions.ts");
      if (missionExists(vaultPath, old)) {
        mission = missionSlugOf(old);
        entity.splice(entity.indexOf(old), 1);
        process.stderr.write(`prevail chat: --entity ${old} is the mission ${mission} now (use --mission ${mission})\n`);
      }
    }
  }

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
    inheritUserMcp,
    threadId,
    entity,
    apps,
    scopeApp,
    mission,
    refDomains,
    incognito,
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
