// council-json — the `prevail council run --domain X --json` handler and the
// `prevail council feedback --json` writer.
//
// `council run` is the engine-level twin of the desktop's in-Rust council and
// the TUI's old client-side council.ts: it fans one prompt out to every
// configured panelist in parallel, streams each panelist + the chair's
// synthesis as NDJSON, and persists the verdict to `<domain>/_decisions.jsonl`
// so the council actually learns. Moving the orchestrator HERE means all three
// frontends share one implementation and one quorum/feedback contract.
//
// NDJSON event stream (one JSON object per line, flushed as it happens):
//
//   start    → run began            { type, thread, ts, domain, quorum, localOnly }
//   panel    → panelists resolved    { type, thread, ts, panelists: [{idx,cli,model,lens}] }
//   delta    → panelist token        { type, thread, ts, idx, text }
//   panelist → panelist settled      { type, thread, ts, idx, ok, ms }
//   chair    → synthesis began       { type, thread, ts, chair }
//   verdict-delta → chair token      { type, thread, ts, text }
//   verdict  → final verdict         { type, thread, ts, text, chairLabel, degraded }
//   decision → persisted to log      { type, thread, ts, id }
//   done     → run complete          { type, thread, ts }
//   error    → fatal                 { type, thread, ts, error }

import { resolve } from "node:path";

import { detectClis, type CliKind } from "./cli-bridge.ts";
import {
  isCliKind,
  readCouncilConfig,
  readResponseFramework,
  readResponseLens,
} from "./config.ts";
import { buildCouncilPanel, runCouncilOneShot, type CouncilPanelist } from "./council-runner.ts";
import { appendDecision, makeDecisionId } from "./decisions.ts";
import { buildFrameworkPreamble, getFramework, isFrameworkId, type FrameworkId } from "./framework.ts";
import { isLensId, type LensSelection } from "./lens.ts";
import { scanVault } from "./vault.ts";

export interface CouncilEvent {
  type:
    | "start"
    | "panel"
    | "delta"
    | "panelist"
    | "chair"
    | "verdict-delta"
    | "verdict"
    | "decision"
    | "done"
    | "error";
  thread: string;
  ts: number;
  domain?: string;
  quorum?: number;
  localOnly?: boolean;
  panelists?: { idx: number; cli: string; model: string; lens: string | null }[];
  idx?: number;
  text?: string;
  ok?: boolean;
  ms?: number;
  chair?: string;
  chairLabel?: string;
  degraded?: boolean;
  id?: string;
  error?: string;
}

export interface CouncilJsonOptions {
  vaultPath: string;
  domain: string; // "" / "general" → the domainless General space (vault root cwd)
  message: string;
  quorum?: number;
  lens?: LensSelection; // overrides config when set
  framework?: FrameworkId | null; // overrides config when set
  clis?: CliKind[]; // restrict the panel to these CLI kinds
  localOnly?: boolean;
  write?: (line: string) => void;
}

const LOCAL_KINDS = new Set<string>(["ollama"]);

export async function runCouncilJson(opts: CouncilJsonOptions): Promise<number> {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const thread = makeDecisionId().replace(/^d-/, "c-");
  const emit = (ev: Omit<CouncilEvent, "thread"> & { thread?: string }) =>
    write(JSON.stringify({ thread, ...ev }));
  const fail = (error: string): number => {
    emit({ type: "error", ts: Date.now(), error });
    return 1;
  };

  const vaultPath = resolve(opts.vaultPath);
  const message = opts.message?.trim();
  if (!message) return fail("empty message");

  // Resolve the working directory: a real domain's folder, or the vault root
  // for General. Reusing scanVault keeps domain resolution identical to chat.
  const general = !opts.domain || opts.domain === "general" || opts.domain === "__general__";
  let cwd = vaultPath;
  if (!general) {
    const domain = scanVault(vaultPath).find((d) => d.name === opts.domain);
    if (!domain) return fail(`unknown domain: ${opts.domain}`);
    cwd = domain.path;
  }
  const domainKey = general ? undefined : opts.domain;

  // Build the panel from saved config + detected CLIs. Under Bunker / local-only
  // we hard-filter to local engines so the council can never reach a cloud
  // provider — defense in depth alongside the per-call guard.
  const localOnly = opts.localOnly ?? process.env.PREVAIL_BUNKER === "1";
  const detected = await detectClis();
  let panelists: CouncilPanelist[];
  if (localOnly) {
    // Bunker Mode: build the panel directly from DETECTED local engines,
    // bypassing the council config's CLI allowlist (which may legitimately
    // exclude Ollama for normal cloud councils). We still honor configured
    // per-CLI model variants so a user comparing two local models keeps them.
    const cfg = readCouncilConfig();
    panelists = detected
      .filter((c) => LOCAL_KINDS.has(c.kind))
      .flatMap((cli) => (cfg.models[cli.kind] ?? [""]).map((model) => ({ cli, model })));
  } else {
    panelists = buildCouncilPanel(detected);
  }
  if (opts.clis && opts.clis.length > 0) {
    panelists = panelists.filter((p) => opts.clis!.includes(p.cli.kind as CliKind));
  }
  if (panelists.length === 0) {
    return fail(
      localOnly
        ? "no local engine available for a Bunker-mode council (start Ollama)"
        : "no AI CLI detected for the council (claude/codex/antigravity/ollama)",
    );
  }

  // Resolve lens + framework: explicit option wins, else per-domain config.
  const lens = opts.lens !== undefined ? opts.lens : readResponseLens(domainKey);
  const framework =
    opts.framework !== undefined ? opts.framework : readResponseFramework(domainKey);
  const fwPreamble = buildFrameworkPreamble(getFramework(framework));
  const prompt = fwPreamble ? `${fwPreamble}${message}` : message;

  emit({ type: "start", ts: Date.now(), domain: opts.domain || "general", quorum: opts.quorum, localOnly });

  let result;
  try {
    result = await runCouncilOneShot({
      prompt,
      cwd,
      panelists,
      vaultPath,
      lens,
      quorum: opts.quorum,
      onJobsResolved: (jobs) => emit({ type: "panel", ts: Date.now(), panelists: jobs }),
      onPanelistChunk: (idx, delta) => {
        if (idx === -1) emit({ type: "verdict-delta", ts: Date.now(), text: delta });
        else emit({ type: "delta", ts: Date.now(), idx, text: delta });
      },
      onPanelistDone: (idx, r) => emit({ type: "panelist", ts: Date.now(), idx, ok: r.ok, ms: r.ms }),
      onChairStart: (chairLabel) => emit({ type: "chair", ts: Date.now(), chair: chairLabel }),
    });
  } catch (err) {
    return fail((err as Error)?.message ?? "council run failed");
  }

  emit({
    type: "verdict",
    ts: Date.now(),
    text: result.verdict,
    chairLabel: result.chairLabel,
    degraded: result.degraded,
  });

  // Persist the verdict as a learnable decision. Best-effort: a write failure
  // must not fail the whole run (the verdict already streamed to the caller).
  try {
    const rec = appendDecision(vaultPath, general ? null : opts.domain, {
      type: "council_verdict",
      domain: opts.domain || "general",
      prompt: message,
      verdict: result.verdict,
      chair: result.chairLabel,
      degraded: result.degraded,
      source: "cli",
      panel: result.panel.map((p) => ({
        cli: p.cli.kind,
        model: p.model,
        lens: p.lens?.id ?? null,
        ok: p.ok,
        ms: p.ms,
      })),
    });
    emit({ type: "decision", ts: Date.now(), id: rec.id });
  } catch {
    /* decision log unwritable — surfaced verdict is still valid */
  }

  emit({ type: "done", ts: Date.now() });
  return 0;
}

// ── argv handlers ────────────────────────────────────────────────────────────

// `prevail council run --domain X --json` (and `prevail council feedback …`).
// Returns the process exit code. Dispatched from index.tsx.
export async function councilCommand(
  args: string[],
  vaultOverride: string | null,
): Promise<number> {
  const sub = args[0];
  if (sub === "feedback") return councilFeedbackCommand(args.slice(1), vaultOverride);
  if (sub === "run") return councilRunCommand(args.slice(1), vaultOverride);
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: `unknown council subcommand: ${sub ?? "(none)"}`, code: "BAD_SUBCOMMAND" })}\n`,
  );
  return 1;
}

async function councilRunCommand(args: string[], vaultOverride: string | null): Promise<number> {
  let domain = "";
  let message: string | undefined;
  let quorum: number | undefined;
  let lens: LensSelection | undefined;
  let framework: FrameworkId | null | undefined;
  let clis: CliKind[] | undefined;
  let localOnly = false;
  let vaultPath = vaultOverride ?? "";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    const val = (inline: string): string => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : (i++, next ?? inline));
    if (a === "--domain" || a.startsWith("--domain=")) domain = val("");
    else if (a === "--message" || a.startsWith("--message=")) message = val("");
    else if (a === "--quorum" || a.startsWith("--quorum=")) quorum = Number.parseInt(val("0"), 10) || undefined;
    else if (a === "--lens" || a.startsWith("--lens=")) {
      const v = val("");
      lens = v === "all" ? "all" : v === "off" || v === "" ? null : isLensId(v) ? v : undefined;
    } else if (a === "--framework" || a.startsWith("--framework=")) {
      const v = val("");
      framework = v === "off" || v === "" ? null : isFrameworkId(v) ? v : undefined;
    } else if (a === "--cli" || a.startsWith("--cli=")) {
      clis = val("")
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is CliKind => isCliKind(s));
    } else if (a === "--local-only") localOnly = true;
    else if (a === "--vault" || a.startsWith("--vault=")) vaultPath = resolve(process.cwd(), val(""));
    // --json is implied by this command path; tolerate it.
  }

  if (message === undefined) message = await readStdin();
  if (process.env.PREVAIL_BUNKER === "1") localOnly = true;

  return runCouncilJson({
    vaultPath,
    domain,
    message: message ?? "",
    quorum,
    lens,
    framework,
    clis,
    localOnly,
  });
}

async function councilFeedbackCommand(args: string[], vaultOverride: string | null): Promise<number> {
  const { setDecisionFeedback } = await import("./decisions.ts");
  let domain = "";
  let id = "";
  let rating = "";
  let note: string | undefined;
  let vaultPath = vaultOverride ?? "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    const val = (): string => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : (i++, next ?? ""));
    if (a === "--domain" || a.startsWith("--domain=")) domain = val();
    else if (a === "--id" || a.startsWith("--id=")) id = val();
    else if (a === "--rating" || a.startsWith("--rating=")) rating = val();
    else if (a === "--note" || a.startsWith("--note=")) note = val();
    else if (a === "--vault" || a.startsWith("--vault=")) vaultPath = resolve(process.cwd(), val());
  }
  const emitErr = (msg: string, code: string): number => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: msg, code })}\n`);
    return 1;
  };
  if (!id) return emitErr("missing required flag: --id", "MISSING_ARG");
  if (rating !== "up" && rating !== "down" && rating !== "clear")
    return emitErr("--rating must be up|down|clear", "BAD_ARG");
  const general = !domain || domain === "general" || domain === "__general__";
  const ok = setDecisionFeedback(resolve(vaultPath), general ? null : domain, id, rating, note);
  if (!ok) return emitErr(`decision not found: ${id}`, "NOT_FOUND");
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  return 0;
}

async function readStdin(): Promise<string> {
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
    return Buffer.concat(chunks).toString("utf8").trim();
  } catch {
    return "";
  }
}
