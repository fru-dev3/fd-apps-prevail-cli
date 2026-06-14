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
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { runChatTurn, detectClis } from "./cli-bridge.ts";

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

// Ask the model for this loop's current next actions and (for closed loops)
// whether its condition is now satisfied. Strict JSON so parsing is reliable.
function buildPrompt(doc: LoopsDoc, loop: Loop, domainLabel: string, state: string, memory: string): string {
  return [
    `You are the steward of the "${loop.name}" loop in the ${domainLabel} domain of a personal life-OS.`,
    `A loop continuously reduces the gap between the current state and the desired state. Your job: given what's known now, output the smallest set of highest-leverage next actions (1-3) that move this loop forward.`,
    "",
    `DESIRED STATE (domain):\n${doc.desiredState || "(not set)"}`,
    "",
    `LOOP`,
    `- purpose: ${loop.purpose || loop.name}`,
    `- type: ${loop.type}${loop.type === "closed" ? ` (closed: finishes when the condition is met)` : " (open: ongoing)"}`,
    `- signals to weigh: ${loop.signals.join(", ") || "(none listed)"}`,
    `- condition: ${loop.condition || "(none)"}`,
    `- what good looks like: ${loop.evaluation || "(not specified)"}`,
    "",
    `CURRENT STATE (from the domain's _state.md):\n${state.slice(0, 4000) || "(none yet)"}`,
    "",
    `LONG-TERM MEMORY (excerpt):\n${memory.slice(0, 2000) || "(none yet)"}`,
    "",
    `Respond with ONLY a JSON object on a single line:`,
    `{"actions":["next action 1","next action 2"],"done":false,"note":"one-line rationale"}`,
    loop.type === "closed"
      ? `Set "done" to true only if the loop's condition is clearly satisfied by the current state.`
      : `"done" must be false for open loops.`,
  ].join("\n");
}

// Pull the first JSON object out of model output (tolerates code fences / prose).
function parseResult(out: string): { actions: string[]; done: boolean } | null {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(out.slice(start, end + 1)) as { actions?: unknown; done?: unknown };
    const actions = Array.isArray(obj.actions) ? obj.actions.filter((a): a is string => typeof a === "string" && a.trim() !== "").slice(0, 5) : [];
    return { actions, done: obj.done === true };
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

  const clis = await detectClis();
  const cli = clis.find((c) => c.kind === cfg.provider) ?? clis[0];
  if (!cli) throw new Error("no CLI available to run loops");

  let advanced = 0;
  for (const loop of due) {
    try {
      const out = await runChatTurn({
        prompt: buildPrompt(doc, loop, domainLabel, state, memory),
        cwd: domainDir,
        cli,
        model: cfg.model || "",
        isFirst: true,
        bare: true,
      });
      const res = parseResult(out);
      loop.lastRunTs = now;
      if (res) {
        if (res.actions.length) loop.actions = res.actions;
        if (loop.type === "closed" && res.done) loop.status = "done";
        advanced += 1;
      }
    } catch (e) {
      // Best-effort: stamp the run so a persistently-failing loop doesn't spin
      // every wake, and move on to the next loop.
      loop.lastRunTs = now;
      console.error(`[loops] ${domainLabel}/${loop.name}: ${String(e).slice(0, 160)}`);
    }
  }

  // Persist the whole doc once per domain (full-document write, like _state.md).
  try { vwriteFile(loopsFile(domainDir), JSON.stringify(doc, null, 2)); } catch { /* best effort */ }
  return advanced;
}

// One pass across every domain that has loops defined.
export async function loopsOnce(cfg: LoopsConfig): Promise<{ domains: number; loops: number }> {
  const root = resolve(cfg.vaultPath);
  const now = Date.now();
  let domains = 0;
  let loops = 0;

  for (const name of readdirSync(root)) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(loopsFile(dir))) continue;
      const n = await runDomain(dir, cfg, now);
      if (n > 0) { domains += 1; loops += n; }
    } catch (e) {
      console.error(`[loops] ${name}: ${String(e).slice(0, 160)}`);
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
