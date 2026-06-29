// orchestrator.ts — the cross-app/cross-domain autonomous engine.
//
// A PLAYBOOK is an ordered list of steps that, together, do a whole job a single
// app/skill can't: "build my net worth" = pull Plaid + Coinbase + PayPal, scan
// Gmail for debt, then synthesize a summary doc. `runPlaybook` is the ONE
// chokepoint through which all of that flows, so the safety spine applies
// uniformly to every step:
//   gate (broker: pause + policy + autonomy) → execute → audit + activity → abortable.
//
// Step kinds:
//   - skill      : run any connected app's skill via the existing runSkill (this
//                  is the one place cross-app reads happen — a later synthesize
//                  step can read every prior step's outputs).
//   - agent      : a Claude-CLI turn with act:true (file/shell/web computer-use),
//                  gated by the action class of its goal.
//   - synthesize : an agent turn that reads the run's collected data and WRITES a
//                  summary doc into a domain.
//
// Outputs of every step are collected under <vault>/_runs/<runId>/ so later steps
// (and the user) can see exactly what was produced.

import { join, resolve, isAbsolute, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { vwriteFile } from "./vault-session.ts";
import { runChatTurn, detectClis, type AvailableCli } from "./cli-bridge.ts";
import { scanCommunityApps } from "./vault.ts";
import { loadSkillsForConnector, runSkill } from "./connector-skills.ts";
import { gateAction, type GateDecision } from "./broker.ts";
import { isPaused } from "./autonomy.ts";
import { auditAction, type ActionOutcome } from "./action-audit.ts";
import { logActivity } from "./activity.ts";
import { resolveDomainDir } from "./path-safety.ts";

export type PlaybookStep =
  | { kind: "skill"; app: string; skill: string; inputs?: Record<string, unknown>; label?: string }
  | { kind: "agent"; goal: string; domain?: string; web?: boolean; label?: string }
  | { kind: "synthesize"; domain: string; output: string; instruction: string; label?: string };

export interface Playbook {
  id: string;
  name: string;
  goal: string;
  domain?: string;     // home domain (where the result usually lands)
  steps: PlaybookStep[];
}

export interface StepResult {
  index: number;
  kind: PlaybookStep["kind"];
  label: string;
  decision: GateDecision;
  ok: boolean;
  note: string;
  outputs: string[];   // absolute paths produced
}

export interface PlaybookRunResult {
  runId: string;
  playbook: string;
  ok: boolean;
  note: string;
  steps: StepResult[];
  runDir: string;
}

export interface OrchestratorCtx {
  vault: string;
  provider: string;          // cli kind, e.g. "claude"
  model: string;             // "" = provider default
  autonomousActs: boolean;   // global opt-in (a step gated "auto" only runs when true)
  signal?: AbortSignal;
  onProgress?: (event: Record<string, unknown>) => void;
}

const STEP_TIMEOUT_MS = 10 * 60_000;

function emit(ctx: OrchestratorCtx, event: Record<string, unknown>): void {
  try { ctx.onProgress?.(event); } catch { /* never let a progress sink break a run */ }
}

function stepLabel(step: PlaybookStep, i: number): string {
  if (step.label) return step.label;
  if (step.kind === "skill") return `${step.app}:${step.skill}`;
  if (step.kind === "agent") return `agent: ${step.goal.slice(0, 48)}`;
  return `synthesize → ${step.domain}/${step.output}`;
}

export async function runPlaybook(
  runId: string,
  playbook: Playbook,
  ctx: OrchestratorCtx,
): Promise<PlaybookRunResult> {
  const runDir = join(ctx.vault, "_runs", runId);
  mkdirSync(runDir, { recursive: true });
  const steps: StepResult[] = [];
  const collected: string[] = []; // all output paths so far, for synthesize steps

  emit(ctx, { phase: "started", runId, playbook: playbook.id, steps: playbook.steps.length });
  logActivity(ctx.vault, { type: "playbook", domain: playbook.domain, title: `Playbook: ${playbook.name}`, detail: playbook.goal, status: "pending", ref: runId });

  // Global brake: refuse to even start when paused.
  if (isPaused(ctx.vault)) {
    const note = "autonomy is globally paused — playbook not started";
    emit(ctx, { phase: "blocked", reason: note });
    logActivity(ctx.vault, { type: "playbook", domain: playbook.domain, title: `Playbook blocked: ${playbook.name}`, detail: note, status: "error", ref: runId });
    return { runId, playbook: playbook.id, ok: false, note, steps, runDir };
  }

  const clis = await detectClis();
  const cli: AvailableCli | undefined = clis.find((c) => c.kind === ctx.provider) ?? clis[0];

  for (let i = 0; i < playbook.steps.length; i++) {
    if (ctx.signal?.aborted) {
      emit(ctx, { phase: "aborted", index: i });
      break;
    }
    const step = playbook.steps[i];
    const label = stepLabel(step, i);
    emit(ctx, { phase: "step", index: i, kind: step.kind, label });

    const res: StepResult = { index: i, kind: step.kind, label, decision: "auto", ok: false, note: "", outputs: [] };
    try {
      if (step.kind === "skill") {
        await runSkillStep(step, ctx, res);
        collected.push(...res.outputs);
      } else if (step.kind === "agent") {
        await runAgentStep(step, ctx, cli, runDir, collected, res);
      } else {
        await runSynthesizeStep(step, ctx, cli, collected, res);
        collected.push(...res.outputs);
      }
    } catch (e) {
      res.ok = false;
      res.note = `error: ${e instanceof Error ? e.message : String(e)}`;
    }

    // Audit + activity for every step, whatever the outcome.
    const outcome: ActionOutcome = res.decision === "auto" ? (res.ok ? "executed" : "error") : "proposed";
    auditAction(ctx.vault, { ts: Date.now(), domain: step.kind === "agent" || step.kind === "synthesize" ? (step as { domain?: string }).domain ?? playbook.domain ?? "" : playbook.domain ?? "", action: `${label} — ${res.note}`.slice(0, 280), outcome, provider: ctx.provider, model: ctx.model || undefined });
    logActivity(ctx.vault, { type: "playbook_step", domain: playbook.domain, title: label, detail: res.note, status: res.ok ? "ok" : res.decision === "auto" ? "error" : "pending", ref: runId });
    emit(ctx, { phase: "step_done", index: i, ok: res.ok, decision: res.decision, note: res.note, outputs: res.outputs });
    steps.push(res);
  }

  const ranOk = steps.filter((s) => s.ok).length;
  const ok = steps.length > 0 && steps.every((s) => s.ok || s.decision !== "auto");
  const note = `${ranOk}/${steps.length} steps completed`;
  // Write a run manifest so the result is fully inspectable.
  try { vwriteFile(join(runDir, "run.json"), `${JSON.stringify({ runId, playbook: playbook.id, goal: playbook.goal, ok, note, steps }, null, 2)}\n`); } catch { /* best effort */ }
  logActivity(ctx.vault, { type: "playbook", domain: playbook.domain, title: `Playbook done: ${playbook.name}`, detail: note, status: ok ? "ok" : "error", ref: runId });
  emit(ctx, { phase: "complete", runId, ok, note });
  return { runId, playbook: playbook.id, ok, note, steps, runDir };
}

// A skill step runs an existing connector skill. Skills carry their own autonomy
// gate (read-only by default), so they're safe; we still classify the intent for
// the audit trail and honor a global pause.
async function runSkillStep(step: Extract<PlaybookStep, { kind: "skill" }>, ctx: OrchestratorCtx, res: StepResult): Promise<void> {
  const gate = gateAction(`fetch data from ${step.app} (${step.skill})`, { vault: ctx.vault, autonomousActs: ctx.autonomousActs });
  res.decision = gate.decision;
  if (gate.decision === "block") { res.note = gate.reason ?? "blocked"; return; }
  const apps = scanCommunityApps(ctx.vault);
  const app = apps.find((a) => a.id === step.app);
  if (!app) { res.note = `no connected app "${step.app}"`; return; }
  const spec = loadSkillsForConnector(app).find((s) => s.id === step.skill);
  if (!spec) { res.note = `app "${step.app}" has no skill "${step.skill}"`; return; }
  if (gate.decision === "ask") { res.note = `needs approval (${gate.reason}); skipped this run`; return; }
  const r = await runSkill(spec, step.inputs ?? {}, { signal: ctx.signal, autonomy: app.autonomy ?? "read-only" });
  res.ok = r.ok;
  res.note = r.ok ? (r.summary ?? r.message ?? "ok") : (r.message || "skill failed");
  // Record produced files (absolute) so a synthesize step can read them.
  for (const rel of r.outputsWritten ?? []) {
    res.outputs.push(isAbsolute(rel) ? rel : resolve(app.path, rel));
  }
}

// An agent step is a Claude-CLI turn with act:true — full file/shell/web tooling.
// Gated by the classified intent of its goal.
async function runAgentStep(step: Extract<PlaybookStep, { kind: "agent" }>, ctx: OrchestratorCtx, cli: AvailableCli | undefined, runDir: string, collected: string[], res: StepResult): Promise<void> {
  const gate = gateAction(step.goal, { vault: ctx.vault, autonomousActs: ctx.autonomousActs });
  res.decision = gate.decision;
  if (gate.decision !== "auto") { res.note = gate.reason ?? gate.decision; return; }
  if (!cli) { res.note = "no AI CLI available"; return; }
  const cwd = step.domain ? safeDomainDir(ctx.vault, step.domain) : runDir;
  const context = collected.length ? `\n\nData gathered so far in this run (read these as needed):\n${collected.map((p) => `- ${p}`).join("\n")}` : "";
  const prompt = `You are executing one step of an autonomous playbook on the user's behalf.\n\nGoal: ${step.goal}${context}\n\nWork in: ${cwd}. Use your tools. Stay strictly within this goal — do not take consequential actions (money, sends, deletes) and do not go beyond what was asked.`;
  const out = await runChatTurn({ prompt, cwd, cli, model: ctx.model || "", isFirst: true, bare: false, act: true, webAccess: step.web ? "allow" : "deny", signal: ctx.signal ?? AbortSignal.timeout(STEP_TIMEOUT_MS), maxOutputChars: 8000 });
  res.ok = true;
  res.note = (out || "").trim().slice(0, 400) || "done";
}

// A synthesize step reads everything gathered and writes a summary doc into a
// domain. Writing a doc is a reversible action; still gated for consistency.
async function runSynthesizeStep(step: Extract<PlaybookStep, { kind: "synthesize" }>, ctx: OrchestratorCtx, cli: AvailableCli | undefined, collected: string[], res: StepResult): Promise<void> {
  const gate = gateAction(`write summary document ${step.output}`, { vault: ctx.vault, autonomousActs: ctx.autonomousActs });
  res.decision = gate.decision;
  if (gate.decision !== "auto") { res.note = gate.reason ?? gate.decision; return; }
  if (!cli) { res.note = "no AI CLI available"; return; }
  const domainDir = safeDomainDir(ctx.vault, step.domain);
  const outAbs = resolve(domainDir, step.output.replace(/^\/+/, ""));
  if (!outAbs.startsWith(domainDir)) { res.note = "refusing to write outside the domain"; return; }
  const sources = collected.length ? collected.map((p) => `- ${p}`).join("\n") : "(no prior data — note what's missing)";
  const prompt = `You are the synthesis step of an autonomous playbook. Read the data files below and write a single clear markdown summary to: ${outAbs}\n\nData files:\n${sources}\n\nInstruction: ${step.instruction}\n\nWrite the file with your file tool. Be concise and concrete; cite the numbers. Do not take any other action.`;
  await runChatTurn({ prompt, cwd: domainDir, cli, model: ctx.model || "", isFirst: true, bare: false, act: true, webAccess: "deny", signal: ctx.signal ?? AbortSignal.timeout(STEP_TIMEOUT_MS), maxOutputChars: 4000 });
  if (existsSync(outAbs)) { res.ok = true; res.outputs.push(outAbs); res.note = `wrote ${step.output}`; }
  else { res.note = "synthesis produced no file"; }
}

function safeDomainDir(vault: string, domain: string): string {
  const d = resolveDomainDir(vault, domain);
  return d ?? join(vault, domain);
}

// Bundled playbooks ship beside the binary (like skill-packs); a user can
// override or add their own under <vault>/_playbooks/<id>.json.
function playbooksDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.PREVAIL_PLAYBOOKS_DIR) dirs.push(process.env.PREVAIL_PLAYBOOKS_DIR);
  try { const e = dirname(process.execPath); dirs.push(join(e, "playbooks"), resolve(e, "..", "playbooks")); } catch {}
  if (process.argv[1]) { try { const a = dirname(process.argv[1]); dirs.push(join(a, "playbooks"), resolve(a, "..", "playbooks")); } catch {} }
  try { const here = dirname(fileURLToPath(import.meta.url)); dirs.push(resolve(here, "..", "playbooks")); } catch {}
  return dirs;
}

function parsePlaybook(path: string): Playbook | null {
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as Playbook;
    if (p && typeof p.id === "string" && Array.isArray(p.steps)) return p;
  } catch { /* malformed */ }
  return null;
}

export function loadPlaybook(vault: string, id: string): Playbook | null {
  const userP = join(vault, "_playbooks", `${id}.json`);
  if (existsSync(userP)) { const p = parsePlaybook(userP); if (p) return p; }
  for (const d of playbooksDirs()) {
    const p = join(d, `${id}.json`);
    if (existsSync(p)) { const pb = parsePlaybook(p); if (pb) return pb; }
  }
  return null;
}

export function listPlaybooks(vault: string): { id: string; name: string; goal: string }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string; goal: string }[] = [];
  const dirs = [join(vault, "_playbooks"), ...playbooksDirs()];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      const pb = parsePlaybook(join(d, f));
      if (pb && !seen.has(pb.id)) { seen.add(pb.id); out.push({ id: pb.id, name: pb.name, goal: pb.goal }); }
    }
  }
  return out;
}

