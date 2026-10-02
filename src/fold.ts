// Fold the coordinator domains into General, the chief of staff's home.
//
// Early vaults were seeded with domains that coordinate the others instead of
// covering an area of life: Chief (the cross-domain brief, a status page, the
// app index and the brand standard), Vision (purpose, values, reviews) and
// Intel (a news brief). The chief of staff plus playbooks replace them. Their
// memory, loops and tasks move first; then each folded domain is archived
// (moved to data/domains/_archive/<d>, with a tar.gz backup) and nothing is
// deleted.
//
//   prevail fold plan  [--routes F] --json   what would move, nothing written
//   prevail fold apply [--routes F] --json   do it; a receipt lands in
//                                            general/memory/fold-<date>.md
//
// Default placement is General. A routes file (JSON) sends pieces elsewhere:
//   { "loops": { "<d>/<loop-id>": { "to": "general" | "<domain>" | null,
//                 "id"?, "playbook"?, "enabled"?, "autonomy"?, "kind"?,
//                 "cadence"?, "name"?, "purpose"?, "note"? } },
//     "tasks": [ { "from": "<d>", "match": "<text in the task>", "to": "<domain>" } ],
//     "files": { "<d>/<path in the domain>": "<domain>/<path>" } }
// A loop routed to null is not carried over (its definition stays in the
// archive; the note says what replaces it).
//
// Idempotent: a domain already archived is skipped, a copied file that exists
// with the same text is not copied twice, a moved task or loop already present
// is not added again.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { resolveDomainDir } from "./path-safety.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { parseModArgs } from "./cli-args.ts";

export const FOLDABLE = ["chief", "vision", "intel"] as const;
export const HOME = "general";

export interface LoopRoute { to: string | null; id?: string; playbook?: string; enabled?: boolean; autonomy?: string; kind?: string; cadence?: string; name?: string; purpose?: string; note?: string }
export interface Routes {
  loops?: Record<string, LoopRoute>;
  tasks?: { from: string; match: string; to: string }[];
  files?: Record<string, string>;
}

export interface FileMove { from: string; to: string; how: "copy" | "append" | "goals" | "jsonl" }
export interface LoopMove { from: string; id: string; to: string | null; newId: string; enabled: boolean; playbook?: string; note?: string; set?: Record<string, string> }
export interface TaskMove { from: string; to: string; line: string }
export interface DomainFold { domain: string; files: FileMove[]; loops: LoopMove[]; tasks: TaskMove[]; threads: string[] }
export interface FoldPlan { date: string; home: string; domains: DomainFold[]; skipped: { domain: string; reason: string }[] }

const today = (now: number) => new Date(now).toISOString().slice(0, 10);
const TEXT = new Set([".md", ".sh", ".py", ".html", ".css", ".json", ".txt", ".yml", ".yaml", ".js", ".ts", ".csv"]);
const APPEND = new Set(["memory/memory.md", "memory/key-facts.md", "memory/key-dates.md", "memory/open-loops.md", "memory/decisions.md"]);
// Canonical, machine-managed or board files: they stay in the archived domain.
const KEEP_IN_ARCHIVE = /^(manifest\.json|ideal-state\.md|_loops\.json|_loops_runtime.*|_tasks.*|\.prevail-layout-v4|_journal.*|_log\/.*|\.system\/.*|memory\/threads\/.*|memory\/tasks.*|memory\/state.*|memory\/manifest\.json|memory\/goals\.md.*|memory\/.*\.(bak|pre-[^/]*)|memory\/[^/]*\.pre-[^/]*\.md|ideal-state\.versions\/.*)$/;
// Junk, and backups (a .bak or .pre-<tag> copy stays with the archived original).
const JUNK = /(^|\/)(\.DS_Store|__pycache__\/.*|[^/]*\.pyc|[^/]*\.bak(\.[^/]*)?|[^/]*\.pre-[^/]*)$/;

function readText(p: string): string {
  try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } }
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  let es: string[] = [];
  try { es = readdirSync(dir); } catch { return out; }
  for (const e of es) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
}

/** Where a file of folded domain `d` lands in General (relative to data/domains). */
export function placeFile(d: string, rel: string, routes: Routes = {}): FileMove | null {
  if (JUNK.test(rel) || KEEP_IN_ARCHIVE.test(rel)) return null;
  const routed = routes.files?.[`${d}/${rel}`];
  if (routed) return { from: `${d}/${rel}`, to: routed, how: "copy" };
  if (rel === "source/goals.md") return { from: `${d}/${rel}`, to: `${HOME}/source/goals.md`, how: "goals" };
  if (rel === "memory/decisions.jsonl") return { from: `${d}/${rel}`, to: `${HOME}/memory/decisions.jsonl`, how: "jsonl" };
  if (APPEND.has(rel)) return { from: `${d}/${rel}`, to: `${HOME}/${rel}`, how: "append" };
  if (rel === "source/config.md") return { from: `${d}/${rel}`, to: `${HOME}/source/${d}-config.md`, how: "copy" };
  if (rel.startsWith("source/")) return { from: `${d}/${rel}`, to: `${HOME}/${rel}`, how: "copy" };
  if (rel.startsWith("memory/skills/")) return { from: `${d}/${rel}`, to: `${HOME}/${rel}`, how: "copy" };
  if (rel.startsWith("memory/")) return { from: `${d}/${rel}`, to: `${HOME}/memory/folded/${d}/${rel.slice(7)}`, how: "copy" };
  if (!rel.includes("/")) return { from: `${d}/${rel}`, to: `${HOME}/source/${rel}`, how: "copy" };
  return { from: `${d}/${rel}`, to: `${HOME}/memory/folded/${d}/${rel}`, how: "copy" };
}

/**
 * Point paths that named a folded domain's files at their new home, so a
 * moved script or skill keeps working: "chief/source/x" becomes
 * "general/source/x", "intel/memory/briefs" becomes
 * "general/memory/folded/intel/briefs".
 */
export function rewritePaths(text: string, d: string): string {
  const b = "(^|[^A-Za-z0-9_.-])";
  const sub = (re: string, to: string) => { text = text.replace(new RegExp(`${b}${d}/${re}`, "g"), (_m, pre: string) => `${pre}${to}`); };
  sub("source/", `${HOME}/source/`);
  sub("memory/skills/", `${HOME}/memory/skills/`);
  sub("memory/tasks\\.md", `${HOME}/memory/tasks.md`);
  for (const f of ["memory.md", "key-facts.md", "key-dates.md", "open-loops.md", "decisions.md", "decisions.jsonl"]) sub(`memory/${f.replace(".", "\\.")}`, `${HOME}/memory/${f}`);
  sub("memory/", `${HOME}/memory/folded/${d}/`);
  sub("_loops\\.json", `${HOME}/_loops.json`);
  text = text.replace(new RegExp(`domains/${d}(?=[/"'\`\\s)]|$)`, "gm"), `domains/${HOME}`);
  return text;
}

interface LoopDef { id: string; [k: string]: unknown }
function readLoops(dir: string): { desiredState?: string; loops: LoopDef[] } {
  try { const j = JSON.parse(readText(join(dir, "_loops.json"))); return { ...j, loops: Array.isArray(j.loops) ? j.loops : [] }; } catch { return { loops: [] }; }
}

// The task board: memory/tasks.md where the domain has a memory/ folder (the
// app grooms the board there), else _tasks.md at its root.
function boardFile(dir: string): string {
  if (existsSync(join(dir, "memory", "tasks.md")) || existsSync(join(dir, "memory"))) return join(dir, "memory", "tasks.md");
  return join(dir, "_tasks.md");
}

const taskText = (line: string) => line.replace(/^- \[[ xX]\]\s+/, "").replace(/\s+[@+~]\S+/g, "").trim().toLowerCase();

/** What folding would do. Reads only. */
export function planFold(vault: string, routes: Routes = {}, now = Date.now(), only: readonly string[] = FOLDABLE): FoldPlan {
  const plan: FoldPlan = { date: today(now), home: HOME, domains: [], skipped: [] };
  const live = new Set(listDomainDirs(vault));
  const homeDir = resolveDomainDir(vault, HOME);
  const homeLoops = new Set(readLoops(homeDir).loops.map((l) => l.id));
  for (const d of only) {
    if (!live.has(d)) { plan.skipped.push({ domain: d, reason: "not a live domain (absent or already archived)" }); continue; }
    const dir = resolveDomainDir(vault, d);
    const f: DomainFold = { domain: d, files: [], loops: [], tasks: [], threads: [] };
    for (const rel of walk(dir).sort()) {
      const m = placeFile(d, rel, routes);
      if (m) f.files.push(m);
    }
    for (const l of readLoops(dir).loops) {
      const r = routes.loops?.[`${d}/${l.id}`];
      const to = r ? r.to : HOME;
      let newId = r?.id ?? l.id;
      if (to === HOME && homeLoops.has(newId) && !r?.id) newId = `${d}-${l.id}`;
      const set: Record<string, string> = {};
      for (const k of ["name", "purpose", "kind", "cadence", "autonomy"] as const) if (r?.[k]) set[k] = r[k]!;
      f.loops.push({ from: d, id: l.id, to, newId, enabled: r?.enabled ?? l.enabled !== false, ...(r?.playbook ? { playbook: r.playbook } : {}), ...(r?.note ? { note: r.note } : {}), ...(Object.keys(set).length ? { set } : {}) });
    }
    const board = readText(boardFile(dir));
    for (const line of board.split("\n")) {
      if (!/^- \[ \]\s+\S/.test(line)) continue; // open tasks move; done ones stay in the archive
      const r = routes.tasks?.find((t) => t.from === d && line.toLowerCase().includes(t.match.toLowerCase()));
      f.tasks.push({ from: d, to: r?.to ?? HOME, line });
    }
    try { f.threads = readdirSync(join(dir, "memory", "threads")).filter((n) => n.endsWith(".md") || n.endsWith(".jsonl")); } catch { /* none */ }
    plan.domains.push(f);
  }
  return plan;
}

function backup(p: string, date: string): void {
  if (!existsSync(p)) return;
  let b = `${p}.pre-fold-${date}`;
  for (let n = 2; existsSync(b); n++) b = `${p}.pre-fold-${date}-${n}`;
  copyFileSync(p, b);
}

export interface FoldReceipt { plan: FoldPlan; written: string[]; archived: { domain: string; to: string; backup: string }[]; receipt: string }

/**
 * Carry out a plan: copy and append files, move loops and open tasks, copy
 * threads, then archive each folded domain. Every General file that changes
 * keeps a .pre-fold-<date> copy beside it first.
 */
export async function applyFold(vault: string, plan: FoldPlan): Promise<FoldReceipt> {
  const domainsRoot = dirname(resolveDomainDir(vault, HOME));
  const abs = (rel: string) => join(domainsRoot, rel);
  const written: string[] = [];
  const backedUp = new Set<string>();
  const touch = (p: string) => { if (!backedUp.has(p)) { backup(p, plan.date); backedUp.add(p); } };
  const write = (p: string, text: string) => { touch(p); mkdirSync(dirname(p), { recursive: true }); vwriteFile(p, text); written.push(relative(domainsRoot, p)); };

  for (const f of plan.domains) {
    const d = f.domain;
    const label = d.charAt(0).toUpperCase() + d.slice(1);
    for (const m of f.files) {
      const src = abs(m.from);
      let dst = abs(m.to);
      const isText = TEXT.has(extname(src).toLowerCase());
      if (m.how === "copy") {
        if (existsSync(dst)) {
          const same = isText ? readText(dst) === rewritePaths(readText(src), d) : statSync(dst).size === statSync(src).size;
          if (same) continue;
          dst = join(dirname(dst), `${d}-${dst.slice(dirname(dst).length + 1)}`);
          if (existsSync(dst)) continue;
        }
        mkdirSync(dirname(dst), { recursive: true });
        if (isText) { vwriteFile(dst, rewritePaths(readText(src), d)); }
        else copyFileSync(src, dst);
        written.push(relative(domainsRoot, dst));
      } else if (m.how === "append") {
        const body = rewritePaths(readText(src), d).trim();
        if (!body) continue;
        const marker = `## Folded from ${label} (${plan.date})`;
        const cur = existsSync(dst) ? readText(dst) : "";
        if (cur.includes(marker)) continue;
        write(dst, `${cur.replace(/\s*$/, "")}${cur.trim() ? "\n\n" : ""}${marker}\n\n${body.replace(/^# .*\n+/, "")}\n`);
      } else if (m.how === "goals") {
        const cur = existsSync(dst) ? readText(dst) : "# general goals\n";
        const have = new Set([...cur.matchAll(/~id:(\S+)/g)].map((x) => x[1]));
        const add = readText(src).split("\n").filter((l) => /^- \[[ xX]\]\s/.test(l)).filter((l) => { const id = l.match(/~id:(\S+)/)?.[1]; return !id || !have.has(id); });
        if (add.length) write(dst, `${cur.replace(/\s*$/, "")}\n${add.join("\n")}\n`);
      } else {
        const cur = existsSync(dst) ? readText(dst) : "";
        if (cur.includes(`"folded_from":"${d}"`)) continue;
        const lines = readText(src).split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.stringify({ ...JSON.parse(l), folded_from: d })]; } catch { return []; } });
        if (lines.length) write(dst, `${cur.replace(/\s*$/, "")}${cur.trim() ? "\n" : ""}${lines.join("\n")}\n`);
      }
    }

    // Loops: carried into their new domain's _loops.json, marked where they came from.
    const src = readLoops(resolveDomainDir(vault, d));
    const byTarget = new Map<string, LoopMove[]>();
    for (const l of f.loops) if (l.to) byTarget.set(l.to, [...(byTarget.get(l.to) ?? []), l]);
    for (const [to, moves] of byTarget) {
      const dir = resolveDomainDir(vault, to);
      const p = join(dir, "_loops.json");
      const doc = existsSync(p) ? readLoops(dir) : { loops: [] as LoopDef[] };
      const have = new Set(doc.loops.map((l) => l.id));
      let changed = false;
      for (const mv of moves) {
        if (have.has(mv.newId)) continue;
        const orig = src.loops.find((l) => l.id === mv.id);
        if (!orig) continue;
        const next: LoopDef = { ...orig, ...(mv.set ?? {}), id: mv.newId, enabled: mv.enabled, foldedFrom: `${d}/${mv.id}` };
        if (mv.playbook) next.playbook = mv.playbook;
        next.status = mv.enabled ? "active" : "staged";
        doc.loops.push(next);
        have.add(mv.newId);
        changed = true;
      }
      if (changed) write(p, `${JSON.stringify(doc, null, 2)}\n`);
    }

    // Open tasks: appended to their owner's board, once.
    const byBoard = new Map<string, TaskMove[]>();
    for (const t of f.tasks) byBoard.set(t.to, [...(byBoard.get(t.to) ?? []), t]);
    for (const [to, tasks] of byBoard) {
      const p = boardFile(resolveDomainDir(vault, to));
      const cur = existsSync(p) ? readText(p) : "# Tasks\n";
      const have = new Set(cur.split("\n").filter((l) => /^- \[[ xX]\]\s/.test(l)).map(taskText));
      const add = tasks.filter((t) => !have.has(taskText(t.line))).map((t) => rewritePaths(t.line, d));
      if (add.length) write(p, `${cur.replace(/\s*$/, "")}\n\n<!-- moved from ${d} when it folded into ${HOME}, ${plan.date} -->\n${add.join("\n")}\n`);
    }

    // Threads: copied into General's (a name already there gets the domain prefix).
    const tdir = join(resolveDomainDir(vault, HOME), "memory", "threads");
    for (const t of f.threads) {
      const from = join(resolveDomainDir(vault, d), "memory", "threads", t);
      let to = join(tdir, t);
      if (existsSync(to)) { if (statSync(to).size === statSync(from).size) continue; to = join(tdir, `${d}-${t}`); if (existsSync(to)) continue; }
      mkdirSync(tdir, { recursive: true });
      copyFileSync(from, to);
      written.push(relative(domainsRoot, to));
    }
  }

  // Then archive each folded domain (tar.gz backup first, then moved).
  const archived: FoldReceipt["archived"] = [];
  const { archiveDomain } = await import("./vault-ops.ts");
  for (const f of plan.domains) {
    const r = await archiveDomain(vault, f.domain);
    archived.push({ domain: f.domain, to: r.to, backup: r.backup.archivePath });
  }

  const receiptPath = join(resolveDomainDir(vault, HOME), "memory", `fold-${plan.date}.md`);
  const lines = [`# Fold receipt, ${plan.date}`, "", `${plan.domains.map((f) => f.domain).join(", ") || "Nothing"} folded into ${HOME}. Nothing was deleted: each domain is archived as it was, and every changed file keeps a .pre-fold-${plan.date} copy.`, ""];
  for (const f of plan.domains) {
    const a = archived.find((x) => x.domain === f.domain);
    lines.push(`## ${f.domain}`, "", `Archived to ${a ? relative(domainsRoot, a.to) : "(not archived)"}${a ? `, backup ${a.backup}` : ""}.`, "");
    if (f.loops.length) { lines.push("Loops:"); for (const l of f.loops) lines.push(`- ${l.id}: ${l.to ? `${l.to}/${l.newId}${l.playbook ? ` (playbook ${l.playbook})` : ""}${l.enabled ? "" : ", off"}` : "not carried over"}${l.note ? `. ${l.note}` : ""}`); lines.push(""); }
    if (f.tasks.length) { lines.push("Open tasks:"); for (const t of f.tasks) lines.push(`- to ${t.to}: ${t.line.replace(/^- \[ \]\s+/, "").slice(0, 120)}`); lines.push(""); }
    const files = f.files.filter((m) => m.how === "copy").length;
    lines.push(`Files: ${files} copied, ${f.files.length - files} merged into General's memory, goals and decisions.`, "");
  }
  writeFileSync(receiptPath, `${lines.join("\n")}\n`);
  written.push(relative(domainsRoot, receiptPath));
  return { plan, written, archived, receipt: receiptPath };
}

export async function foldCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "plan";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  let routes: Routes = {};
  const rp = args.get("routes");
  if (rp) {
    try { routes = JSON.parse(readFileSync(rp, "utf8")) as Routes; } catch (e) { console.error(`routes: ${(e as Error).message}`); return 1; }
  }
  const only = args.get("domains")?.split(",").map((s) => s.trim()).filter((s) => (FOLDABLE as readonly string[]).includes(s));
  const plan = planFold(vault, routes, Date.now(), only?.length ? only : FOLDABLE);
  if (sub === "plan") {
    if (args.json) out(plan);
    else for (const f of plan.domains) console.log(`${f.domain}: ${f.files.length} files, ${f.loops.length} loops, ${f.tasks.length} open tasks, ${f.threads.length} thread files`);
    return 0;
  }
  if (sub === "apply") {
    const r = await applyFold(vault, plan);
    if (args.json) out({ ok: true, archived: r.archived, written: r.written.length, receipt: r.receipt, skipped: plan.skipped });
    else console.log(`Folded ${r.archived.map((a) => a.domain).join(", ") || "nothing"}; receipt ${r.receipt}`);
    return 0;
  }
  console.error("usage: prevail fold plan|apply [--routes F] [--domains a,b] [--json]");
  return 1;
}
