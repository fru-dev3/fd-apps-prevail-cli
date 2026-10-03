// Today T4: decisions (today-plan.md section 4). Open decisions get a record
// while they are open (decision-records.ts); this module finds them and gets
// each one a recommendation.
//
//   Detection   chats where the user is deliberating ("should I...", "I'm
//               torn between...") offer a record (one tap, never on their
//               own); tasks phrased as decisions ("Decide whether...") open
//               one, linked to the task; a Compass conflict can become one.
//   Recommend   the Steward (a job, with its ceilings, budget and record)
//               writes options, even-swap trade-offs against the Compass, a
//               recommendation with confidence and what would change it. A
//               big decision (money, selling or buying a home, moving,
//               leaving a job, or several domains) convenes the council
//               instead. Nothing is decided for the user.
//   Gut first   the recommendation is not shown until the user has given a
//               one-line gut call (or decided): decisionView hides it.
//   Retro       90 days after deciding (decision-records.ts); the radar
//               flags a retro owed.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot } from "./path-safety.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { parseTasks } from "./tasks.ts";
import { listDecisions, openDecision, readRecord, setRecommendation, type DecisionRecord } from "./decision-records.ts";
import { vwriteFile } from "./vault-session.ts";

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 4));
function similar(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let n = 0; for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
}

// ── Detection ───────────────────────────────────────────────────────────────

const DELIBERATE: RegExp[] = [
  /\b(should I|should we)\b[^?.!]{4,140}\?/i,
  /\b(I'm|I am) (torn|undecided|on the fence) (between|about|on|whether)\b[^.!?]{4,140}/i,
  /\b(trying to decide|can't decide|cannot decide|deciding) (whether|if|between|on)\b[^.!?]{4,140}/i,
  /\b(weighing|debating) (whether|if|between)\b[^.!?]{4,140}/i,
];
/** "Should I sell the foo car or keep it?" -> the question, for a decision record. */
export function deliberation(text: string): string | null {
  for (const re of DELIBERATE) {
    const m = re.exec(text);
    if (!m) continue;
    let q = m[0].trim().replace(/^(I'm|I am) (torn|undecided|on the fence) /i, "").replace(/^(trying to decide|can't decide|cannot decide|deciding|weighing|debating) /i, "");
    q = q.replace(/^(whether|if) /i, "").replace(/^(between) /i, "");
    q = q.charAt(0).toUpperCase() + q.slice(1);
    if (!/\?$/.test(q)) q = `${q.replace(/[.!]+$/, "")}?`;
    return q.slice(0, 200);
  }
  return null;
}

/** A chat message that deliberates, and no open record asks the same: offer one (due in two weeks). */
export function decisionOffer(vault: string, text: string, domain: string, now = Date.now()): { question: string; domain: string; due: string } | null {
  const q = deliberation(text);
  if (!q) return null;
  if (listDecisions(vault).some((r) => similar(r.question, q) >= 0.6)) return null;
  return { question: q, domain: domain && !domain.startsWith("_") ? domain : "general", due: ymd(now + 14 * DAY) };
}

const TASK_DECISION = /^(?:\[DECIDE\]\s*)?(decide|choose|pick|make a decision)\b\s*(?:(?:on|whether|if|between|about)\s+)?(.+)$/i;
/** Tasks phrased as decisions open a record each (once, linked by the task's id). */
export function decisionsFromTasks(vault: string, now = Date.now()): DecisionRecord[] {
  const opened: DecisionRecord[] = [];
  const existing = listDecisions(vault, { all: true });
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    for (const f of ["memory/tasks.md", "_tasks.md"]) {
      const file = join(dataRoot(vault), "domains", d, f);
      if (!existsSync(file)) continue;
      for (const t of parseTasks(readFileSync(file, "utf8"))) {
        if (t.done || t.trashed) continue;
        const m = TASK_DECISION.exec(t.text);
        if (!m) continue;
        // "Decide whether to renew the lease" -> "Renew the lease?"; "Choose between A and B" -> "A or B?"
        const between = /^(?:\[DECIDE\]\s*)?\w+(?: a decision)?\s+between\s+/i.test(t.text);
        // The question is the first clause: a task often carries its context after a colon, a dash or a full stop.
        let body = m[2]!.split(/(?<=.{20,}?)(?::\s|\.\s|\s\(|;\s|,\s(?:then|and then|because|since)\b)/)[0]!.replace(/[.!?]+$/, "").replace(/^to\s+/i, "");
        if (between) body = body.replace(/\s+and\s+/i, " or ");
        const q = `${body.replace(/^\w/, (c) => c.toUpperCase())}?`;
        if (q.length < 8) continue;
        const src = `task:${d}:${t.id ?? createHash("sha1").update(t.text).digest("hex").slice(0, 8)}`;
        if (existing.some((r) => r.sections.Context?.includes(src) || (r.domain === d && similar(r.question, q) >= 0.7))) continue;
        const r = openDecision(vault, { question: q.slice(0, 200), domain: d, due: t.due ?? ymd(now + 14 * DAY), context: `From the task on ${d}'s board (${src}).` });
        existing.push(r);
        opened.push(r);
      }
    }
  }
  return opened;
}

/** A Compass conflict as a decision: the two sides are the options, the evidence the trade-off. */
export async function decisionFromConflict(vault: string, key: string, now = Date.now()): Promise<DecisionRecord> {
  const ca = await import("./compass-align.ts");
  const c = (ca.readGraph(vault)?.conflicts ?? []).find((x) => x.key === key);
  if (!c) throw new Error(`no conflict ${key}`);
  const r = openDecision(vault, { question: c.question.replace(/\s+/g, " ").slice(0, 200), domain: "general", due: ymd(now + 14 * DAY), options: [`Keep ${c.aTitle} as it is`, `Change ${c.bTitle}`, "Accept the tension for now"], context: `From a conflict in the Compass (${key}).` });
  r.sections["Trade-offs"] = c.evidence.map((e) => `- ${e}`).join("\n");
  vwriteFile(r.file, (await import("./decision-records.ts")).renderRecord(r));
  return r;
}

// ── Gut first ───────────────────────────────────────────────────────────────

export interface DecisionView extends DecisionRecord { missing: string[]; recommendationReady: boolean; big: boolean }

/** What may be shown: the recommendation only after the gut call (or a decision). */
export function decisionView(r: DecisionRecord): DecisionView {
  const missing = [
    ...(!r.sections.Options?.trim() ? ["options"] : []),
    ...(!r.sections["Trade-offs"]?.trim() ? ["trade-offs"] : []),
    ...(!r.recommendation ? ["recommendation"] : []),
    ...(!r.due ? ["due date"] : []),
  ];
  const ready = !!r.recommendation;
  const reveal = !!r.gut || r.status === "decided";
  const sections = { ...r.sections };
  if (!reveal) delete sections.Recommendation;
  return { ...r, ...(reveal ? {} : { recommendation: undefined, confidence: undefined }), sections, missing, recommendationReady: ready, big: isBig(r) };
}

const BIG = /\b(sell|selling|buy (a|the|another) (house|home|property|rental)|quit|leave (my|the) job|resign|move to|moving to|relocat|marry|divorce|retire|invest(ing)? (in|my)|mortgage|lawsuit|sue)\b/i;
/** Big: real money, a home, a move, a job, a marriage, or a choice that spans several domains. */
export function isBig(r: Pick<DecisionRecord, "question" | "consulted" | "sections">): boolean {
  const text = `${r.question} ${r.sections.Context ?? ""} ${r.sections.Options ?? ""}`;
  const amount = Math.max(0, ...[...text.matchAll(/\$\s?([\d,]+(?:\.\d+)?)\s*(k|m)?\b/gi)].map((m) => Number(m[1]!.replace(/,/g, "")) * (m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1)));
  return BIG.test(text) || amount >= 10_000 || r.consulted.length >= 2;
}

// ── Recommendation ──────────────────────────────────────────────────────────

export interface Recommendation { options: string[]; tradeoffs: string[]; recommendation: string; confidence: "low" | "medium" | "high"; changeIt: string; by: "steward" | "council"; job?: string }

/** The Steward's (or the council's) answer, in the record's sections. Tolerates prose around the labels. */
export function parseRecommendation(text: string, by: Recommendation["by"]): Recommendation | null {
  // Line by line: a label line ("Options:", "**Options:**", "## Options") starts a section; the rest of its line counts.
  const LABEL = /^\s*#*\s*\**\s*(options|trade-?offs|recommendation|confidence|what would change it)\s*\**\s*:?\s*\**\s*(.*)$/i;
  const secs: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const line of text.split("\n")) {
    const m = LABEL.exec(line);
    if (m) { cur = m[1]!.toLowerCase().replace(/-/g, ""); secs[cur] = m[2]!.trim() ? [m[2]!.trim()] : []; continue; }
    if (cur) secs[cur]!.push(line);
  }
  const sec = (k: string) => (secs[k] ?? []).join("\n").trim();
  const list = (s: string) => s.split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim()).filter((l) => l.length >= 1);
  const rec = (sec("recommendation").split("\n").find((l) => l.trim()) ?? "").replace(/^\s*[-*]\s+/, "").trim();
  if (!rec) return null;
  const c = `${sec("confidence")}`.toLowerCase();
  const confidence = /high/.test(c) ? "high" : /low/.test(c) ? "low" : "medium";
  return { options: list(sec("options")).slice(0, 4), tradeoffs: list(sec("tradeoffs")).slice(0, 6), recommendation: rec.slice(0, 200), confidence, changeIt: (sec("what would change it").split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 240), by };
}

export function recommendPrompt(r: DecisionRecord): string {
  return [
    `An open decision in the user's ${r.domain} domain: ${r.question}`,
    r.due ? `It is due ${r.due}.` : "",
    r.sections.Context ? `Context:\n${r.sections.Context}` : "",
    r.sections.Options ? `Options already named:\n${r.sections.Options}` : "Name two to four real options (doing nothing counts).",
    "Weigh the options against the user's Compass (their values, rules and goals, in the context you have) as even-swap sentences: what one option gives up to get what. Check every non-negotiable.",
    "Then recommend one option, with your confidence (low, medium or high) and the one fact that would change your mind. The user decides; never decide for them.",
    "Answer in exactly these sections:\nOptions:\n- ...\nTrade-offs:\n- ...\nRecommendation:\n<one option, one line>\nConfidence: low | medium | high\nWhat would change it:\n<one line>",
  ].filter(Boolean).join("\n\n");
}

export interface RecommendDeps {
  /** The Steward as a job (jobs.ts); returns the step's body. */
  steward?: (vault: string, r: DecisionRecord, brief: string) => Promise<{ body: string; job?: string } | null>;
  /** The council, for big decisions; returns the chair's verdict. */
  council?: (vault: string, r: DecisionRecord, prompt: string) => Promise<string | null>;
  now?: number;
}

async function stewardJob(vault: string, r: DecisionRecord, brief: string): Promise<{ body: string; job: string } | null> {
  const jobs = await import("./jobs.ts");
  const { loadSpecialists } = await import("./specialists.ts");
  const { readChiefOfStaff } = await import("./chief-of-staff.ts");
  const chief = readChiefOfStaff(vault);
  const job: import("./jobs.ts").Job = {
    id: jobs.makeJobId(`decide ${r.question}`), ask: `Recommend: ${r.question}`, origin: { kind: "cli", domain: r.domain },
    domains: { owner: r.domain, consulted: r.consulted.filter((d) => d !== r.domain).slice(0, 3), informed: [] }, entities: [],
    team: [{ step: 1, specialists: ["historian"] }, { step: 2, specialists: ["steward"], brief }], effort: "standard",
    budget: { usd: Math.min(1, chief.limits.usd), minutes: Math.min(10, chief.limits.minutes) }, why: "a recommendation for an open decision", playbook: null, status: "proposed", startsAlone: true, created: Date.now(),
  };
  jobs.decideStart(vault, job, loadSpecialists(vault), chief.limits, true);
  jobs.saveJob(vault, job);
  const done = await jobs.runJob(vault, job.id);
  if (done.status !== "done" && done.status !== "needs-approval") return null;
  const view = jobs.jobView(vault, job.id);
  const st = (view?.steps as { specialist: string; result?: { file: string } }[] | undefined)?.find((s) => s.specialist === "steward" && s.result);
  if (!st) return null;
  try { return { body: (JSON.parse(readFileSync(join(jobs.jobDir(vault, job.id), st.result!.file), "utf8")) as { body?: string }).body ?? "", job: job.id }; } catch { return null; }
}

async function councilVerdict(vault: string, r: DecisionRecord, prompt: string): Promise<string | null> {
  const { detectClis } = await import("./cli-bridge.ts");
  const { buildCouncilPanel, runCouncilOneShot } = await import("./council-runner.ts");
  const { resolveDomainDir } = await import("./path-safety.ts");
  const { compassBlock } = await import("./compass.ts");
  const panel = buildCouncilPanel(await detectClis());
  if (panel.length < 2) return null;
  const res = await runCouncilOneShot({ prompt: `${compassBlock(vault)}\n\n${prompt}`, cwd: resolveDomainDir(vault, r.domain), panelists: panel, vaultPath: vault, quorum: Math.min(3, panel.length) });
  return res.verdict || null;
}

/**
 * Get an open decision a recommendation: the council for a big one (falling
 * back to the Steward when fewer than two runtimes answer), the Steward
 * otherwise. Writes options (when none were named), trade-offs and the
 * recommendation with confidence into the record.
 */
export async function recommend(vault: string, domain: string, slug: string, deps: RecommendDeps = {}): Promise<{ record: DecisionRecord; by: Recommendation["by"] }> {
  const r = readRecord(vault, domain, slug);
  if (!r) throw new Error(`no decision ${domain}/${slug}`);
  if (r.status === "decided") throw new Error("already decided");
  const prompt = recommendPrompt(r);
  let rec: Recommendation | null = null;
  if (isBig(r)) {
    const v = await (deps.council ?? councilVerdict)(vault, r, prompt);
    if (v) rec = parseRecommendation(v, "council");
  }
  if (!rec) {
    const s = await (deps.steward ?? stewardJob)(vault, r, prompt);
    const parsed = s?.body ? parseRecommendation(s.body, "steward") : null;
    if (parsed) rec = { ...parsed, ...(s?.job ? { job: s.job } : {}) };
  }
  if (!rec) throw new Error("no recommendation came back; try again later");
  const next = readRecord(vault, domain, slug)!;
  if (!next.sections.Options?.trim() && rec.options.length) next.sections.Options = rec.options.map((o) => `- ${o}`).join("\n");
  if (rec.tradeoffs.length) next.sections["Trade-offs"] = rec.tradeoffs.map((t) => `- ${t}`).join("\n");
  vwriteFile(next.file, (await import("./decision-records.ts")).renderRecord(next));
  const body = `${rec.recommendation}\n\nConfidence: ${rec.confidence}.${rec.changeIt ? `\n\nWhat would change it: ${rec.changeIt}` : ""}\n\nBy ${rec.by === "council" ? "the council" : "the Steward"}${rec.job ? ` (job ${rec.job})` : ""}.`;
  const out = setRecommendation(vault, domain, slug, { line: rec.recommendation, confidence: rec.confidence, body });
  return { record: out, by: rec.by };
}
