// Apps A5, said vs used for tools: general/source/tool-stack.md is the user's
// stated stack and stays the source of truth. Once a month code compares it
// with what is observed (the stack: active days, health) and drafts a diff:
//   - in use, not listed: an app on 3 or more days in the last 30
//   - listed, unused: a listed tool whose app has a usage signal and 0 days
//   - status: a listed tool the doctor finds signed out or ineligible
// The diff is a page (general/memory/reviews/tool-stack-diff-<YYYY-MM>.md)
// and build/_meta/apps/tool-stack-diff.json. Nothing changes until the user
// accepts it: then tool-stack.md is kept as tool-stack.md.pre-diff-<date>,
// status cells are updated in place, unused tools are marked, new tools go
// in a "## Added from use" table, and a task asks for the HTML views (the
// user's own pages made from this file) to be regenerated.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { productDir, resolveDomainDir, runtimePath } from "./path-safety.ts";
import { parseModArgs } from "./cli-args.ts";

export interface ListedTool { tool: string; keys: string[]; status: string; line: number; section: string }
export interface DiffItem { kind: "missing" | "unused" | "status"; tool: string; detail: string; proposed: string; line?: number }
export interface StackDiff { month: string; items: DiffItem[]; accepted?: number }

const norm = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
export const toolStackPath = (vault: string) => join(resolveDomainDir(vault, "general"), "source", "tool-stack.md");
const diffJson = (vault: string) => join(runtimePath(vault, "_meta"), "apps", "tool-stack-diff.json");

/** Every tool row in the stated stack's tables: "| Tool | Role | Status |". */
export function parseToolStack(text: string): ListedTool[] {
  const out: ListedTool[] = [];
  let section = "";
  text.split("\n").forEach((l, i) => {
    const h = /^##\s+(.+)$/.exec(l);
    if (h) { section = h[1]!.trim(); return; }
    const cells = /^\|(.+)\|\s*$/.exec(l)?.[1]?.split("|").map((c) => c.trim());
    if (!cells || cells.length < 3 || /^-+$/.test(cells[0]!.replace(/[:\s]/g, "")) || cells[0]!.toLowerCase() === "tool") return;
    const tool = cells[0]!.replace(/\*\*/g, "");
    const keys = tool.split(/\s*(?:,|\+|\/|\band\b)\s*/).map(norm).filter((k) => k.length >= 2);
    out.push({ tool, keys: keys.length ? keys : [norm(tool)], status: cells[cells.length - 1]!, line: i, section });
  });
  return out;
}

interface Seen { id: string; name: string; days: number | null; health: string | null; aka?: string[]; category?: string }

// Consumer sites are not tools: shopping, social, news, travel and music use
// never counts as "in use, not listed" (the stated stack is about tools).
const NOT_TOOLS = new Set(["shopping", "social", "news", "travel", "music", "entertainment"]);

/** Does a listed tool name an observed app? Exact words, or a whole-word match of four letters or more. */
function matches(t: ListedTool, a: Seen): boolean {
  const names = [norm(a.name), norm(a.id.replace(/-/g, " ")), ...(a.aka ?? []).map(norm)].filter(Boolean);
  return t.keys.some((k) => names.some((n) => n === k || (k.length >= 4 && new RegExp(`\\b${k}\\b`).test(n)) || (n.length >= 4 && new RegExp(`\\b${n}\\b`).test(k))));
}

export function diffStack(listed: ListedTool[], seen: Seen[], month: string): StackDiff {
  const items: DiffItem[] = [];
  for (const a of seen) {
    if ((a.days ?? 0) >= 3 && !NOT_TOOLS.has(a.category ?? "") && !listed.some((t) => matches(t, a))) items.push({ kind: "missing", tool: a.name, detail: `used on ${a.days} of the last 30 days, not in your stack`, proposed: `add ${a.name}` });
  }
  for (const t of listed) {
    const a = seen.find((x) => matches(t, x));
    if (!a) continue;
    if (a.days === 0 && !/unused/i.test(t.status)) items.push({ kind: "unused", tool: t.tool, detail: "listed, no use in the last 30 days", proposed: `mark ${t.tool} unused`, line: t.line });
    // Only a row that claims a live connection can be contradicted by the doctor.
    if ((a.health === "auth_expired" || a.health === "ineligible") && /\bconnected\b/i.test(t.status) && !/(expired|sign-?in|ineligible)/i.test(t.status)) {
      const word = a.health === "ineligible" ? "ineligible" : "needs sign-in";
      items.push({ kind: "status", tool: t.tool, detail: `the doctor finds it ${word.replace("needs ", "needing ")}`, proposed: `${t.status} to ${word}`, line: t.line });
    }
  }
  return { month, items };
}

/** This month's diff from the stated stack and the observed one (code, no model). */
export async function computeStackDiff(vault: string, now = Date.now()): Promise<StackDiff | null> {
  const p = toolStackPath(vault);
  if (!existsSync(p)) return null;
  const { buildStack } = await import("./app-doctor.ts");
  const s = buildStack(vault, { now });
  // An app is also known by its sites and bundles (claude.ai, chatgpt.com, linkedin.com).
  const aka = (id: string): string[] => {
    try {
      const m = JSON.parse(readFileSync(join(productDir(vault, id), "manifest.json"), "utf8")) as { identifiers?: { domains?: string[] }; aliases?: string[] };
      return [...(m.aliases ?? []), ...(m.identifiers?.domains ?? []).map((d) => d.replace(/\.(com|ai|io|tech|app|org|net|dev|co)$/, "").replace(/^www\./, ""))];
    } catch { return []; }
  };
  const seen: Seen[] = s.apps.map((a) => ({ id: a.id, name: a.name, days: a.usage ? a.usage.active_days.d30 : null, health: a.health, aka: aka(a.id), category: a.category }));
  return diffStack(parseToolStack(readFileSync(p, "utf8")), seen, new Date(now).toISOString().slice(0, 7));
}

export function diffMarkdown(d: StackDiff): string {
  const sec = (k: DiffItem["kind"], title: string) => { const xs = d.items.filter((i) => i.kind === k); return xs.length ? [`## ${title}`, ...xs.map((i) => `- ${i.tool}: ${i.detail}`), ""] : []; };
  return [`# Your tool stack, said vs used, ${d.month}`, "", d.items.length ? `${d.items.length} change${d.items.length === 1 ? "" : "s"} proposed to tool-stack.md. Nothing changes until you accept.` : "Your stated stack matches what you use.", "",
    ...sec("missing", "In use, not listed"), ...sec("unused", "Listed, not used in 30 days"), ...sec("status", "Status changes")].join("\n");
}

export async function writeStackDiff(vault: string, now = Date.now()): Promise<{ diff: StackDiff; page: string } | null> {
  const d = await computeStackDiff(vault, now);
  if (!d) return null;
  const page = join(resolveDomainDir(vault, "general"), "memory", "reviews", `tool-stack-diff-${d.month}.md`);
  mkdirSync(join(page, ".."), { recursive: true });
  writeFileSync(page, diffMarkdown(d));
  mkdirSync(join(diffJson(vault), ".."), { recursive: true });
  writeFileSync(diffJson(vault), `${JSON.stringify(d, null, 2)}\n`);
  return { diff: d, page };
}

export function readStackDiff(vault: string): StackDiff | null {
  try { return JSON.parse(readFileSync(diffJson(vault), "utf8")) as StackDiff; } catch { return null; }
}

/** Accept the diff in one tap: the prior file is kept, the stated stack updated, a task filed for the HTML views. */
export function acceptStackDiff(vault: string, now = Date.now()): { applied: number; backup: string } {
  const d = readStackDiff(vault);
  if (!d || d.accepted) throw new Error("no diff waiting");
  const p = toolStackPath(vault);
  const before = readFileSync(p, "utf8");
  const day = new Date(now).toISOString().slice(0, 10);
  const backup = `${p}.pre-diff-${day}`;
  if (!existsSync(backup)) writeFileSync(backup, before);
  const lines = before.split("\n");
  const listed = parseToolStack(before);
  let applied = 0;
  for (const i of d.items) {
    const t = listed.find((x) => x.tool === i.tool && x.line === i.line);
    if (!t) continue;
    const cells = lines[t.line]!.split("|");
    const last = cells.length - 2; // the status cell (the row ends with "|")
    if (i.kind === "status") cells[last] = ` ${cells[last]!.trim()}; ${i.proposed.split(" to ").pop()} since ${day} `;
    if (i.kind === "unused") cells[last] = ` ${cells[last]!.trim()}; unused 30 days (${day}) `;
    lines[t.line] = cells.join("|");
    applied++;
  }
  const missing = d.items.filter((i) => i.kind === "missing");
  let text = lines.join("\n");
  if (missing.length) {
    const head = "## Added from use";
    const rows = missing.map((i) => `| ${i.tool} | ${i.detail.replace(/, not in your stack$/, "")} | observed (${day}) |`).join("\n");
    text = text.includes(`\n${head}`) ? text.replace(new RegExp(`(\\n${head}[^\\n]*\\n(?:[^\\n]*\\n)*?\\|[-| ]+\\|\\n)`), `$1${rows}\n`) : `${text.replace(/\s*$/, "\n")}\n${head}\n_Tools Prevail saw you use; give each a role and a bucket when you have a minute._\n\n| Tool | Role | Status |\n|---|---|---|\n${rows}\n`;
    applied += missing.length;
  }
  writeFileSync(p, text);
  writeFileSync(diffJson(vault), `${JSON.stringify({ ...d, accepted: now }, null, 2)}\n`);
  // The HTML views are the user's own pages made from this file: a task, not a rewrite.
  const board = join(resolveDomainDir(vault, "general"), "memory", "tasks.md");
  const cur = existsSync(board) ? readFileSync(board, "utf8") : "# Tasks\n\n";
  const task = "Regenerate the tool-stack HTML views from tool-stack.md (accepted a said vs used diff)";
  if (!cur.includes(task)) writeFileSync(board, `${cur.replace(/\s*$/, "\n")}- [ ] ${task} +${day} ~src:stack-diff ~id:sd${(now % 1e6).toString(36)}\n`);
  return { applied, backup: backup.slice(vault.length + 1) };
}

export async function stackDiffCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "show";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  try {
    if (sub === "write") { const r = await writeStackDiff(vault); if (args.json) out(r ?? { error: "no tool-stack.md" }); else console.log(r ? diffMarkdown(r.diff) : "No general/source/tool-stack.md."); return 0; }
    if (sub === "accept") { const r = acceptStackDiff(vault); if (args.json) out({ ok: true, ...r }); else console.log(`Applied ${r.applied}; the prior file is ${r.backup}.`); return 0; }
    const d = readStackDiff(vault) ?? (await computeStackDiff(vault));
    if (args.json) out(d); else console.log(d ? diffMarkdown(d) : "No general/source/tool-stack.md.");
    return 0;
  } catch (e) { if (args.json) { out({ ok: false, error: (e as Error).message }); return 0; } console.error((e as Error).message); return 1; }
}
