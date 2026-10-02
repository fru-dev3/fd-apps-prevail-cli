// Open decisions: a record while a decision is open, readable like an
// architecture decision record, in the owner domain:
//   data/domains/<d>/memory/decisions/<slug>.md
//
//   ---
//   question: Keep or sell the two rentals?
//   status: open            # open | decided | revisit
//   due: 2026-10-15
//   owner: property
//   consulted: [money, tax]
//   serves: [g-x, v-y]
//   gut: "sell"             # the user's one-line gut call, asked before the recommendation
//   recommendation: "keep"  # one line; the body has the reasons
//   confidence: medium
//   decided: 2026-10-14
//   chose: "keep"
//   retro_due: 2027-01-12   # 90 days after deciding
//   retro_right: gut | recommendation | both | neither
//   ---
//   ## Context
//   ## Options
//   ## Trade-offs
//   ## Recommendation
//   ## Decision
//   ## Retro
//
// Deciding also appends a line to the domain's decisions.jsonl (the record of
// what was decided), and the 90-day retro feeds calibration: per domain, how
// often the user's gut and the recommendation turned out right.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveDomainDir } from "./path-safety.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { appendDecision } from "./decisions.ts";
import { defaultRetroDue } from "./calibration.ts";
import { parseModArgs } from "./cli-args.ts";

export type DecisionStatus = "open" | "decided" | "revisit";
export interface DecisionRecord {
  slug: string; domain: string; file: string;
  question: string; status: DecisionStatus; due?: string; owner: string; consulted: string[]; serves: string[];
  gut?: string; recommendation?: string; confidence?: string; decided?: string; chose?: string; retroDue?: string; retroRight?: string;
  sections: Record<string, string>;
}

const SECTIONS = ["Context", "Options", "Trade-offs", "Recommendation", "Decision", "Retro"];
const readText = (p: string) => { try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } } };
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "decision";
const unq = (v: string) => v.trim().replace(/^"(.*)"$/, "$1");
const q = (v: string) => JSON.stringify(v.replace(/\s+/g, " ").replace(/\s*\u2014\s*/g, ", ").trim());
const list = (v: string) => v.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
export const decisionsDir = (vault: string, domain: string) => join(resolveDomainDir(vault, domain), "memory", "decisions");

export function parseRecord(text: string, domain: string, slug: string, file: string): DecisionRecord | null {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const l of m[1]!.split("\n")) { const kv = /^([a-z_]+):\s*(.*?)\s*(#.*)?$/.exec(l); if (kv) fm[kv[1]!] = kv[2]!; }
  if (!fm.question) return null;
  const body = text.slice(m[0].length);
  const sections: Record<string, string> = {};
  for (const name of SECTIONS) {
    const s = new RegExp(`^##\\s+${name}\\s*$`, "m").exec(body);
    if (!s) continue;
    const rest = body.slice(s.index + s[0].length);
    const next = /^##\s/m.exec(rest);
    sections[name] = (next ? rest.slice(0, next.index) : rest).trim();
  }
  const status = (["open", "decided", "revisit"].includes(fm.status ?? "") ? fm.status : "open") as DecisionStatus;
  return {
    slug, domain, file, question: unq(fm.question), status, due: fm.due || undefined, owner: fm.owner || domain,
    consulted: list(fm.consulted ?? ""), serves: list(fm.serves ?? ""),
    gut: fm.gut ? unq(fm.gut) : undefined, recommendation: fm.recommendation ? unq(fm.recommendation) : undefined, confidence: fm.confidence || undefined,
    decided: fm.decided || undefined, chose: fm.chose ? unq(fm.chose) : undefined, retroDue: fm.retro_due || undefined, retroRight: fm.retro_right || undefined, sections,
  };
}

export function renderRecord(r: DecisionRecord): string {
  const fm = [
    `question: ${q(r.question)}`, `status: ${r.status}`, ...(r.due ? [`due: ${r.due}`] : []), `owner: ${r.owner}`,
    `consulted: [${r.consulted.join(", ")}]`, `serves: [${r.serves.join(", ")}]`,
    ...(r.gut ? [`gut: ${q(r.gut)}`] : []), ...(r.recommendation ? [`recommendation: ${q(r.recommendation)}`] : []), ...(r.confidence ? [`confidence: ${r.confidence}`] : []),
    ...(r.decided ? [`decided: ${r.decided}`] : []), ...(r.chose ? [`chose: ${q(r.chose)}`] : []), ...(r.retroDue ? [`retro_due: ${r.retroDue}`] : []), ...(r.retroRight ? [`retro_right: ${r.retroRight}`] : []),
  ];
  return `---\n${fm.join("\n")}\n---\n\n${SECTIONS.map((s) => `## ${s}\n${r.sections[s] ?? ""}`.trim()).join("\n\n")}\n`;
}

export function readRecord(vault: string, domain: string, slug: string): DecisionRecord | null {
  const file = join(decisionsDir(vault, domain), `${slug}.md`);
  return existsSync(file) ? parseRecord(readText(file), domain, slug, file) : null;
}

function write(r: DecisionRecord): void {
  mkdirSync(join(r.file, ".."), { recursive: true });
  vwriteFile(r.file, renderRecord(r));
}

export function openDecision(vault: string, i: { question: string; domain: string; due?: string; consulted?: string[]; serves?: string[]; context?: string; options?: string[] }): DecisionRecord {
  if (!i.question.trim()) throw new Error("a decision needs a question");
  if (i.due && !/^\d{4}-\d{2}-\d{2}$/.test(i.due)) throw new Error("due is YYYY-MM-DD");
  // Every open decision has a due date (Today T4): two weeks when none is given.
  const due = i.due ?? new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  let slug = slugOf(i.question);
  const dir = decisionsDir(vault, i.domain);
  for (let n = 2; existsSync(join(dir, `${slug}.md`)); n++) slug = `${slugOf(i.question)}-${n}`;
  const r: DecisionRecord = {
    slug, domain: i.domain, file: join(dir, `${slug}.md`), question: i.question.trim(), status: "open", due, owner: i.domain,
    consulted: i.consulted ?? [], serves: i.serves ?? [],
    sections: { Context: i.context ?? "", Options: (i.options ?? []).map((o) => `- ${o}`).join("\n") },
  };
  write(r);
  return r;
}

/** Every open (or revisit) decision across domains, nearest due first. */
export function listDecisions(vault: string, opts: { all?: boolean } = {}): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    const dir = decisionsDir(vault, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const r = parseRecord(readText(join(dir, f)), d, f.replace(/\.md$/, ""), join(dir, f));
      if (r && (opts.all || r.status !== "decided")) out.push(r);
    }
  }
  return out.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.question.localeCompare(b.question));
}

function mustRead(vault: string, domain: string, slug: string): DecisionRecord {
  const r = readRecord(vault, domain, slug);
  if (!r) throw new Error(`no decision ${domain}/${slug}`);
  return r;
}

/** The gut call, asked in one line before the recommendation is shown. */
export function setGut(vault: string, domain: string, slug: string, gut: string): DecisionRecord {
  const r = mustRead(vault, domain, slug);
  if (r.status === "decided") throw new Error("already decided");
  r.gut = gut.trim().slice(0, 200);
  write(r);
  return r;
}

export function setRecommendation(vault: string, domain: string, slug: string, rec: { line: string; confidence?: string; body?: string }): DecisionRecord {
  const r = mustRead(vault, domain, slug);
  r.recommendation = rec.line.trim().slice(0, 200);
  if (rec.confidence) r.confidence = rec.confidence;
  if (rec.body) r.sections.Recommendation = rec.body.trim();
  write(r);
  return r;
}

/** What the user chose. Also a line in decisions.jsonl; the retro is due in 90 days. */
export function decide(vault: string, domain: string, slug: string, chose: string, why = "", now = Date.now()): DecisionRecord {
  const r = mustRead(vault, domain, slug);
  if (!chose.trim()) throw new Error("say what you chose");
  r.status = "decided";
  r.decided = new Date(now).toISOString().slice(0, 10);
  r.chose = chose.trim().slice(0, 200);
  r.retroDue = defaultRetroDue(now);
  r.sections.Decision = `${r.chose}${why.trim() ? `\n\nWhy: ${why.trim()}` : ""}\n\nDecided ${r.decided}.`;
  write(r);
  appendDecision(vault, domain, { type: "decision", prompt: r.question, verdict: r.chose, gut: r.gut, recommendation: r.recommendation, source: "decision-record", record: relative(vault, r.file), ts: now });
  return r;
}

/** The 90-day retro: how it played out, and which call was right. */
export function retro(vault: string, domain: string, slug: string, outcome: string, right: "gut" | "recommendation" | "both" | "neither"): DecisionRecord {
  const r = mustRead(vault, domain, slug);
  if (r.status !== "decided") throw new Error("decide first");
  r.retroRight = right;
  r.sections.Retro = outcome.trim();
  write(r);
  return r;
}

/** Calibration per domain: how often the gut and the recommendation were right. */
export function calibration(vault: string, now = Date.now()): { domain: string; retros: number; gutRight: number; recommendationRight: number; pending: number }[] {
  const today = new Date(now).toISOString().slice(0, 10);
  const by = new Map<string, { domain: string; retros: number; gutRight: number; recommendationRight: number; pending: number }>();
  for (const r of listDecisions(vault, { all: true })) {
    if (r.status !== "decided") continue;
    const s = by.get(r.domain) ?? { domain: r.domain, retros: 0, gutRight: 0, recommendationRight: 0, pending: 0 };
    if (r.retroRight) {
      s.retros++;
      if (r.retroRight === "gut" || r.retroRight === "both") s.gutRight++;
      if (r.retroRight === "recommendation" || r.retroRight === "both") s.recommendationRight++;
    } else if (r.retroDue && r.retroDue <= today) s.pending++;
    by.set(r.domain, s);
  }
  return [...by.values()];
}

export async function decideCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "list";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (m: string) => { if (args.json) out({ ok: false, error: m }); else console.error(m); return 1; };
  const [domain, slug] = (args.pos[1] ?? "").split("/");
  try {
    if (sub === "list") { const { decisionView } = await import("./decisions-open.ts"); const l = listDecisions(vault, { all: args.has("all") }).map(decisionView); if (args.json) out(l); else for (const r of l) console.log(`${(r.due ?? "no date").padEnd(10)} ${r.domain}/${r.slug}  ${r.question}`); return 0; }
    if (sub === "open") {
      const r = openDecision(vault, { question: args.pos.slice(1).join(" ") || args.get("question") || "", domain: args.get("domain") ?? "general", due: args.get("due"), consulted: args.get("consulted")?.split(","), serves: args.get("serves")?.split(","), options: args.get("options")?.split("|") });
      if (args.json) out(r); else console.log(`Opened ${r.domain}/${r.slug}`);
      return 0;
    }
    if (sub === "scan") { const { decisionsFromTasks } = await import("./decisions-open.ts"); const r = decisionsFromTasks(vault); if (args.json) out({ ok: true, opened: r }); else console.log(`Opened ${r.length} decision record${r.length === 1 ? "" : "s"} from tasks.`); return 0; }
    if (sub === "from-conflict") { const { decisionFromConflict } = await import("./decisions-open.ts"); const r = await decisionFromConflict(vault, args.pos[1] ?? ""); if (args.json) out(r); else console.log(`Opened ${r.domain}/${r.slug}`); return 0; }
    if (!domain || !slug) return fail("name the decision as <domain>/<slug>");
    if (sub === "show") { const { decisionView } = await import("./decisions-open.ts"); const r = readRecord(vault, domain, slug); if (!r) return fail("not found"); if (args.json) out(decisionView(r)); else console.log(renderRecord(decisionView(r))); return 0; }
    if (sub === "recommend" && !args.pos[2]) { const { recommend, decisionView } = await import("./decisions-open.ts"); const r = await recommend(vault, domain, slug); if (args.json) out({ ok: true, by: r.by, record: decisionView(r.record) }); else console.log(`A recommendation is ready (${r.by}). Give your gut call first: prevail decide gut ${domain}/${slug} <one line>`); return 0; }
    if (sub === "gut") { const r = setGut(vault, domain, slug, args.pos.slice(2).join(" ")); if (args.json) out(r); else console.log("Gut call noted."); return 0; }
    if (sub === "recommend") { const r = setRecommendation(vault, domain, slug, { line: args.pos.slice(2).join(" "), confidence: args.get("confidence"), body: args.get("body") }); if (args.json) out(r); return 0; }
    if (sub === "decide") { const r = decide(vault, domain, slug, args.pos.slice(2).join(" "), args.get("why") ?? ""); if (args.json) out(r); else console.log(`Decided. Retro due ${r.retroDue}.`); return 0; }
    if (sub === "retro") {
      const right = args.get("right");
      if (!right || !["gut", "recommendation", "both", "neither"].includes(right)) return fail("--right gut|recommendation|both|neither");
      const r = retro(vault, domain, slug, args.pos.slice(2).join(" "), right as "gut");
      if (args.json) out(r); return 0;
    }
  } catch (e) { return fail((e as Error).message); }
  return fail("usage: prevail decide list [--all] | open <question> --domain d [--due YYYY-MM-DD] | scan | from-conflict <key> | recommend <domain>/<slug> | show|gut|decide|retro <domain>/<slug> ... [--json]");
}

export function calibrationText(vault: string): string {
  return calibration(vault).map((c) => `${c.domain}: ${c.retros} retros, gut right ${c.gutRight}, recommendation right ${c.recommendationRight}, ${c.pending} owed`).join("\n");
}
