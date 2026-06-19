// Loop runner daemon — the autonomous half of Domain Loops.
//
// Loop *definitions* live in <vault>/<domain>/_loops.json (authored in the
// desktop UI). This daemon is the steward that keeps them moving: on each loop's
// cadence it observes the domain's signals (state + memory), measures the gap to
// the desired state, and rewrites the loop's "actions" with the current
// highest-leverage next steps. Closed loops are marked done once their condition
// is met. Tasks are never first-class here — they are simply a loop's output.
//
// Mirrors daemon-learn.ts: same config/lifecycle shape, same model bridge
// (runChatTurn), same encryption-aware vault I/O (vread/vwrite). Idempotent and
// best-effort: a failing loop records its error and never blocks the others.
import { existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { runtimePath } from "./path-safety.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { runChatTurn, detectClis } from "./cli-bridge.ts";
import { scanVault } from "./vault.ts";
import { readTasks, setTaskStatus, effectiveStatus, type Task } from "./tasks.ts";
import { logActivity } from "./activity.ts";
import { deliverBriefing, type BriefingEntry } from "./briefings.ts";
import { generalDir } from "./decisions.ts";

export interface LoopsConfig {
  vaultPath: string;
  intervalSec: number; // how often the daemon wakes to check for due loops
  provider: string;    // which CLI runs the evaluation
  model: string;       // optional model id ("" = provider default)
  // Optional delivery hooks for briefing loops, wired by the caller (index.tsx)
  // to the live connectors. Absent → a briefing falls back to log-only.
  deliverEmail?: (subject: string, body: string) => Promise<string>;
  deliverTelegram?: (text: string) => Promise<number>;
}

export const DEFAULT_LOOPS: Omit<LoopsConfig, "vaultPath"> = {
  intervalSec: 3600, // hourly wake; each loop only runs on its own cadence
  provider: "claude",
  model: "",
};

type LoopType = "open" | "closed";
type LoopCadence = "continuous" | "daily" | "weekly" | "monthly";
type LoopStatus = "active" | "paused" | "done";

interface Loop {
  id: string;
  name: string;
  purpose: string;
  type: LoopType;
  signals: string[];
  condition: string;
  cadence: LoopCadence;
  autonomy?: "suggest" | "tasks" | "ask" | "auto"; // guardrail: how much it may do on its own
  evaluation: string;
  actions: string[];
  status: LoopStatus;
  enabled: boolean;
  lastRunTs: number | null;
  createdTs: number;
  model?: string; // per-loop model override ("" / undefined = use the global loops model)
  kind?: "steward" | "briefing"; // briefing = synthesize + deliver a domain digest; default steward
  channel?: "gmail" | "telegram" | "log"; // briefing delivery target (default gmail)
}

interface LoopsDoc {
  schema: 1;
  desiredState: string;
  loops: Loop[];
}

const CADENCE_MS: Record<LoopCadence, number> = {
  continuous: 0,
  daily: 86_400_000,
  weekly: 7 * 86_400_000,
  monthly: 30 * 86_400_000,
};

// A loop is due when it's enabled, active, and its cadence interval has elapsed
// since the last run (continuous loops are always due).
function isDue(loop: Loop, now: number): boolean {
  if (!loop.enabled || loop.status !== "active") return false;
  if (!loop.lastRunTs) return true;
  return now - loop.lastRunTs >= CADENCE_MS[loop.cadence];
}

function loopsFile(domainDir: string): string {
  return join(domainDir, "_loops.json");
}

function readDoc(domainDir: string): LoopsDoc | null {
  try {
    const raw = vreadFile(loopsFile(domainDir));
    if (!raw.trim()) return null;
    const doc = JSON.parse(raw) as LoopsDoc;
    if (!Array.isArray(doc.loops)) return null;
    return doc;
  } catch {
    return null;
  }
}

function safeRead(path: string): string {
  try { return existsSync(path) ? vreadFile(path) : ""; } catch { return ""; }
}

// ── Self-driving loop state ──────────────────────────────────────────────────
// A loop is not a stateless re-suggester: it remembers what it tried, learns
// whether the gap is closing, persists pending decisions that need the user, and
// turns concrete steps into real tracked tasks. Runtime state lives in its OWN
// file (_loops_runtime.json) so the desktop loop editor — which rewrites the
// whole _loops.json with a fixed schema — can never strip it.
const MAX_HISTORY = 6;

interface LoopAction { text: string; task: boolean; needsApproval: boolean; due?: string; priority?: string }
interface LoopRun { ts: number; actions: string[]; note: string; done: boolean; tasksCreated: string[] }
interface LoopRtEntry { history: LoopRun[]; pending: { text: string; ts: number }[] }
interface LoopRuntime { schema: 1; loops: Record<string, LoopRtEntry> }

function runtimeFile(domainDir: string): string { return join(domainDir, "_loops_runtime.json"); }
function readRuntime(domainDir: string): LoopRuntime {
  try {
    const raw = safeRead(runtimeFile(domainDir));
    if (raw.trim()) {
      const d = JSON.parse(raw) as LoopRuntime;
      if (d && typeof d === "object" && d.loops) return d;
    }
  } catch { /* fall through */ }
  return { schema: 1, loops: {} };
}
function writeRuntime(domainDir: string, rt: LoopRuntime): void {
  try { vwriteFile(runtimeFile(domainDir), JSON.stringify(rt, null, 2)); } catch { /* best effort */ }
}

function todayYmd(): string { return new Date().toISOString().slice(0, 10); }

// Turn a concrete loop step into a real, tracked task in the domain's _tasks.md
// (the same ledger the desktop reads/writes). Deduped by text. Returns whether a
// new task was actually created. This is how a loop "works on the goal" — it
// files trackable work the rest of the system (and the user) acts on.
export function appendTask(domainDir: string, text: string, opts?: { due?: string; priority?: string }): boolean {
  const clean = text.trim();
  if (!clean) return false;
  const f = join(domainDir, "_tasks.md");
  const cur = safeRead(f) || "# Tasks\n\n";
  const already = cur.split("\n").some((l) => {
    const m = /^- \[[ xX]\]\s+(.+?)(?:\s+[@+~][^\s]*)*\s*$/.exec(l.trim());
    return !!m && m[1].trim().toLowerCase() === clean.toLowerCase();
  });
  if (already) return false;
  const body = cur.endsWith("\n") ? cur : `${cur}\n`;
  // Optional due date (@) and priority let the steward file time-sensitive
  // obligations (e.g. annual physical) that land in the right horizon bucket and
  // trigger the Due alert. Validate to keep the line well-formed.
  const due = opts?.due && /^\d{4}-\d{2}-\d{2}$/.test(opts.due) ? ` @${opts.due}` : "";
  const prio = opts?.priority && ["high", "critical"].includes(opts.priority) ? ` ~priority:${opts.priority}` : "";
  vwriteFile(f, `${body}- [ ] ${clean}${due} +${todayYmd()} ~loop${prio}\n`);
  return true;
}

// The high-level intents the user is actually pursuing — curated by the intent
// distiller into <vault>/_meta/intents_distilled.json from their activity across
// sessions and domains — filtered to those that touch THIS domain. Feeding these
// into the loop is what makes loops COMPOUND on the user's real goals over time,
// not just react to the domain's own state. (Cross-component: written by the
// desktop intent daemon, read here by the loop runner.)
export function readDomainIntents(vaultRoot: string, domainName: string): string {
  try {
    const raw = safeRead(join(runtimePath(vaultRoot, "_meta"), "intents_distilled.json"));
    if (!raw.trim()) return "";
    const doc = JSON.parse(raw) as { intents?: Array<{ title?: string; goal?: string; domains?: string[]; status?: string; recommendations?: string[] }> };
    const dn = domainName.toLowerCase();
    const relevant = (doc.intents ?? []).filter((it) =>
      it.status !== "resolved" &&
      (!it.domains?.length || it.domains.some((d) => String(d).toLowerCase() === dn)));
    if (relevant.length === 0) return "";
    return relevant.slice(0, 6).map((it) => {
      const recs = (it.recommendations ?? []).slice(0, 2).join("; ");
      return `- ${it.title || "intent"}: ${it.goal || ""}${recs ? ` (suggested: ${recs})` : ""}`;
    }).join("\n");
  } catch { return ""; }
}

function renderHistory(entry: LoopRtEntry | undefined): string {
  if (!entry || entry.history.length === 0) return "(no prior runs — this is the first)";
  return entry.history
    .map((r, i) => {
      const when = new Date(r.ts).toISOString().slice(0, 16).replace("T", " ");
      const acts = r.actions.length ? r.actions.join(" | ") : "(none)";
      const made = r.tasksCreated.length ? ` [filed tasks: ${r.tasksCreated.length}]` : "";
      return `${i + 1}. ${when} — ${r.note || "(no note)"}${made}\n   tried: ${acts}`;
    })
    .join("\n");
}

// Ask the model for this loop's current next actions and (for closed loops)
// whether its condition is now satisfied. Strict JSON so parsing is reliable.
// Translate the loop's guardrail into an instruction the steward must honor when
// deciding the `task` / `needs_approval` flags on each action.
function guardrailRule(a: "suggest" | "tasks" | "ask" | "auto"): string {
  switch (a) {
    case "suggest": return "SUGGEST ONLY. Propose next steps but set every action's \"task\" to false and \"needs_approval\" to false; do not file or act.";
    case "tasks": return "May FILE tasks (set \"task\": true) but never act externally; set \"needs_approval\": false for everything (no external actions proposed).";
    case "auto": return "May act within guardrails; still set \"needs_approval\": true for anything that spends money, contacts someone, or is irreversible.";
    case "ask":
    default: return "May propose actions; anything consequential (spend/contact/irreversible/decision) must set \"needs_approval\": true and waits for the user.";
  }
}

function buildPrompt(doc: LoopsDoc, loop: Loop, domainLabel: string, state: string, memory: string, entry: LoopRtEntry | undefined, intents: string): string {
  return [
    `You are the steward of the "${loop.name}" loop in the ${domainLabel} domain of a personal life-OS.`,
    `A loop is a persistent, self-driving control loop: it continuously reduces the gap between the current state and the desired state, learning and escalating over time. Your job each run: decide the smallest set of highest-leverage next actions (1-3) that move this loop forward RIGHT NOW, building on everything already tried.`,
    "",
    `DESIRED STATE (domain):\n${doc.desiredState || "(not set)"}`,
    "",
    `LOOP`,
    `- purpose / goal: ${loop.purpose || loop.name}`,
    `- type: ${loop.type}${loop.type === "closed" ? ` (closed: finishes when the condition is met)` : " (open: ongoing)"}`,
    `- guardrail: ${loop.autonomy ?? "ask"} — ${guardrailRule(loop.autonomy ?? "ask")}`,
    `- signals to weigh: ${loop.signals.join(", ") || "(none listed)"}`,
    `- condition: ${loop.condition || "(none)"}`,
    `- what good looks like: ${loop.evaluation || "(not specified)"}`,
    "",
    `CURRENT STATE (from the domain's _state.md):\n${state.slice(0, 4000) || "(none yet)"}`,
    "",
    `LONG-TERM MEMORY (excerpt):\n${memory.slice(0, 2000) || "(none yet)"}`,
    "",
    intents
      ? `WHAT THE USER IS ACTUALLY TRYING TO DO (high-level intents distilled from their activity across sessions; this loop should ACTIVELY ADVANCE the ones it can):\n${intents}\n`
      : "",
    `RUN HISTORY (most recent first) — what this loop already tried:`,
    renderHistory(entry),
    "",
    `Think like an operator who PERSISTS: do not repeat actions already tried unless they're genuinely the next step; judge from the state + history whether the gap is closing; if it's stalled, change approach and escalate. Each run should build on the last and get better.`,
    "",
    `RECURRING OBLIGATIONS: this domain has cyclical things that must happen on a cadence (for example: an annual health physical or screening; quarterly estimated taxes; an annual insurance or policy review; a yearly financial/tax filing). From the desired state, memory, and what's been done, infer the obligations that apply to THIS domain. If one appears DUE or OVERDUE for its current period and is not already a tracked task, propose it as a task with a "due" date and a "priority" ("high", or "critical" if overdue / legally or health time-sensitive). Today is ${todayYmd()}.`,
    "",
    `Respond with ONLY a JSON object on a single line. Each action is an object:`,
    `{"actions":[{"text":"the next step","task":true,"needs_approval":false,"due":"YYYY-MM-DD","priority":"high"}],"done":false,"note":"one-line read on progress + why these steps"}`,
    `- "task": true if this is a concrete, trackable step — it will be FILED as a real task in this domain and worked on. false for pure observations/notes.`,
    `- "needs_approval": true if it spends money, contacts someone, is irreversible, or needs a decision/info only the user can give. Those are PROPOSED and wait for the user instead of being done automatically. Be conservative: when unsure, set true.`,
    `- "due": OPTIONAL YYYY-MM-DD deadline. Set it for anything time-sensitive (especially recurring obligations) so it surfaces on the right horizon and alerts. Omit if there's no real deadline.`,
    `- "priority": OPTIONAL "high" or "critical". Use for important or time-critical work; omit for normal. Overdue obligations are "critical".`,
    `- Write task text in plain punctuation. NEVER use em dashes ("—"); use a hyphen "-", a colon, or two short phrases instead.`,
    loop.type === "closed"
      ? `Set "done" to true only if the loop's condition is clearly satisfied by the current state.`
      : `"done" must be false for open loops.`,
  ].join("\n");
}

// Pull the first JSON object out of model output (tolerates code fences / prose).
// Accepts actions as rich objects {text,task,needs_approval} OR plain strings
// (back-compat — a plain string defaults to a trackable, auto-approved task).
export function parseResult(out: string): { actions: LoopAction[]; done: boolean; note: string } | null {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(out.slice(start, end + 1)) as { actions?: unknown; done?: unknown; note?: unknown };
    const raw = Array.isArray(obj.actions) ? obj.actions : [];
    const actions: LoopAction[] = raw
      .map((a): LoopAction | null => {
        if (typeof a === "string") {
          return a.trim() ? { text: a.trim(), task: true, needsApproval: false } : null;
        }
        if (a && typeof a === "object") {
          const o = a as { text?: unknown; task?: unknown; needs_approval?: unknown; due?: unknown; priority?: unknown };
          const text = typeof o.text === "string" ? o.text.trim() : "";
          if (!text) return null;
          const due = typeof o.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.due) ? o.due : undefined;
          const priority = (o.priority === "high" || o.priority === "critical") ? o.priority : undefined;
          return { text, task: o.task !== false, needsApproval: o.needs_approval === true, due, priority };
        }
        return null;
      })
      .filter((a): a is LoopAction => a !== null)
      .slice(0, 5);
    const note = typeof obj.note === "string" ? obj.note.trim() : "";
    return { actions, done: obj.done === true, note };
  } catch {
    return null;
  }
}

// Result of an on-demand single-loop run (the desktop "Run now" button). Reports
// exactly what the loop did this pass so the UI can show it without guesswork.
export interface LoopRunResult {
  ok: boolean;
  loop: string;
  note: string;
  done: boolean;
  actions: { text: string; disposition: "task" | "approval" | "suggested" }[];
  tasksCreated: string[];
  pending: string[];
  briefing?: string; // for briefing loops: the rendered digest that was delivered
  error?: string;
}

// Run ONE loop right now, regardless of its cadence, and apply the result per the
// loop's autonomy (file tasks / queue approvals / just suggest). Returns a precise
// summary of what happened. Powers the per-loop "Run now" button.
export async function runOneLoop(
  cfg: LoopsConfig,
  domainName: string,
  loopRef: string,
  // Live progress callback. The desktop streams these to show what the loop is
  // doing instead of a blank spinner (resolve → read → think → apply → done).
  onPhase: (phase: string, label: string) => void = () => {},
): Promise<LoopRunResult> {
  const empty = (error: string, loop = loopRef): LoopRunResult => ({ ok: false, loop, note: "", done: false, actions: [], tasksCreated: [], pending: [], error });
  const root = resolve(cfg.vaultPath);
  onPhase("resolve", "Locating the loop");
  // Resolve to whichever layout actually holds this domain's _loops.json (a vault
  // can be split across data/domains, domains/, or the legacy root during migration).
  // "general" is a first-class domain: its canonical home is generalDir
  // (data/domains/general on a v4 vault, else the legacy vault root).
  const isGeneral = domainName.toLowerCase() === "general";
  const gdir = generalDir(root);
  const scanned = scanVault(root).find((d) => d.name === domainName)?.path;
  const candidates = [scanned, isGeneral ? gdir : null, join(root, "data", "domains", domainName), join(root, "domains", domainName), join(root, domainName)].filter(Boolean) as string[];
  const domainDir = candidates.find((d) => existsSync(join(d, "_loops.json"))) ?? (isGeneral ? gdir : scanned ?? join(root, "domains", domainName));
  const doc = readDoc(domainDir);
  if (!doc) return empty("no loops in this domain");
  const loop = doc.loops.find((l) => l.id === loopRef || l.name === loopRef);
  if (!loop) return empty("loop not found");

  const domainLabel = basename(domainDir);
  onPhase("read", "Reading state and memory");
  const state = safeRead(join(domainDir, "_state.md")) || safeRead(join(domainDir, "state.md"));
  const memory = safeRead(join(domainDir, "_memory.md"));
  const domainIntents = readDomainIntents(root, domainLabel);
  const clis = await detectClis();
  const cli = clis.find((c) => c.kind === cfg.provider) ?? clis[0];
  if (!cli) return empty("no CLI available to run loops", loop.name);
  // Per-loop model override wins over the global loops model.
  const runModel = (loop.model && loop.model.trim()) ? loop.model.trim() : (cfg.model || "");

  const now = Date.now();
  const rt = readRuntime(domainDir);
  const entry: LoopRtEntry = rt.loops[loop.id] ?? { history: [], pending: [] };

  // Briefing loops take a different path: synthesize a digest of the domain and
  // deliver it to the configured channel, rather than proposing gap-closing steps.
  if (loop.kind === "briefing") {
    return runBriefingLoop({ cfg, root, domainDir, domainLabel, doc, loop, cli, runModel, state, memory, now, rt, entry, onPhase });
  }

  try {
    onPhase("think", `Measuring the gap with ${runModel || cli.label}`);
    const out = await runChatTurn({
      prompt: buildPrompt(doc, loop, domainLabel, state, memory, entry, domainIntents),
      cwd: domainDir, cli, model: runModel, isFirst: true, bare: true,
    });
    onPhase("apply", "Applying the decision");
    const res = parseResult(out);
    loop.lastRunTs = now;
    const actions: LoopRunResult["actions"] = [];
    const created: string[] = [];
    if (res) {
      loop.actions = res.actions.map((a) => a.text);
      // A loop's pending list reflects its LATEST run, not an ever-growing pile.
      // Each run re-evaluates from scratch, so rebuild pending from this run's
      // needs-approval actions (deduped within the run) rather than appending to
      // the old set. Items the loop still wants reappear (same text, refreshed
      // ts); items it no longer proposes drop off. This stops the Decision Inbox
      // from accumulating near-duplicates across repeated runs.
      const nextPending: { text: string; ts: number }[] = [];
      const seenP = new Set<string>();
      for (const a of res.actions) {
        if (a.needsApproval) {
          const key = a.text.trim().toLowerCase();
          if (!seenP.has(key)) { seenP.add(key); nextPending.push({ text: a.text, ts: now }); }
          actions.push({ text: a.text, disposition: "approval" });
        } else if (a.task) {
          if (appendTask(domainDir, a.text, { due: a.due, priority: a.priority })) created.push(a.text);
          actions.push({ text: a.text, disposition: "task" });
        } else {
          actions.push({ text: a.text, disposition: "suggested" });
        }
      }
      entry.pending = nextPending;
      if (loop.type === "closed" && res.done) loop.status = "done";
      entry.history.unshift({ ts: now, actions: res.actions.map((a) => a.text), note: res.note, done: res.done, tasksCreated: created });
      entry.history = entry.history.slice(0, MAX_HISTORY);
      rt.loops[loop.id] = entry;
    }
    try { vwriteFile(loopsFile(domainDir), JSON.stringify(doc, null, 2)); } catch { /* best effort */ }
    writeRuntime(domainDir, rt);
    onPhase("done", "Done");
    // Record this run in the system activity log (one event per run + per filed task).
    logActivity(root, { type: "loop_run", domain: domainLabel, title: `${loop.name} ran`, detail: res?.note || undefined, status: "ok", ref: loop.id });
    for (const t of created) logActivity(root, { type: "task_filed", domain: domainLabel, title: `Filed task: ${t}`, status: "ok", ref: loop.id });
    return { ok: true, loop: loop.name, note: res?.note ?? "", done: res?.done ?? false, actions, tasksCreated: created, pending: entry.pending.map((p) => p.text) };
  } catch (e) {
    loop.lastRunTs = now;
    try { vwriteFile(loopsFile(domainDir), JSON.stringify(doc, null, 2)); } catch { /* best effort */ }
    return empty(String(e).slice(0, 200), loop.name);
  }
}

// Prompt for a briefing loop: turn the domain's state, memory, and task rollup
// into a tight, skimmable digest written FOR the user (second person).
function buildBriefingDigestPrompt(domainLabel: string, loop: Loop, state: string, memory: string, taskRollup: string, pending: string[]): string {
  return [
    `You are preparing a ${loop.cadence} briefing for the "${domainLabel}" domain of a personal life-OS. Write it FOR the user, addressing them as "you".`,
    `Synthesize what matters NOW: where things stand, what changed, what needs attention, and the clear next steps. Be concise and skimmable - a busy person reads this on their phone.`,
    "",
    `CURRENT STATE:\n${state.slice(0, 4000) || "(none yet)"}`,
    "",
    `DURABLE MEMORY:\n${memory.slice(0, 1500) || "(none)"}`,
    "",
    `TASKS:\n${taskRollup}`,
    pending.length ? `\nAWAITING YOUR APPROVAL:\n- ${pending.slice(0, 10).join("\n- ")}` : "",
    "",
    `OUTPUT - markdown only, no preamble, no sign-off, in this shape:`,
    `## ${domainLabel} briefing`,
    `**TL;DR**: one or two sentences on the single most important thing.`,
    `**Where things stand**: 2-4 bullets.`,
    `**Needs your attention**: blocked items, approvals, decisions - or "Nothing right now".`,
    `**Next steps**: 2-4 concrete actions.`,
    `Keep it tight, grounded in the data above. NEVER use em dashes; use hyphens or colons. No fluff, no invented facts.`,
  ].filter(Boolean).join("\n");
}

// Briefing-loop run: gather the domain, synthesize a digest, deliver to the
// configured channel (default Gmail), and record it. Reuses the tested briefing
// delivery layer (deliverBriefing) so channels behave identically to scheduled
// briefings. Falls back to log-only when no delivery hook is wired.
async function runBriefingLoop(p: {
  cfg: LoopsConfig; root: string; domainDir: string; domainLabel: string; doc: LoopsDoc;
  loop: Loop; cli: Awaited<ReturnType<typeof detectClis>>[number]; runModel: string;
  state: string; memory: string; now: number; rt: LoopRuntime; entry: LoopRtEntry;
  onPhase: (phase: string, label: string) => void;
}): Promise<LoopRunResult> {
  const { cfg, root, domainDir, domainLabel, doc, loop, cli, runModel, state, memory, now, rt, entry, onPhase } = p;
  const channel = loop.channel ?? "gmail";
  try {
    onPhase("read", "Gathering tasks and context");
    const tasks = readTasks(domainDir).filter((t) => !t.trashed); // never surface trashed tasks
    const open = tasks.filter((t) => !t.done && effectiveStatus(t) !== "done");
    const doing = open.filter((t) => effectiveStatus(t) === "doing");
    const blocked = open.filter((t) => effectiveStatus(t) === "blocked");
    const todo = open.filter((t) => { const s = effectiveStatus(t); return s !== "doing" && s !== "blocked"; });
    const review = tasks.filter((t) => effectiveStatus(t) === "review");
    // Time-sensitive + important work the briefing should lead with.
    const today = new Date().toISOString().slice(0, 10);
    const fmtT = (t: Task) => `${t.text}${t.due ? ` (due ${t.due})` : ""}`;
    const overdue = open.filter((t) => t.due && t.due < today);
    const dueSoon = open.filter((t) => t.due && t.due >= today && t.due <= new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10));
    const critical = open.filter((t) => t.priority === "critical" || t.priority === "high");
    const taskRollup = [
      overdue.length ? `OVERDUE (${overdue.length}): ${overdue.map(fmtT).join("; ")}` : "",
      dueSoon.length ? `Due within 7 days (${dueSoon.length}): ${dueSoon.map(fmtT).join("; ")}` : "",
      critical.length ? `Important/critical (${critical.length}): ${critical.map(fmtT).join("; ")}` : "",
      doing.length ? `In progress (${doing.length}): ${doing.map((t) => t.text).join("; ")}` : "",
      blocked.length ? `Blocked or waiting (${blocked.length}): ${blocked.map((t) => t.text).join("; ")}` : "",
      todo.length ? `To do (${todo.length}): ${todo.slice(0, 12).map((t) => t.text).join("; ")}` : "",
      review.length ? `Awaiting your review (${review.length}): ${review.map((t) => t.text).join("; ")}` : "",
    ].filter(Boolean).join("\n") || "(no open tasks)";
    const pendingAll = Object.values(rt.loops).flatMap((e) => e.pending.map((x) => x.text));

    onPhase("think", `Writing the briefing with ${runModel || cli.label}`);
    const prompt = buildBriefingDigestPrompt(domainLabel, loop, state, memory, taskRollup, pendingAll);
    const output = (await runChatTurn({ prompt, cwd: domainDir, cli, model: runModel, isFirst: true, bare: true })).trim();

    onPhase("apply", `Delivering to ${channel}`);
    // Synthetic briefing entry so we reuse the same delivery code paths.
    const briefEntry: BriefingEntry = {
      id: loop.id, name: loop.name, cron: "", domain: domainLabel, prompt: "", mode: "single",
      deliver: channel === "telegram" ? "telegram" : "log",
      channels: channel === "gmail" ? ["email"] : [],
      enabled: true, last_run: null, created_at: 0,
    };
    const cliLabel = `${cli.label} (briefing)`;
    const delivered = await deliverBriefing(briefEntry, output, now, cliLabel, domainDir, cfg.deliverTelegram, { email: cfg.deliverEmail });

    const emailResult = typeof delivered.channels?.email === "string" ? delivered.channels.email : "";
    const emailSkipped = /^skipped/.test(emailResult);   // channel requested but not connected
    const emailErr = /^error/.test(emailResult);         // a real send failure
    const sentTo: string[] = [];
    if (delivered.log) sentTo.push("journal");
    if (delivered.telegram) sentTo.push(`telegram (${delivered.telegram})`);
    if (emailResult && !emailSkipped && !emailErr) sentTo.push("gmail");
    let note = sentTo.length ? `Briefing delivered to ${sentTo.join(", ")}` : "Briefing generated (not delivered)";
    if (emailSkipped) note += " - connect Gmail to email it";
    else if (emailErr) note += ` - gmail failed: ${emailResult.replace(/^error:?\s*/i, "")}`;

    loop.lastRunTs = now;
    entry.history.unshift({ ts: now, actions: [], note, done: false, tasksCreated: [] });
    entry.history = entry.history.slice(0, MAX_HISTORY);
    rt.loops[loop.id] = entry;
    const lref = doc.loops.find((x) => x.id === loop.id);
    if (lref) lref.lastRunTs = now;
    try { vwriteFile(loopsFile(domainDir), JSON.stringify(doc, null, 2)); } catch { /* best effort */ }
    writeRuntime(domainDir, rt);
    onPhase("done", "Done");
    logActivity(root, { type: "briefing", domain: domainLabel, title: `${loop.name} delivered`, detail: note, status: emailErr ? "error" : emailSkipped ? "pending" : "ok", ref: loop.id });
    return { ok: true, loop: loop.name, note, done: false, actions: [], tasksCreated: [], pending: [], briefing: output };
  } catch (e) {
    loop.lastRunTs = now;
    return { ok: false, loop: loop.name, note: "", done: false, actions: [], tasksCreated: [], pending: [], error: String(e).slice(0, 200) };
  }
}

// Run every due loop in one domain. Returns how many loops advanced.
async function runDomain(domainDir: string, cfg: LoopsConfig, now: number): Promise<number> {
  const doc = readDoc(domainDir);
  if (!doc) return 0;
  const due = doc.loops.filter((l) => isDue(l, now));
  if (due.length === 0) return 0;

  // The general domain dir maps to the label "general"; everything else by dir name.
  const domainLabel = resolve(domainDir) === resolve(generalDir(cfg.vaultPath)) || resolve(domainDir) === resolve(cfg.vaultPath) ? "general" : basename(domainDir);
  const state = safeRead(join(domainDir, "_state.md")) || safeRead(join(domainDir, "state.md"));
  const memory = safeRead(join(domainDir, "_memory.md"));
  // Curated high-level intents touching this domain — the compounding signal.
  const domainIntents = readDomainIntents(resolve(cfg.vaultPath), domainLabel);

  const clis = await detectClis();
  const cli = clis.find((c) => c.kind === cfg.provider) ?? clis[0];
  if (!cli) throw new Error("no CLI available to run loops");

  const rt = readRuntime(domainDir);
  let advanced = 0;
  for (const loop of due) {
    try {
      const entry: LoopRtEntry = rt.loops[loop.id] ?? { history: [], pending: [] };
      // Briefing loops synthesize + deliver a digest on their cadence (no steward pass).
      if (loop.kind === "briefing") {
        const bModel = (loop.model && loop.model.trim()) ? loop.model.trim() : (cfg.model || "");
        const r = await runBriefingLoop({ cfg, root: resolve(cfg.vaultPath), domainDir, domainLabel, doc, loop, cli, runModel: bModel, state, memory, now, rt, entry, onPhase: () => {} });
        if (r.ok) advanced += 1;
        continue;
      }
      const out = await runChatTurn({
        prompt: buildPrompt(doc, loop, domainLabel, state, memory, entry, domainIntents),
        cwd: domainDir,
        cli,
        model: cfg.model || "",
        isFirst: true,
        bare: true,
      });
      const res = parseResult(out);
      loop.lastRunTs = now;
      if (res) {
        // Surface text actions on the loop (back-compat: the UI reads loop.actions).
        loop.actions = res.actions.map((a) => a.text);
        // Act: file concrete auto-approved steps as real tasks; queue the rest
        // (anything needing money/contact/decision) as pending approvals so the
        // loop ASKS instead of assuming.
        const created: string[] = [];
        // Rebuild pending from THIS run's approvals (deduped) rather than
        // appending, so repeated scheduled runs don't pile up near-duplicates.
        const nextPending: { text: string; ts: number }[] = [];
        const seenP = new Set<string>();
        for (const a of res.actions) {
          if (a.needsApproval) {
            const key = a.text.trim().toLowerCase();
            if (!seenP.has(key)) { seenP.add(key); nextPending.push({ text: a.text, ts: now }); }
          } else if (a.task) {
            if (appendTask(domainDir, a.text, { due: a.due, priority: a.priority })) created.push(a.text);
          }
        }
        entry.pending = nextPending;
        if (loop.type === "closed" && res.done) loop.status = "done";
        // Learn: record this run so the next one builds on it and doesn't repeat.
        entry.history.unshift({ ts: now, actions: res.actions.map((a) => a.text), note: res.note, done: res.done, tasksCreated: created });
        entry.history = entry.history.slice(0, MAX_HISTORY);
        rt.loops[loop.id] = entry;
        advanced += 1;
        // System activity: one event per scheduled run + per filed task.
        logActivity(resolve(cfg.vaultPath), { type: "loop_run", domain: basename(domainDir), title: `${loop.name} ran`, detail: res.note || undefined, status: "ok", ref: loop.id });
        for (const t of created) logActivity(resolve(cfg.vaultPath), { type: "task_filed", domain: basename(domainDir), title: `Filed task: ${t}`, status: "ok", ref: loop.id });
      }
    } catch (e) {
      // Best-effort: stamp the run so a persistently-failing loop doesn't spin
      // every wake, and move on to the next loop.
      loop.lastRunTs = now;
      console.error(`[loops] ${domainLabel}/${loop.name}: ${String(e).slice(0, 160)}`);
    }
  }

  // Persist the whole doc once per domain (full-document write, like _state.md),
  // plus the engine-owned runtime (history + pending approvals).
  try { vwriteFile(loopsFile(domainDir), JSON.stringify(doc, null, 2)); } catch { /* best effort */ }
  writeRuntime(domainDir, rt);
  return advanced;
}

// Execute a single APPROVED loop action for real, using the agent's actual tools
// and connectors (MCP servers, file ops, configured app connectors). The user has
// already approved this specific action in the UI, so the agent is told to DO it —
// but only it, and to refuse cleanly if no connector can. Returns the agent's
// report of what it did (captured by the desktop, recorded as a decision).
export async function executeAction(cfg: LoopsConfig, domainName: string, action: string): Promise<string> {
  const root = resolve(cfg.vaultPath);
  const found = scanVault(root).find((d) => d.name === domainName);
  const domainDir = found?.path ?? join(root, "domains", domainName);
  const clis = await detectClis();
  const cli = clis.find((c) => c.kind === cfg.provider) ?? clis[0];
  if (!cli) throw new Error("no CLI available to execute the action");
  const state = safeRead(join(domainDir, "_state.md")) || safeRead(join(domainDir, "state.md"));
  const prompt = [
    `You are carrying out an action the user has EXPLICITLY APPROVED in the "${domainName}" domain of their personal life-OS.`,
    `Do it now using the tools and connectors available to you: MCP servers, file operations, and any configured app connectors (email, calendar, etc.).`,
    "",
    `APPROVED ACTION:`,
    action,
    "",
    state ? `DOMAIN CONTEXT (from _state.md):\n${state.slice(0, 2000)}` : "",
    "",
    `RULES:`,
    `- Actually perform the action with a real tool/connector. Do not merely describe it.`,
    `- Do NOT do anything beyond this one approved action.`,
    `- If NO available tool or connector can perform it, do nothing and reply with exactly: "NO_CONNECTOR: <one-line reason>".`,
    `- When finished, reply with a one-paragraph report of precisely what you did, including any IDs, links, or recipients.`,
  ].filter(Boolean).join("\n");
  const out = await runChatTurn({
    prompt,
    cwd: domainDir,
    cli,
    model: cfg.model || "",
    isFirst: true,
    bare: false, // full operating manual — the agent SHOULD take action here
    act: true,   // user-approved: let the agent actually use its tools/connectors
  });
  const report = out.trim();
  // System activity: record the execution + its outcome.
  const noConn = report.startsWith("NO_CONNECTOR");
  logActivity(root, {
    type: "loop_exec",
    domain: domainName,
    title: `Executed: ${action.length > 80 ? action.slice(0, 80) + "…" : action}`,
    detail: report.slice(0, 400),
    status: noConn ? "error" : "ok",
  });
  return report;
}

// ── AI-task steward (Workflows-Kanban P0) ────────────────────────────────────
// A task with `~owner:ai` is work the user HANDED to the AI from the board. This
// is the autonomous half: pick up AI-owned tasks that are still open (todo/doing,
// not blocked/review/done) and either DO them or, if consequential, pause them for
// the user. Outcomes flow back through the same files the desktop reads:
//   - did it          → task `~status:review`  (shows in the Decision Inbox to accept)
//   - needs a decision → task `~status:blocked` (shows in the Decision Inbox to approve)
//   - no connector     → task `~status:blocked` (surfaced so the user can intervene)
// Capped per pass so a backlog can't fan out into a runaway of agent runs.
const AI_TASK_BUDGET = 3;

function openAiTasks(domainDir: string): Task[] {
  return readTasks(domainDir).filter((t) => {
    if (t.owner !== "ai" || t.done || !t.id || t.trashed) return false; // skip trashed
    const st = effectiveStatus(t);
    return st === "todo" || st === "doing";
  });
}

// Run ONE AI-owned task. Returns the resulting status it was moved to (or null on
// a transient failure — the task is left as-is to retry next pass).
async function runAiTask(domainDir: string, cfg: LoopsConfig, task: Task): Promise<string | null> {
  const clis = await detectClis();
  const cli = clis.find((c) => c.kind === cfg.provider) ?? clis[0];
  if (!cli) throw new Error("no CLI available to run AI tasks");
  const domainName = basename(domainDir);
  const state = safeRead(join(domainDir, "_state.md")) || safeRead(join(domainDir, "state.md"));
  const prompt = [
    `You are working an AI-owned task the user assigned to you on their board, in the "${domainName}" domain of their personal life-OS.`,
    `You are in the LABOR seat, not the decision seat: do the legwork, but the user makes any real call.`,
    "",
    `TASK:`,
    task.text,
    "",
    state ? `DOMAIN CONTEXT (from _state.md):\n${state.slice(0, 1500)}` : "",
    "",
    `DECIDE then ACT:`,
    `- If this task SPENDS money, CONTACTS someone, is IRREVERSIBLE, or needs a decision/info only the user can give: do NOT do it. Reply with exactly "NEEDS_APPROVAL: <one-line what you'd do and why it needs the user>".`,
    `- Else, actually perform it now using your tools/connectors (MCP servers, file ops, configured app connectors). Don't merely describe it.`,
    `- If no available tool/connector can perform it, reply with exactly "NO_CONNECTOR: <one-line reason>".`,
    `- When you DID it, reply with a one-paragraph report of precisely what you did (IDs, links, recipients).`,
  ].filter(Boolean).join("\n");
  const out = (await runChatTurn({
    prompt,
    cwd: domainDir,
    cli,
    model: cfg.model || "",
    isFirst: true,
    bare: false,
    act: true,
  })).trim();

  const head = out.slice(0, 40).toUpperCase();
  const next = head.startsWith("NEEDS_APPROVAL") || head.startsWith("NO_CONNECTOR") ? "blocked" : "review";
  if (task.id) setTaskStatus(domainDir, task.id, next);
  return next;
}

// Work this domain's AI-owned tasks (up to the per-pass budget). Returns count handled.
async function consumeAiTasks(domainDir: string, cfg: LoopsConfig): Promise<number> {
  const queue = openAiTasks(domainDir).slice(0, AI_TASK_BUDGET);
  let handled = 0;
  for (const task of queue) {
    try {
      const r = await runAiTask(domainDir, cfg, task);
      if (r) handled += 1;
    } catch (e) {
      console.error(`[loops] ${basename(domainDir)} ai-task: ${String(e).slice(0, 160)}`);
    }
  }
  return handled;
}

// One pass across every domain. Domain discovery goes through scanVault so it
// finds domains in BOTH the v3 (vault/domains/<d>) and legacy (vault/<d>) layouts
// and gets each one's resolved path. Advances due loops AND works AI-owned tasks.
export async function loopsOnce(cfg: LoopsConfig): Promise<{ domains: number; loops: number; aiTasks: number }> {
  const root = resolve(cfg.vaultPath);
  const now = Date.now();
  let domains = 0;
  let loops = 0;
  let aiTasks = 0;

  // Include the general domain (data/domains/general on v4, else root) alongside
  // the scanned domains so its loops run on schedule too.
  const targets = [...scanVault(root).map((d) => ({ name: d.name, path: d.path })), { name: "general", path: generalDir(root) }];
  for (const d of targets) {
    try {
      let touched = false;
      if (existsSync(loopsFile(d.path))) {
        const n = await runDomain(d.path, cfg, now);
        if (n > 0) { loops += n; touched = true; }
      }
      // AI tasks are independent of loop definitions — a domain can have AI-owned
      // tasks without any loops.
      const a = await consumeAiTasks(d.path, cfg);
      if (a > 0) { aiTasks += a; touched = true; }
      if (touched) domains += 1;
    } catch (e) {
      console.error(`[loops] ${d.name}: ${String(e).slice(0, 160)}`);
    }
  }
  return { domains, loops, aiTasks };
}

// The long-running daemon: wake on the interval, advance any due loops.
export async function runLoopsDaemon(cfg: LoopsConfig): Promise<void> {
  const interval = Math.max(60, cfg.intervalSec) * 1000;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGINT", () => { stop(); console.log("\n[loops] stopped"); process.exit(0); });
  process.on("SIGTERM", () => { stop(); process.exit(0); });

  const live = { ...cfg, vaultPath: resolve(cfg.vaultPath) };
  console.log(`[loops] running domain loops every ${Math.round(interval / 1000)}s (each loop on its own cadence)`);
  while (!stopped) {
    try {
      const { domains, loops, aiTasks } = await loopsOnce(live);
      if (loops > 0 || aiTasks > 0) console.log(`[loops] advanced ${loops} loop(s) + ${aiTasks} AI task(s) across ${domains} domain(s)`);
    } catch (e) {
      console.error(`[loops] pass error: ${String(e).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
