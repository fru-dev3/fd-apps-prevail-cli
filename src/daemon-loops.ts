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
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { runChatTurn, detectClis } from "./cli-bridge.ts";
import { scanVault } from "./vault.ts";

export interface LoopsConfig {
  vaultPath: string;
  intervalSec: number; // how often the daemon wakes to check for due loops
  provider: string;    // which CLI runs the evaluation
  model: string;       // optional model id ("" = provider default)
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

interface LoopAction { text: string; task: boolean; needsApproval: boolean }
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
export function appendTask(domainDir: string, text: string): boolean {
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
  vwriteFile(f, `${body}- [ ] ${clean} +${todayYmd()} ~loop\n`);
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
    const raw = safeRead(join(vaultRoot, "_meta", "intents_distilled.json"));
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
    `Respond with ONLY a JSON object on a single line. Each action is an object:`,
    `{"actions":[{"text":"the next step","task":true,"needs_approval":false}],"done":false,"note":"one-line read on progress + why these steps"}`,
    `- "task": true if this is a concrete, trackable step — it will be FILED as a real task in this domain and worked on. false for pure observations/notes.`,
    `- "needs_approval": true if it spends money, contacts someone, is irreversible, or needs a decision/info only the user can give. Those are PROPOSED and wait for the user instead of being done automatically. Be conservative: when unsure, set true.`,
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
          const o = a as { text?: unknown; task?: unknown; needs_approval?: unknown };
          const text = typeof o.text === "string" ? o.text.trim() : "";
          if (!text) return null;
          return { text, task: o.task !== false, needsApproval: o.needs_approval === true };
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

// Run every due loop in one domain. Returns how many loops advanced.
async function runDomain(domainDir: string, cfg: LoopsConfig, now: number): Promise<number> {
  const doc = readDoc(domainDir);
  if (!doc) return 0;
  const due = doc.loops.filter((l) => isDue(l, now));
  if (due.length === 0) return 0;

  const domainLabel = basename(domainDir);
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
        for (const a of res.actions) {
          if (a.needsApproval) {
            if (!entry.pending.some((p) => p.text.toLowerCase() === a.text.toLowerCase())) {
              entry.pending.push({ text: a.text, ts: now });
            }
          } else if (a.task) {
            if (appendTask(domainDir, a.text)) created.push(a.text);
          }
        }
        if (loop.type === "closed" && res.done) loop.status = "done";
        // Learn: record this run so the next one builds on it and doesn't repeat.
        entry.history.unshift({ ts: now, actions: res.actions.map((a) => a.text), note: res.note, done: res.done, tasksCreated: created });
        entry.history = entry.history.slice(0, MAX_HISTORY);
        rt.loops[loop.id] = entry;
        advanced += 1;
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
  return out.trim();
}

// One pass across every domain that has loops defined. Domain discovery goes
// through scanVault so it finds domains in BOTH the v3 (vault/domains/<d>) and
// legacy (vault/<d>) layouts and gets each one's resolved path.
export async function loopsOnce(cfg: LoopsConfig): Promise<{ domains: number; loops: number }> {
  const root = resolve(cfg.vaultPath);
  const now = Date.now();
  let domains = 0;
  let loops = 0;

  for (const d of scanVault(root)) {
    try {
      if (!existsSync(loopsFile(d.path))) continue;
      const n = await runDomain(d.path, cfg, now);
      if (n > 0) { domains += 1; loops += n; }
    } catch (e) {
      console.error(`[loops] ${d.name}: ${String(e).slice(0, 160)}`);
    }
  }
  return { domains, loops };
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
      const { domains, loops } = await loopsOnce(live);
      if (loops > 0) console.log(`[loops] advanced ${loops} loop(s) across ${domains} domain(s)`);
    } catch (e) {
      console.error(`[loops] pass error: ${String(e).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
