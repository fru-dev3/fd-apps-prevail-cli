// Conversation schedules: a saved prompt that runs as a NEW TURN in an existing
// chat thread on a cron, so its result lands in that conversation.
//
// Stored as ordinary ScheduleEntry rows in <vault>/.schedule.json with
// `thread: { domain, session }` + `prompt` (command stays empty; these never
// shell out). Only the HUB fires them: the sync daemon (`daemon --sync`, the
// always-on hub process) calls runThreadSchedulesDue every tick, and
// tickThreadSchedules refuses on a client machine. A due turn goes through
// runChatJson, the same path a desktop chat turn uses, so the act gate and the
// egress guard apply; a held act simply waits in the queue (and shows in
// `prevail waiting`) like any other.
//
// The desktop's canonical transcript is <thread dir>/<session>.md ("## You" /
// "## <cli> · <model>" blocks). The engine's own JSONL twin gets the turn via
// runChatJson; the markdown gets the same user + assistant pair appended so the
// result is visible when the conversation is opened.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { domainDir } from "./decisions.ts";
import { tryAcquireLock } from "./file-lock.ts";
import { isClientMachine } from "./machine-role.ts";
import { isV4Domain } from "./vault-layout-v4.ts";
import {
  isCronDue,
  isThreadSchedule,
  isValidCron,
  loadSchedules,
  makeScheduleId,
  saveSchedules,
  type ScheduleEntry,
} from "./schedule.ts";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DOMAIN_RE = /^[A-Za-z0-9_.-]{1,128}$/;
/** A daemon tick can run long (connector syncs), so a due minute is caught up
 *  to this far back instead of being missed when the tick lands late. */
export const CATCH_UP_MINUTES = 30;

const lockPath = (vault: string) => join(vault, ".schedule.json.lock");

export interface ThreadScheduleInput {
  domain: string;
  session: string;
  prompt: string;
  cron: string;
  name?: string;
}

/** Validate and append a conversation schedule. Returns the created entry. */
export function addThreadSchedule(vault: string, input: ThreadScheduleInput): { ok: true; entry: ScheduleEntry } | { ok: false; error: string } {
  const domain = (input.domain ?? "").trim();
  const session = (input.session ?? "").trim();
  const prompt = (input.prompt ?? "").trim();
  const cron = (input.cron ?? "").trim();
  if (!DOMAIN_RE.test(domain) || domain.includes("..")) return { ok: false, error: "invalid domain" };
  if (!ID_RE.test(session)) return { ok: false, error: "invalid session id" };
  if (!prompt) return { ok: false, error: "empty prompt" };
  if (!isValidCron(cron)) return { ok: false, error: `invalid cron: "${cron}" (needs 5 space-separated fields)` };
  const entry: ScheduleEntry = {
    id: makeScheduleId(),
    name: (input.name ?? "").trim() || prompt.slice(0, 60),
    cron,
    command: "",
    enabled: true,
    last_run: null,
    created_at: Date.now(),
    thread: { domain, session },
    prompt,
  };
  withScheduleLock(vault, () => {
    const all = loadSchedules(vault);
    all.push(entry);
    saveSchedules(vault, all);
  });
  return { ok: true, entry };
}

// Best-effort serialization with the tickers. tryAcquireLock never blocks; a
// short retry covers a tick holding it, then the write proceeds regardless
// (the same as `schedule add`, which never locked at all).
function withScheduleLock<T>(vault: string, fn: () => T): T {
  let lock = tryAcquireLock(lockPath(vault));
  for (let i = 0; !lock && i < 20; i++) {
    Bun.sleepSync(25);
    lock = tryAcquireLock(lockPath(vault));
  }
  try { return fn(); } finally { lock?.release(); }
}

/** Is this conversation schedule due at `now`? True when a cron minute fell
 *  after its last run (or creation) and within the catch-up window, and it has
 *  not already run this minute. */
export function isThreadScheduleDue(e: ScheduleEntry, now: Date = new Date()): boolean {
  if (!e.enabled || !isThreadSchedule(e)) return false;
  const minute = Math.floor(now.getTime() / 60000) * 60000;
  const floorMin = (ts: number) => Math.floor(ts / 60000) * 60000;
  const since = Math.max(floorMin(e.last_run ?? e.created_at ?? 0), minute - CATCH_UP_MINUTES * 60000);
  for (let t = minute; t > since; t -= 60000) {
    if (isCronDue(e.cron, new Date(t))) return true;
  }
  return false;
}

export interface ThreadTurnRequest {
  vault: string;
  scheduleId: string;
  domain: string;
  session: string;
  prompt: string;
}
export interface ThreadTurnResult {
  ok: boolean;
  reply?: string;
  error?: string;
}
export type ThreadTurnRunner = (req: ThreadTurnRequest) => Promise<ThreadTurnResult>;

export interface ThreadTickResult {
  fired: ScheduleEntry[];
  /** True when this machine is a client and nothing was considered. */
  skippedRole?: boolean;
  /** Settles when every fired turn finished (the daemon does not wait on it). */
  done: Promise<ThreadTurnResult[]>;
}

/** Fire every due conversation schedule. Marks them run (under the schedule
 *  lock, so the daemon and a manual `schedule tick` cannot double-fire), then
 *  starts each turn through `runner`. Hub only: a client returns at once. */
export function tickThreadSchedules(vault: string, runner: ThreadTurnRunner, now: Date = new Date(), isClient: () => boolean = isClientMachine): ThreadTickResult {
  if (isClient()) return { fired: [], skippedRole: true, done: Promise.resolve([]) };
  const lock = tryAcquireLock(lockPath(vault));
  if (!lock) return { fired: [], done: Promise.resolve([]) };
  const fired: ScheduleEntry[] = [];
  try {
    const all = loadSchedules(vault);
    for (const s of all) {
      if (!isThreadScheduleDue(s, now)) continue;
      s.last_run = now.getTime();
      fired.push(s);
    }
    if (fired.length) saveSchedules(vault, all);
  } finally {
    lock.release();
  }
  const done = Promise.all(fired.map((s) => runThreadEntry(vault, s, runner)));
  return { fired, done };
}

/** Run one conversation schedule now (the tick, or `schedule run <id>`). */
export async function runThreadEntry(vault: string, s: ScheduleEntry, runner: ThreadTurnRunner): Promise<ThreadTurnResult> {
  if (!s.thread || !s.prompt) return { ok: false, error: "not a conversation schedule" };
  try {
    return await runner({ vault, scheduleId: s.id, domain: s.thread.domain, session: s.thread.session, prompt: s.prompt });
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

// ── The desktop thread transcript (<session>.md) ─────────────────────────────
// Mirrors the desktop paths::thread_search_dirs: canonical memory/threads on a
// v4 domain, else _threads; legacy _threads searched too.
function threadMdPath(vault: string, domain: string, session: string): string | null {
  if (!ID_RE.test(session)) return null;
  const base = domainDir(vault, domain);
  const dirs = isV4Domain(base) ? [join(base, "memory", "threads"), join(base, "_threads")] : [join(base, "_threads")];
  for (const d of dirs) {
    const p = join(d, `${session}.md`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** The folder new threads of a space are written to: memory/threads on a v4 space, else _threads (the desktop's choice). */
export function threadWriteDir(vault: string, space: string): string {
  const base = domainDir(vault, space);
  return isV4Domain(base) ? join(base, "memory", "threads") : join(base, "_threads");
}

/** Every existing file of one thread (the .md transcript and its .jsonl twin), wherever it lives in the space. */
export function threadFiles(vault: string, space: string, session: string): string[] {
  if (!ID_RE.test(session)) return [];
  const base = domainDir(vault, space);
  const dirs = [...new Set([threadWriteDir(vault, space), join(base, "_threads")])];
  return dirs.flatMap((d) => [".md", ".jsonl"].map((x) => join(d, `${session}${x}`))).filter((p) => existsSync(p));
}

const isoZ = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export interface NewThread {
  title: string;
  turns: { role: "user" | "assistant"; content: string; cli?: string; model?: string }[];
  /** `entity: <kind>/<slug>`, `app: <id>`: the tags the desktop files a thread by. */
  entity?: string;
  app?: string;
  now?: number;
}

/** Create a desktop thread transcript with the desktop's own frontmatter
 *  (threads.rs save_thread), so it lists like any conversation. Never
 *  overwrites: returns null when the session already has a file. */
export function createThreadMarkdown(vault: string, space: string, session: string, t: NewThread): string | null {
  if (!ID_RE.test(session) || threadMdPath(vault, space, session)) return null;
  const dir = threadWriteDir(vault, space);
  const p = join(dir, `${session}.md`);
  const iso = isoZ(t.now ?? Date.now());
  const one = (s: string) => s.replace(/\s+/g, " ").trim();
  const general = !space || space === "general" || space === "__general__";
  let body = `---\ntitle: ${one(t.title) || "Untitled"}\ndomain: ${general ? "" : space}\ncreated: ${iso}\nupdated: ${iso}\nturns: ${t.turns.length}\n`;
  if (t.entity) body += `entity: ${one(t.entity)}\n`;
  if (t.app) body += `app: ${one(t.app)}\n`;
  body += "---\n\n";
  for (const turn of t.turns) {
    const cli = (turn.cli ?? "assistant").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "assistant";
    body += `## ${turn.role === "user" ? "You" : `${cli}${turn.model ? ` · ${turn.model}` : ""}`}\n\n${turn.content.trim()}\n\n`;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, body);
  return p;
}

/** The last few turns of a desktop thread as plain context for the model. */
export function threadContext(vault: string, domain: string, session: string, maxChars = 6000): string {
  const p = threadMdPath(vault, domain, session);
  if (!p) return "";
  let raw = "";
  try { raw = readFileSync(p, "utf8"); } catch { return ""; }
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  if (!body) return "";
  const tail = body.length > maxChars ? body.slice(body.length - maxChars) : body;
  return `This is a scheduled run in an ongoing conversation. Recent conversation for context:\n\n${tail}\n\nThe scheduled request follows.`;
}

/** Append a user + assistant pair to the desktop thread markdown, keeping its
 *  frontmatter `updated` / `turns` honest. False when the thread file does not
 *  exist (never creates a conversation the user did not start). */
export function appendThreadMarkdown(vault: string, domain: string, session: string, turns: { role: "user" | "assistant"; content: string; cli?: string; model?: string }[]): boolean {
  const p = threadMdPath(vault, domain, session);
  if (!p) return false;
  try {
    let raw = readFileSync(p, "utf8");
    let add = "";
    for (const t of turns) {
      // The desktop parser only treats "## You" and a lowercase cli id as turn
      // headers; anything else would fold into the previous message.
      const cli = (t.cli ?? "assistant").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "assistant";
      const speaker = t.role === "user" ? "You" : `${cli}${t.model ? ` · ${t.model}` : ""}`;
      add += `## ${speaker}\n\n${t.content.trim()}\n\n`;
    }
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
    if (fm) {
      let meta = fm[1]!;
      const iso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      meta = /^updated:/m.test(meta) ? meta.replace(/^updated:.*$/m, `updated: ${iso}`) : meta;
      meta = meta.replace(/^turns:\s*(\d+)\s*$/m, (_m, n: string) => `turns: ${Number(n) + turns.length}`);
      raw = `---\n${meta}\n---\n${raw.slice(fm[0].length)}`;
    }
    if (!raw.endsWith("\n\n")) raw = raw.endsWith("\n") ? `${raw}\n` : `${raw}\n\n`;
    writeFileSync(p, raw + add);
    return true;
  } catch {
    return false;
  }
}

/** The production runner: one chat turn through runChatJson (the desktop chat
 *  path, so the act gate and egress guard apply, with PREVAIL_THREAD_ID set to
 *  the session), then the pair is appended to the desktop transcript. */
export const runScheduledThreadTurn: ThreadTurnRunner = async (req) => {
  const { runChatJson } = await import("./chat-json.ts");
  let reply = "";
  let error = "";
  let engine = "";
  const code = await runChatJson({
    vaultPath: req.vault,
    domain: req.domain,
    message: req.prompt,
    sessionId: req.session,
    threadId: req.session,
    // A fresh model session with the thread's recent turns as context, rather
    // than resuming whichever conversation last ran in the domain folder.
    fresh: true,
    preamble: threadContext(req.vault, req.domain, req.session),
    localOnly: process.env.PREVAIL_BUNKER === "1",
    write: (line) => {
      try {
        const ev = JSON.parse(line) as { type?: string; text?: string; error?: string; engine?: string };
        if (ev.type === "assistant") { reply = ev.text ?? ""; engine = ev.engine ?? engine; }
        else if (ev.type === "error") error = ev.error ?? "chat turn failed";
      } catch { /* not an event line */ }
    },
  });
  if (code !== 0) return { ok: false, error: error || "chat turn failed" };
  const [cli, ...rest] = engine.split(":");
  appendThreadMarkdown(req.vault, req.domain, req.session, [
    { role: "user", content: req.prompt },
    { role: "assistant", content: reply, cli, model: rest.join(":") || undefined },
  ]);
  return { ok: true, reply };
};

/** One guarded daemon pass: fire what is due, log outcomes, never throw and
 *  never block the daemon loop on a turn. */
export function runThreadSchedulesDue(vault: string, runner: ThreadTurnRunner = runScheduledThreadTurn): number {
  try {
    const { fired, done } = tickThreadSchedules(vault, runner);
    if (fired.length) {
      console.log(`[schedule] conversation schedules fired: ${fired.map((s) => s.name || s.id).join(", ")}`);
      void done.then(async (results) => {
        const { logActivity } = await import("./activity.ts");
        results.forEach((r, i) => {
          const s = fired[i]!;
          logActivity(vault, {
            type: "other", domain: s.thread?.domain, title: `Scheduled: ${s.name}`,
            detail: r.ok ? undefined : r.error, status: r.ok ? "ok" : "error", ref: s.id,
          });
        });
      }).catch(() => { /* logging is best effort */ });
    }
    return fired.length;
  } catch (e) {
    console.error(`[schedule] conversation schedules pass error: ${String(e).slice(0, 200)}`);
    return 0;
  }
}
