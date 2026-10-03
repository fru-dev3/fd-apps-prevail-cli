// Task ledger parity with the desktop (src-tauri/src/tasks.rs).
//
// Tasks live in <vault>/<domain>/_tasks.md as a markdown checklist where each line
// can carry end-of-line metadata tokens. Both processes read & write this file, so
// the parse/render here MUST stay byte-compatible with the Rust side:
//
//   - [ ] text @due +added ~source ~owner:ai ~status:doing ~id:abc1234
//
// Defaults: owner=me (only "ai" is persisted), status derived from the checkbox
// (todo/done implied by the box; only doing/review/blocked are written), id minted
// on first write. Workflows-Kanban (P0) uses owner=ai + status to drive the
// AI-task steward and the cross-domain Decision Inbox.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { vreadFile, vwriteFile } from "./vault-session.ts";

export interface Task {
  text: string;
  done: boolean;
  due?: string;
  added?: string;
  source?: string;
  owner?: string;  // "me" | "ai"
  status?: string; // "todo"|"doing"|"review"|"blocked"|"done"
  id?: string;
  trashed?: string; // YYYY-MM-DD soft-delete date; "~trashed:" token. Set = in Trash, not removed.
  priority?: string; // "high" | "critical"; "~priority:" token. Absent = normal.
  // A promise with a person attached (today-plan T0):
  //   ~kind:commitment ~to:person/<slug>    something the user said they would do for someone
  //   ~kind:waiting    ~from:person/<slug>  something someone owes the user
  // and ~src:<where it came from> (gmail:<thread-hash>, chat:<thread>, job:<id>).
  kind?: string;   // "commitment" | "waiting"
  to?: string;
  from?: string;
  // ~mission:<slug>: a domain-owned task that serves a mission (missions-plan.md).
  mission?: string;
  // The Compass chain (goals-plan.md G1b): ~initiative:<p-id> or ~goal:<g-id>, the line it moves.
  initiative?: string;
  goal?: string;
}

export const VALID_STATUS = ["todo", "doing", "review", "blocked", "done", "icebox"] as const;

function isYmd(s: string): boolean {
  return s.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(s);
}


// Short, stable, greppable id: base16 of wall-clock nanos (+ salt so a same-nanosecond
// batch doesn't collide), last 7 chars. Mirrors mint_id() in tasks.rs.
function mintId(salt: number): string {
  let nanos: bigint;
  try { nanos = process.hrtime.bigint() + BigInt(Date.now()) * 1_000_000n; }
  catch { nanos = BigInt(Date.now()) * 1_000_000n; }
  const n = nanos + BigInt(salt) * 2_654_435_761n;
  const s = n.toString(16);
  return s.slice(Math.max(0, s.length - 7));
}

// Strip trailing metadata tokens (any order, only at line end) off a task body.
function splitMeta(raw: string): { text: string; meta: Partial<Task> } {
  let text = raw.trim();
  const meta: Partial<Task> = {};
  for (;;) {
    const t = text.replace(/\s+$/, "");
    const idx = t.lastIndexOf(" ");
    if (idx < 0) break;
    const tail = t.slice(idx + 1);
    if (tail.startsWith("@") && isYmd(tail.slice(1))) { meta.due = tail.slice(1); text = t.slice(0, idx); continue; }
    if (tail.startsWith("+") && isYmd(tail.slice(1))) { meta.added = tail.slice(1); text = t.slice(0, idx); continue; }
    if (tail.startsWith("~")) {
      const rest = tail.slice(1);
      const colon = rest.indexOf(":");
      if (colon > 0) {
        const k = rest.slice(0, colon); const v = rest.slice(colon + 1);
        if (v) {
          let matched = true;
          if (k === "owner") meta.owner = v;
          else if (k === "status") meta.status = v;
          else if (k === "id") meta.id = v;
          else if (k === "src") meta.source = v;
          else if (k === "trashed") meta.trashed = v;
          else if (k === "priority") meta.priority = v;
          else if (k === "kind") meta.kind = v;
          else if (k === "to") meta.to = v;
          else if (k === "from") meta.from = v;
          else if (k === "mission") meta.mission = v;
          else if (k === "initiative") meta.initiative = v;
          else if (k === "goal") meta.goal = v;
          else matched = false;
          if (matched) { text = t.slice(0, idx); continue; }
        }
      } else if (rest && /^[a-zA-Z0-9]+$/.test(rest)) {
        meta.source = rest; text = t.slice(0, idx); continue;
      }
    }
    break;
  }
  return { text: text.trim(), meta };
}

export function effectiveStatus(t: Task): string {
  const s = (t.status || "").trim();
  if (VALID_STATUS.includes(s as (typeof VALID_STATUS)[number])) return s;
  return t.done ? "done" : "todo";
}

export function parseTasks(md: string): Task[] {
  const out: Task[] = [];
  for (const line of md.split("\n")) {
    const t = line.replace(/^\s+/, "");
    let done: boolean; let rest: string;
    if (t.startsWith("- [ ] ") || t.startsWith("- [] ")) { done = false; rest = t.slice(t.indexOf("] ") + 2); }
    else if (t.startsWith("- [x] ") || t.startsWith("- [X] ")) { done = true; rest = t.slice(t.indexOf("] ") + 2); }
    else continue;
    const { text, meta } = splitMeta(rest);
    out.push({ text, done, due: meta.due, added: meta.added, source: meta.source, owner: meta.owner, status: meta.status, id: meta.id, trashed: meta.trashed, priority: meta.priority, kind: meta.kind, to: meta.to, from: meta.from, mission: meta.mission, initiative: meta.initiative, goal: meta.goal });
  }
  return out;
}

// Fill defaults so every persisted task has an id + owner + consistent status.
function normalize(tasks: Task[]): void {
  tasks.forEach((t, i) => {
    if (!t.id) t.id = mintId(i);
    if (!t.owner) t.owner = "me";
    const st = effectiveStatus(t);
    if (st === "done") t.done = true;
    if (t.done) t.status = "done";
    else if (st === "done") t.status = "todo";
    else t.status = st;
  });
}

export function renderTasks(tasks: Task[]): string {
  let s = "# Tasks\n\n";
  for (const t of tasks) {
    let line = `- [${t.done ? "x" : " "}] ${t.text.trim()}`;
    if (t.due) line += ` @${t.due}`;
    if (t.added) line += ` +${t.added}`;
    // A plain word stays the legacy bare "~source"; anything else ("gmail:<hash>") is "~src:".
    if (t.source) line += /^[a-zA-Z0-9]+$/.test(t.source) ? ` ~${t.source}` : ` ~src:${t.source}`;
    if (t.owner === "ai") line += " ~owner:ai";
    if (t.status && ["doing", "review", "blocked", "icebox"].includes(t.status)) line += ` ~status:${t.status}`;
    if (t.id) line += ` ~id:${t.id}`;
    if (t.trashed) line += ` ~trashed:${t.trashed}`;
    if (t.priority && ["high", "critical"].includes(t.priority)) line += ` ~priority:${t.priority}`;
    if (t.kind === "commitment" || t.kind === "waiting") line += ` ~kind:${t.kind}`;
    if (t.to) line += ` ~to:${t.to}`;
    if (t.from) line += ` ~from:${t.from}`;
    if (t.mission) line += ` ~mission:${t.mission}`;
    if (t.initiative) line += ` ~initiative:${t.initiative}`;
    if (t.goal) line += ` ~goal:${t.goal}`;
    s += `${line}\n`;
  }
  return s;
}

/**
 * A domain's task board: memory/tasks.md on a v4 domain, _tasks.md on an older
 * one. An existing file wins, so a board is never split across the two.
 */
export function taskBoardPath(domainDir: string): string {
  const v4 = join(domainDir, "memory", "tasks.md");
  const flat = join(domainDir, "_tasks.md");
  if (existsSync(v4)) return v4;
  if (existsSync(flat)) return flat;
  return existsSync(join(domainDir, "memory")) ? v4 : flat;
}
function tasksFile(domainDir: string): string { return taskBoardPath(domainDir); }

export function readTasks(domainDir: string): Task[] {
  const f = tasksFile(domainDir);
  if (!existsSync(f)) return [];
  try { return parseTasks(vreadFile(f)); } catch { return []; }
}

export function writeTasks(domainDir: string, tasks: Task[]): void {
  normalize(tasks);
  vwriteFile(tasksFile(domainDir), renderTasks(tasks));
}

// Set a single task's status by id; re-reads fresh + writes the whole doc (so a
// concurrent desktop write isn't clobbered). Returns true if the id was found.
export function setTaskStatus(domainDir: string, id: string, status: string): boolean {
  const tasks = readTasks(domainDir);
  let found = false;
  for (const t of tasks) {
    if (t.id === id) { t.status = status; t.done = status === "done"; found = true; }
  }
  if (found) writeTasks(domainDir, tasks);
  return found;
}
