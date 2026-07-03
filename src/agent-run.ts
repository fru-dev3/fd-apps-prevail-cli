// agent-run — the `prevail agent-run --domain X --goal "..." --cli <harness> --json`
// handler.
//
// Hands a single task to an agent runtime (typically a harness like Hermes/Pi/
// OpenCode, but any detected CLI works) and emits the same NDJSON ChatEvent
// stream as `chat --json`, so the desktop reuses its existing stream parser
// unchanged. The harness runs its own internal tool/agent loop; this module only
//   1. gates the goal through the autonomy broker (broker.ts),
//   2. frames the goal into an agent prompt,
//   3. runs one turn via runChatTurn (act = the broker's auto decision),
//   4. streams deltas + a final assistant/usage/done, and
//   5. persists a transcript to <vault>/<domain>/_agent_sessions/<id>.jsonl.
//
// The result sink for a task (appending a comment, bumping status) lives on the
// desktop side, which already owns task_detail_add_comment / tasks_set_status.

import { resolve } from "node:path";
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";

import { detectClis, runChatTurn, type CliKind } from "./cli-bridge.ts";
import { generalDir } from "./decisions.ts";
import { scanVault, type Domain } from "./vault.ts";
import { isCliKind } from "./config.ts";
import { makeSessionId } from "./session.ts";
import { gateAction } from "./broker.ts";
import { isDomainLocked } from "./manifest.ts";
import type { ChatEvent } from "./chat-json.ts";

export interface AgentRunOptions {
  vaultPath: string;
  domain: string;
  goal: string;
  // Which runtime executes the task. Absent → first detected CLI.
  cli?: CliKind;
  model?: string;
  // Task this run is acting on (recorded in the transcript; the desktop sinks
  // the result back onto the task).
  taskId?: string;
  // "safe" (default): read-and-propose, harness runs in its safe mode.
  // "auto": full agency — still subject to the broker gate below.
  autonomy?: "safe" | "auto";
  signal?: AbortSignal;
  // Override the NDJSON sink (defaults to stdout). Used by tests.
  write?: (line: string) => void;
}

function findDomain(vaultPath: string, name: string): Domain | null {
  const domains = scanVault(vaultPath);
  return domains.find((d) => d.name === name) ?? null;
}

// Run one agent task and stream ChatEvent NDJSON. Resolves to a process exit
// code (0 ok, non-zero on error) so the index command wrapper can exit with it.
export async function runAgentJson(opts: AgentRunOptions): Promise<number> {
  const write = opts.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const emit = (ev: ChatEvent) => write(JSON.stringify(ev));

  const vaultPath = resolve(opts.vaultPath);
  const sessionId = makeSessionId();
  const thread = sessionId;
  const fail = (error: string): number => {
    emit({ type: "error", thread, ts: Date.now(), error });
    return 1;
  };

  const goal = opts.goal?.trim();
  if (!goal) return fail("empty goal");

  // Domain resolution mirrors chat-json (General is synthesized if unscaffolded).
  let domain = findDomain(vaultPath, opts.domain);
  const wantName = (opts.domain ?? "").trim();
  if (!domain && (wantName === "general" || wantName === "__general__" || wantName === "")) {
    const gdir = generalDir(vaultPath);
    try { mkdirSync(gdir, { recursive: true }); } catch { /* best effort */ }
    domain = { name: "general", path: gdir, hasState: false, openLoopCount: 0, stateMtime: null, skills: [] };
  }
  if (!domain) return fail(`unknown domain: ${opts.domain}`);

  if (opts.cli !== undefined && !isCliKind(opts.cli)) return fail(`unknown cli: ${opts.cli}`);
  const available = await detectClis();
  const cli = opts.cli ? available.find((c) => c.kind === opts.cli) : available[0];
  if (!cli) return fail(opts.cli ? `engine not available: ${opts.cli}` : "no AI runtime detected");

  const autonomy = opts.autonomy === "auto" ? "auto" : "safe";
  const gate = gateAction(goal, { vault: vaultPath, autonomousActs: autonomy === "auto" });
  if (gate.decision === "block") return fail(`blocked by autonomy policy: ${gate.reason ?? gate.cls}`);
  // act drives the harness's full-agency switch; only true when the broker
  // cleared the action AND the user opted into auto. A domain set to read-only
  // (sandbox.mode = "locked") forces act=false so the agent can read but never
  // write files or take shell side-effects there - the real enforcement of the
  // domain's "Read + Write vs read-only" setting.
  const locked = isDomainLocked(vaultPath, opts.domain);
  const act = gate.decision === "auto" && !locked;

  const model = (opts.model ?? "").trim();
  const engine = `${cli.kind}:${model || "default"}`;
  const startTs = Date.now();

  // Per-run ACTION LEDGER. The Prevail MCP tools (acts-mcp: create_skill /
  // create_loop / remember; gws-mcp: google_workspace) append one verified
  // record here for every real action they perform. We read it back after the
  // run to report the GROUND TRUTH of what happened — so a run can never claim
  // an action (a sent email, a saved skill) that no tool actually did. The env
  // var is PREVAIL_-prefixed so it survives cli-bridge's secret-scrub and
  // reaches the tool subprocesses claude spawns.
  const sessionsDir = resolve(domain.path, "_agent_sessions");
  try { mkdirSync(sessionsDir, { recursive: true }); } catch { /* best effort */ }
  const ledgerPath = resolve(sessionsDir, `${sessionId}.actions.jsonl`);
  process.env.PREVAIL_ACTION_LEDGER = ledgerPath;
  process.env.PREVAIL_ACT_DOMAIN = domain.name;

  emit({ type: "start", thread, ts: startTs, domain: opts.domain, engine });
  emit({ type: "user", thread, ts: startTs, role: "user", text: goal });
  if (autonomy === "auto" && gate.decision === "ask") {
    emit({
      type: "tool",
      thread,
      ts: Date.now(),
      role: "system",
      text: `Running in safe mode — consequential actions need approval (${gate.reason ?? gate.cls}).`,
    });
  }

  const actNote = act
    ? "You may use your Prevail tools to take the actions this goal requires."
    : "Propose only: do not perform consequential actions (spending, sending, deleting, external messages) yourself. If the goal needs one, use the Prevail tool that QUEUES it for approval (for example google_workspace queues sends), or describe exactly what you would do and stop.";
  // The agent frame is deliberately MODEL-AGNOSTIC: it names Prevail's own
  // vault-scoped tools and forbids host-native skill/cron/sandbox features, so
  // the same goal executes the same way on Claude, Codex, or Gemini. The
  // HONESTY CONTRACT closes the trust gap — the run may only claim an action a
  // Prevail tool actually performed (verified via the action ledger).
  const prompt = [
    "You are Prevail's agent, completing a single task on the user's behalf inside their private Prevail vault.",
    "",
    `Goal: ${goal}`,
    "",
    `Work in the domain directory: ${domain.path} (domain "${domain.name}").`,
    "",
    "PREVAIL ENVIRONMENT. Use these tools, never your host runtime's native features:",
    "- To save a reusable skill or procedure: call the create_skill tool. It writes a SKILL.md into THIS vault. Never write to a host skill folder (for example ~/.claude/skills) or use a host skill system.",
    "- To set up recurring or scheduled work (daily / weekly / monthly, briefings, 'every Sunday morning'): call the create_loop tool. It creates a durable Prevail loop in this vault. Never use cron, a host scheduler, or any CronCreate-style feature; those do not belong to Prevail and will not persist here.",
    "- To remember a durable fact: call the remember tool (it writes to this domain's memory). Never use a host memory or sandbox store.",
    "- For Google, email, calendar, or drive: call the google_workspace tool. Reads run live. Writes (send, draft, delete) are QUEUED for the user's explicit approval and are NOT performed by you; report them as 'queued for your approval', never as done or sent.",
    "",
    "HONESTY CONTRACT (critical):",
    "- You have NOT performed an action unless a Prevail tool returned success for it in this run. Never say you created a skill, created a loop, saved memory, drafted an email, or sent an email unless the matching tool call actually returned success.",
    "- If a capability is unavailable or a tool fails, say so plainly. Never invent a result, an id, or an outcome like 'it is in your drafts now'.",
    "- After you finish, Prevail shows the user a verified list of exactly which tool actions ran. Your words must match that list.",
    "",
    `Stay strictly within this goal; do not go beyond what was asked. ${actNote}`,
  ].join("\n");

  let reply = "";
  try {
    reply = await runChatTurn({
      prompt,
      cwd: domain.path,
      cli,
      model,
      isFirst: true,
      act,
      // Agent tasks generally need read access to the web; the broker gate is
      // the guard for consequential actions, not web reads.
      webAccess: "allow",
      signal: opts.signal,
      onChunk: (delta: string) => {
        if (!delta) return;
        reply += delta;
        emit({ type: "delta", thread, ts: Date.now(), text: delta });
      },
      maxOutputChars: 60_000,
    });
  } catch (err) {
    return fail((err as Error)?.message ?? "agent run failed");
  }

  // ── Ground truth: read the action ledger the Prevail tools wrote. ──────────
  // An entry exists ONLY if a tool actually performed the action, so this is the
  // authoritative record of what happened — independent of anything the model
  // said in its prose. We surface it two ways: a `tool` event per action (so the
  // desktop renders live action lines) and a footer appended to the reply (the
  // persistent, Prevail-verified summary the user can trust over the prose).
  interface LedgerRec { ts: number; tool: string; ok: boolean; detail: string; ref?: string; queued?: boolean }
  const ledger: LedgerRec[] = [];
  try {
    if (existsSync(ledgerPath)) {
      for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try { ledger.push(JSON.parse(t) as LedgerRec); } catch { /* skip malformed */ }
      }
    }
  } catch { /* ledger read is best-effort */ }

  let footer = "";
  {
    const lines: string[] = [];
    for (const r of ledger) {
      const mark = !r.ok ? "✗" : r.queued ? "⏳" : "✓"; // cross / hourglass / check
      const text = `${mark} ${r.detail}`;
      lines.push(text);
      emit({ type: "tool", thread, ts: r.ts, role: "system", text });
    }
    if (lines.length > 0) {
      footer = `\n\n---\nWhat I actually did (verified by Prevail):\n${lines.join("\n")}`;
    } else if (act) {
      // act was on but no tool ran: state that plainly so a prose-only reply
      // that *sounds* like it acted cannot masquerade as having done so.
      footer = "\n\n---\nWhat I actually did (verified by Prevail): no actions were taken. Nothing was created, sent, queued, or changed.";
    }
  }
  const finalReply = reply + footer;

  const doneTs = Date.now();
  emit({ type: "assistant", thread, ts: doneTs, role: "assistant", text: finalReply, engine });
  emit({
    type: "usage",
    thread,
    ts: doneTs,
    usage: { input_tokens: Math.ceil(goal.length / 4), output_tokens: Math.ceil(finalReply.length / 4) },
  });

  // Audit transcript (best-effort): one line per agent run, alongside the
  // domain's threads so a session can be reviewed later.
  try {
    const dir = resolve(domain.path, "_agent_sessions");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      resolve(dir, `${sessionId}.jsonl`),
      JSON.stringify({
        id: sessionId,
        ts: startTs,
        goal,
        cli: cli.kind,
        model,
        autonomy,
        decision: gate.decision,
        taskId: opts.taskId ?? null,
        result: finalReply,
        // The verified actions this run actually performed (ground truth).
        actions: ledger,
      }) + "\n",
    );
  } catch { /* transcript is best-effort */ }

  emit({ type: "done", thread, ts: Date.now() });
  return 0;
}

// argv handler for `prevail agent-run --domain X --goal "..." --cli <h> [--model m]
// [--task id] [--autonomy safe|auto] [--json]`. Output is always NDJSON ChatEvent
// (the --json flag is accepted for symmetry with `chat` but is the only mode).
export async function agentRunCommand(args: string[], vaultOverride: string | null): Promise<number> {
  let domain = "general";
  let goal = "";
  let cli: CliKind | undefined;
  let model = "";
  let taskId: string | undefined;
  let autonomy: "safe" | "auto" = "safe";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === "--domain") { domain = next ?? domain; i++; }
    else if (a.startsWith("--domain=")) domain = a.slice("--domain=".length);
    else if (a === "--goal" || a === "--message") { goal = next ?? goal; i++; }
    else if (a.startsWith("--goal=")) goal = a.slice("--goal=".length);
    else if (a === "--cli") { cli = (next ?? undefined) as CliKind | undefined; i++; }
    else if (a.startsWith("--cli=")) cli = a.slice("--cli=".length) as CliKind;
    else if (a === "--model") { model = next ?? ""; i++; }
    else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    else if (a === "--task") { taskId = next ?? undefined; i++; }
    else if (a.startsWith("--task=")) taskId = a.slice("--task=".length);
    else if (a === "--autonomy") { autonomy = next === "auto" ? "auto" : "safe"; i++; }
    else if (a.startsWith("--autonomy=")) autonomy = a.slice("--autonomy=".length) === "auto" ? "auto" : "safe";
    // --json is implicit; ignore it and any unknown flags.
  }
  const vaultPath = vaultOverride ?? process.cwd();
  return runAgentJson({ vaultPath, domain, goal, cli, model, taskId, autonomy });
}
