// Close-out: completing a mission files what it learned and produced back into
// the domains (missions-plan.md, "Close-out"). Two steps, both in code:
//
//   planCloseout   drafts every line from the mission's own records (the log,
//                  milestones, the ledger, memory.md, its files and tasks), each
//                  line on by default so the user previews and unticks.
//   applyCloseout  writes the lines the user kept, each with a receipt in
//                  memory/closeout-filed.jsonl, then marks the mission completed.
//
// Rules: nothing lands in a domain without the preview (apply takes the plan the
// user saw); the Compass is never written here; closing never deletes; every
// write can be undone for 7 days (undoCloseout), restoring the prior bytes.

import { routineDrafts } from "./mission-progress.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { appendJsonl, domainUpdatesPath, entityUpdatesPath, readJsonl } from "./linking.ts";
import {
  domainsWith, logLine, missionDir, missionView, ownerOf, readLedger, readLinks, readMission, serializeMission, writeLinks,
  type Mission, type MissionResult, RESULTS,
} from "./missions.ts";
import { resolveDomainDir } from "./path-safety.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";

export type FilingKind = "summary" | "lesson" | "note" | "money" | "person" | "file" | "task" | "routine";
export interface Filing { n: number; kind: FilingKind; domain: string; text: string; apply: boolean; ref?: string; action?: "move" | "drop" | "carry" }
export interface CloseoutPlan { slug: string; name: string; result: MissionResult; resultNote: string; summary: string; filings: Filing[] }
export interface CloseoutReceipt { n: number; ts: number; kind: FilingKind; domain: string; file: string; text: string; written: string; undone?: number; from?: string; at?: number }

const UNDO_DAYS = 7;
const DAY = 86_400_000;
const ymd = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const oneLine = (s: string, n = 300) => s.replace(/\s+/g, " ").replace(/\s*\u2014\s*/g, ", ").trim().slice(0, n);

function readText(p: string): string {
  if (!existsSync(p)) return "";
  try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } }
}
function writeText(p: string, t: string): void { mkdirSync(join(p, ".."), { recursive: true }); vwriteFile(p, t); }

const receiptsPath = (vault: string, slug: string) => join(missionDir(vault, slug), "memory", "closeout-filed.jsonl");
export function readReceipts(vault: string, slug: string): CloseoutReceipt[] { return readJsonl<CloseoutReceipt>(receiptsPath(vault, slug)); }

/** The domain that keeps money notes: an attached money or wealth domain, else one in the vault. */
function moneyDomain(vault: string, m: Mission): string | null {
  const attached = m.domains.map((d) => d.slug);
  const pick = (xs: string[]) => xs.find((d) => d === "money") ?? xs.find((d) => d === "wealth" || d === "finance");
  return pick(attached) ?? pick(listDomainDirs(vault)) ?? null;
}

/** Draft the close-out. Every line starts ticked; the user unticks what should not be filed. */
export function planCloseout(vault: string, ref: string, o: { result?: MissionResult; resultNote?: string; now?: number } = {}): CloseoutPlan {
  const now = o.now ?? Date.now();
  const v = missionView(vault, ref, now);
  if (!v) throw new Error(`no mission "${ref}"`);
  if (v.status === "completed" || v.status === "archived") throw new Error(`the mission is already ${v.status}`);
  const owner = ownerOf(v) ?? "general";
  const filings: Filing[] = [];
  const add = (f: Omit<Filing, "n" | "apply"> & { apply?: boolean }) => filings.push({ n: filings.length + 1, apply: f.apply ?? true, ...f });
  const p = v.progress;
  const result: MissionResult = o.result ?? (p.milestones.total && p.milestones.done === p.milestones.total ? "met" : "partly");
  const money = p.budget.used ? `, spent $${p.budget.used.toFixed(2)}${p.budget.planned ? ` of $${p.budget.planned.toFixed(2)}` : ""}` : "";
  const summary = oneLine(`${v.name} (${v.start} to ${ymd(now)}): ${result.replace("-", " ")}${o.resultNote ? `, "${o.resultNote}"` : ""}. Outcome: ${v.outcome || "none written"}. Milestones ${p.milestones.done} of ${p.milestones.total}${money}.${v.people.length ? ` People: ${v.people.join(", ")}.` : ""}`, 600);
  add({ kind: "summary", domain: owner, text: summary });
  // Lessons: what the mission wrote down as learned while it ran.
  const learned = readText(join(missionDir(vault, v.slug), "memory", "memory.md")).split("\n").map((l) => /^\s*-\s+(.*\S)/.exec(l)?.[1] ?? "").filter(Boolean).slice(0, 8);
  for (const l of learned) add({ kind: "lesson", domain: owner, text: oneLine(l, 240) });
  for (const d of [...domainsWith(v, "consulted"), ...domainsWith(v, "informed")]) {
    add({ kind: "note", domain: d, text: oneLine(`Mission ${v.name} completed (${result.replace("-", " ")}): ${v.outcome || v.name}.`, 240) });
  }
  const ledger = readLedger(vault, v.slug);
  const md = moneyDomain(vault, v);
  if (ledger.length && md) {
    const byLine = p.budget.byLine.filter((l) => l.used).map((l) => `${l.label} $${l.used.toFixed(2)} of $${l.planned.toFixed(2)}`);
    const other = ledger.filter((r) => !v.budget.lines.some((l) => l.id === r.line)).reduce((a, r) => a - r.usd, 0);
    add({ kind: "money", domain: md, text: oneLine(`Mission ${v.name}: spent $${p.budget.used.toFixed(2)}${p.budget.planned ? ` of $${p.budget.planned.toFixed(2)}` : ""}${byLine.length ? ` (${byLine.join("; ")}${other ? `; other $${other.toFixed(2)}` : ""})` : ""}. Refs: ${ledger.map((r) => r.ref).filter(Boolean).join(", ") || "none"}.`, 600) });
  }
  for (const id of v.people) add({ kind: "person", domain: id, text: oneLine(`Helped with the mission ${v.name} (${ymd(now)}).`, 200) });
  // Files the user added to the mission move to the owner domain's source/.
  const filesDir = join(missionDir(vault, v.slug), "files");
  if (existsSync(filesDir)) {
    for (const f of readdirSync(filesDir)) if (!f.startsWith(".")) add({ kind: "file", domain: owner, text: `files/${f}`, ref: f });
  }
  // Routines the mission built (MS4): drafted for the owner's Habits and routines, unticked until the user keeps them.
  for (const r of routineDrafts(vault, v.slug, now)) add({ kind: "routine", domain: owner, text: r, apply: false });
  // Open mission tasks: move to the owner's board by default.
  for (const l of readText(join(missionDir(vault, v.slug), "memory", "tasks.md")).split("\n")) {
    const t = /^\s*-\s+\[ \]\s+(.+)$/.exec(l);
    if (t) add({ kind: "task", domain: owner, text: t[1]!.trim(), action: "move" });
  }
  return { slug: v.slug, name: v.name, result, resultNote: o.resultNote ?? "", summary, filings };
}

/** Add a line under `## heading` (made at the end when missing). Returns exactly what was inserted, for Undo. */
function appendBlock(file: string, heading: string, block: string): string {
  const cur = readText(file);
  const m = new RegExp(`^##\\s+${heading}\\s*$\\n?`, "im").exec(cur);
  if (m) {
    const at = m.index + m[0].length;
    const ins = `${m[0].endsWith("\n") ? "" : "\n"}${block}\n`;
    writeText(file, cur.slice(0, at) + ins + cur.slice(at));
    return ins;
  }
  const ins = `${cur && !cur.endsWith("\n") ? "\n" : ""}${cur.trim() ? "\n" : ""}## ${heading}\n${block}\n`;
  writeText(file, cur + ins);
  return ins;
}

/**
 * File the lines the user kept and complete the mission. `plan` is what the
 * user saw (from planCloseout, with lines unticked or edited); nothing else is
 * written. Returns the receipts.
 */
export function applyCloseout(vault: string, plan: CloseoutPlan, now = Date.now()): { mission: Mission; receipts: CloseoutReceipt[] } {
  const m = readMission(vault, plan.slug);
  if (!m) throw new Error(`no mission "${plan.slug}"`);
  if (m.status === "completed" || m.status === "archived") throw new Error(`the mission is already ${m.status}`);
  if (!RESULTS.includes(plan.result)) throw new Error(`result must be ${RESULTS.join(", ")}`);
  const dir = missionDir(vault, m.slug);
  const known = new Set(listDomainDirs(vault));
  const rows: CloseoutReceipt[] = readReceipts(vault, m.slug);
  const rel = (p: string) => relative(vault, p);
  const rec = (r: Omit<CloseoutReceipt, "n" | "ts">) => { const row = { n: rows.length + 1, ts: now, ...r }; rows.push(row); return row; };
  const link = `data/missions/${m.slug}/closeout.md`;
  for (const f of plan.filings) {
    if (!f.apply) continue;
    const text = oneLine(f.text, 600);
    if (f.kind === "person") {
      const p = entityUpdatesPath(vault, f.domain);
      if (!p) continue;
      const row = { ts: now, from_domain: `mission/${m.slug}`, thread: `closeout:${m.slug}`, fact: text };
      appendJsonl(p, row);
      rec({ kind: f.kind, domain: f.domain, file: rel(p), text, written: JSON.stringify(row) });
      continue;
    }
    if (!known.has(f.domain)) continue; // only real domains receive filings
    const ddir = resolveDomainDir(vault, f.domain);
    if (f.kind === "summary" || f.kind === "lesson") {
      const file = join(ddir, "memory", "memory.md");
      const block = f.kind === "summary" ? `- ${ymd(now)} ${text} (close-out: ${link})` : `- ${ymd(now)} Lesson from ${m.name}: ${text}`;
      rec({ kind: f.kind, domain: f.domain, file: rel(file), text, written: appendBlock(file, "Missions", block) });
    } else if (f.kind === "note" || f.kind === "money") {
      const p = domainUpdatesPath(vault, f.domain);
      const row = { ts: now, from_domain: `mission/${m.slug}`, thread: `closeout:${m.slug}`, fact: text, entities: [] as string[] };
      appendJsonl(p, row);
      rec({ kind: f.kind, domain: f.domain, file: rel(p), text, written: JSON.stringify(row) });
    } else if (f.kind === "routine") {
      const file = join(ddir, "ideal-state.md");
      rec({ kind: f.kind, domain: f.domain, file: rel(file), text, written: appendBlock(file, "Habits and routines", `- ${text} (from the mission ${m.name})`) });
    } else if (f.kind === "file" && f.ref) {
      const from = join(dir, "files", basename(f.ref));
      if (!existsSync(from)) continue;
      let to = join(ddir, "source", "missions", m.slug, basename(f.ref));
      for (let i = 2; existsSync(to); i++) to = join(ddir, "source", "missions", m.slug, `${i}-${basename(f.ref)}`);
      mkdirSync(join(to, ".."), { recursive: true });
      renameSync(from, to);
      const l = readLinks(vault, m.slug);
      l.files.push({ domain: f.domain, path: relative(ddir, to) });
      writeLinks(vault, m.slug, l);
      rec({ kind: f.kind, domain: f.domain, file: rel(to), text: `moved files/${basename(f.ref)}`, written: "", from: rel(from) });
    } else if (f.kind === "task") {
      const board = join(dir, "memory", "tasks.md");
      const cur = readText(board);
      const line = cur.split("\n").find((l) => l.includes(f.text) && /^\s*-\s+\[ \]/.test(l));
      if (!line) continue;
      if (f.action === "carry") continue; // stays open in the mission; a follow-up mission picks it up
      if (f.action === "drop") {
        writeText(board, cur.replace(line, line.replace("- [ ]", "- [x]") + " ~status:dropped"));
        rec({ kind: f.kind, domain: m.id, file: rel(board), text: `dropped: ${text}`, written: line });
        continue;
      }
      const target = existsSync(join(ddir, "memory")) ? join(ddir, "memory", "tasks.md") : join(ddir, "_tasks.md");
      const moved = `${line.trim()}${/~mission:/.test(line) ? "" : ` ~mission:${m.slug}`}`;
      const tcur = readText(target);
      writeText(target, `${tcur ? tcur.replace(/\s*$/, "\n") : "# Tasks\n\n"}${moved}\n`);
      // Where the line sat on the mission's board, so Undo puts it back there.
      const lines = cur.split("\n");
      const at = lines.indexOf(line);
      lines.splice(at, 1);
      writeText(board, lines.join("\n"));
      rec({ kind: f.kind, domain: f.domain, file: rel(target), text: `moved: ${text}`, written: moved, from: line, at });
    }
  }
  writeFileSync(receiptsPath(vault, m.slug), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  // The close-out page, then the status. Loops stop; nothing is deleted.
  const v = missionView(vault, m.slug, now)!;
  writeText(join(dir, "closeout.md"), [
    `# Close-out: ${m.name}`, "", `Completed ${ymd(now)}. Result: ${plan.result.replace("-", " ")}${plan.resultNote ? `, "${plan.resultNote}"` : ""}.`, "",
    `## Summary`, plan.summary, "",
    `## Milestones`, ...v.milestones.map((x) => `- [${x.done ? "x" : " "}] ${x.title}${x.doneOn ? ` (${x.doneOn})` : ""}`), "",
    `## Money`, v.progress.budget.planned || v.progress.budget.used ? `Spent $${v.progress.budget.used.toFixed(2)}${v.progress.budget.planned ? ` of $${v.progress.budget.planned.toFixed(2)}` : ""}.` : "No money recorded.", "",
    `## Filed`, ...rows.filter((r) => !r.undone).map((r) => `- ${r.domain}: ${r.text} (${r.file})`), "",
  ].join("\n"));
  const loops = join(dir, "_loops.json");
  if (existsSync(loops)) {
    try {
      const j = JSON.parse(readText(loops)) as { loops?: { enabled?: boolean }[] } | { enabled?: boolean }[];
      const arr = Array.isArray(j) ? j : j.loops ?? [];
      for (const l of arr) l.enabled = false;
      writeText(loops, `${JSON.stringify(j, null, 2)}\n`);
    } catch { /* a broken loops file stays as it is */ }
  }
  m.status = "completed";
  m.completed = ymd(now);
  m.result = plan.result;
  m.updated = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  writeText(join(dir, "mission.md"), serializeMission(m));
  logLine(vault, m.slug, `Completed (${plan.result}). ${rows.filter((r) => r.ts === now).length} line(s) filed to the domains.`, now);
  return { mission: m, receipts: rows.filter((r) => r.ts === now) };
}

/** Undo one close-out write (within 7 days): the exact text written comes back out. */
export function undoCloseout(vault: string, ref: string, n: number, now = Date.now()): CloseoutReceipt {
  const m = readMission(vault, ref);
  if (!m) throw new Error(`no mission "${ref}"`);
  const rows = readReceipts(vault, m.slug);
  const r = rows.find((x) => x.n === n);
  if (!r) throw new Error(`no filed line ${n}`);
  if (r.undone) return r;
  if (now - r.ts > UNDO_DAYS * DAY) throw new Error(`Undo is kept for ${UNDO_DAYS} days; this line was filed on ${ymd(r.ts)}`);
  const abs = join(vault, r.file);
  if (r.kind === "file" && r.from) {
    if (existsSync(abs)) { mkdirSync(join(vault, r.from, ".."), { recursive: true }); renameSync(abs, join(vault, r.from)); }
    const l = readLinks(vault, m.slug);
    l.files = l.files.filter((f) => !r.file.endsWith(f.path));
    writeLinks(vault, m.slug, l);
  } else if (r.kind === "task") {
    const cur = readText(abs);
    if (r.text.startsWith("dropped: ")) writeText(abs, cur.replace(`${r.written.replace("- [ ]", "- [x]")} ~status:dropped`, r.written));
    else {
      // The domain board loses exactly the line added (the last copy of it).
      const dl = cur.split("\n");
      const i = dl.map((l) => l.trim()).lastIndexOf(r.written.trim());
      if (i >= 0) { dl.splice(i, 1); writeText(abs, dl.join("\n")); }
      const board = join(missionDir(vault, m.slug), "memory", "tasks.md");
      const bl = (readText(board) || "# Tasks\n\n").split("\n");
      bl.splice(r.at != null && r.at >= 0 && r.at <= bl.length ? r.at : bl.length, 0, r.from ?? r.written);
      writeText(board, bl.join("\n"));
    }
  } else if (r.file.endsWith(".jsonl")) {
    const cur = readText(abs);
    writeText(abs, cur.split("\n").filter((l) => l !== r.written).join("\n"));
  } else {
    // The exact text inserted comes back out (newest first, so stacked lines unwind).
    const cur = readText(abs);
    const at = cur.lastIndexOf(r.written);
    if (at >= 0) writeText(abs, cur.slice(0, at) + cur.slice(at + r.written.length));
  }
  r.undone = now;
  writeFileSync(receiptsPath(vault, m.slug), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  logLine(vault, m.slug, `Undid a close-out line: ${r.text}`, now);
  return r;
}
