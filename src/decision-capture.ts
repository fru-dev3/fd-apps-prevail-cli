// Decisions heard in conversation (owner feedback round 1, 2026-10-02: "mine
// all my conversations and save decisions"). Deciding to archive some
// projects or to learn cello is a decision; when the user says one in any
// chat, code notices it in their own words and saves a decided record
// (decision-records.ts) with what, when, the thread and the domain. The
// thread gets a quiet receipt with Undo; Undo moves the record aside into
// memory/decisions/_undone/ (never deleted). A backfill reads every saved
// thread once, records only: threads are never written.
//
// Code only, no model: a decision is said in a recognizable way ("I've
// decided to...", "I'm going to learn...", "let's go with..."). Questions,
// hypotheticals and someone else's decisions are left alone.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { decisionsDir, listDecisions, renderRecord, type DecisionRecord } from "./decision-records.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { resolveDomainDir, runtimePath } from "./path-safety.ts";
import { scoreDomains } from "./domain-touch.ts";
import { vwriteFile } from "./vault-session.ts";
import { maskSecrets } from "./secret-redact.ts";

// Verbs that make "I'll ..." or "I'm going to ..." a decision rather than a step in a task.
const VERBS = "archive|learn|quit|sell|buy|move to|cancel|hire|fire|join|retire|refinance|enroll in|launch|shut down|wind down|pay off|sign up for|give up|switch to|start learning|start taking|stop working|stop using|stop paying";
const PATTERNS: { re: RegExp; lead?: string }[] = [
  // "I've decided to learn cello", "we decided we'll sell the foo car"
  { re: /\b(?:I|we)(?:'ve| have)?\s+(?:finally\s+)?decided\s+(?:to\s+|that\s+(?:I|we)(?:'ll| will)\s+|on\s+)?([^.!?\n]{3,160})/i },
  // "I made up my mind: ...", "my decision is to ..."
  { re: /\b(?:I(?:'ve| have)? made up my mind|my decision is|decision made)[:,]?\s+(?:to\s+|that\s+)?([^.!?\n]{3,160})/i },
  // "let's go with the blue one", "I'm going with option two"
  { re: /\b(?:let's|let us|I'm|I am|I'll|I will|we're|we are|we'll)\s+go(?:ing)?\s+with\s+([^.!?\n]{2,140})/i, lead: "Go with " },
  // "I chose the remote job"
  { re: /\bI(?:'ve| have)?\s+(?:chosen|chose|picked|settled on)\s+([^.!?\n]{2,140})/i, lead: "Chose " },
  // "I'm going to learn cello", "I'll archive the old projects", "from now on I'll stop..."
  { re: new RegExp(`\\b(?:I(?:'m| am)\\s+(?:going to|gonna)|I(?:'ll| will)|from now on,?\\s+I(?:'ll| will)?)\\s+((?:${VERBS})\\b[^.!?\\n]{2,140})`, "i") },
];
// Not a decision: a question, a maybe, a hypothetical, someone else, or a plan for the assistant.
const NOT = /\b(should I|should we|whether|maybe|might|thinking about|considering|not sure|if I|what if|would you|can you|could you|help me decide|wondering)\b/i;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clean = (s: string) => s.replace(/\s+/g, " ").replace(/[,;:\s]+$/, "").replace(/\s*\u2014\s*/g, ", ").trim();

/** The decision the user states in this text, in their words, or null. */
export function decisionMade(text: string): { what: string; said: string } | null {
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.trim();
    if (!s || s.endsWith("?") || NOT.test(s) || s.length > 400) continue;
    for (const p of PATTERNS) {
      const m = p.re.exec(s);
      if (!m) continue;
      const what = clean(m[1]!).replace(/^(?:to|that)\s+/i, "").replace(/\s+(?:for now|I think|I guess)$/i, "");
      if (!p.lead && what.split(" ").length < 2) continue;
      // "I'll stop it", "go with that": a pronoun alone says nothing on its own.
      if (/^(?:\w+\s+)?(?:it|this|that|them|those|these|one)\b(?:\s+\w+)?$/i.test(what)) continue;
      // "I chose years ago": a time, not a choice.
      if (p.lead && /^(?:years?|months?|weeks?|days?|a while|long|to)\b/i.test(what)) continue;
      return { what: cap(`${p.lead ?? ""}${p.lead ? what.replace(/^the\s+/i, "the ") : what}`).slice(0, 160), said: s.slice(0, 300) };
    }
  }
  return null;
}

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 4));
function similar(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let n = 0; for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
}
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "decision";
// The user's own calendar day, not UTC.
const ymd = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export interface Captured { domain: string; slug: string; what: string; decided: string; thread: string }

/** Save a decided record for a decision heard in a chat turn. Null when there is none, or it is already saved. */
export function captureDecision(vault: string, i: { text: string; domain: string; thread: string; now?: number }): Captured | null {
  const d = decisionMade(maskSecrets(i.text));
  if (!d) return null;
  const now = i.now ?? Date.now();
  const domain = i.domain && !i.domain.startsWith("_") ? i.domain : "general";
  const existing = listDecisions(vault, { all: true });
  if (existing.some((r) => (r.thread && r.thread === i.thread && similar(r.question, d.what) >= 0.6) || (r.status === "decided" && similar(r.question, d.what) >= 0.8))) return null;
  const dir = decisionsDir(vault, domain);
  let slug = slugOf(d.what);
  for (let n = 2; existsSync(join(dir, `${slug}.md`)) || existsSync(join(dir, "_undone", `${slug}.md`)); n++) slug = `${slugOf(d.what)}-${n}`;
  const decided = ymd(now);
  const r: DecisionRecord = {
    slug, domain, file: join(dir, `${slug}.md`), question: d.what, status: "decided", owner: domain, consulted: [], serves: [],
    decided, chose: d.what, thread: i.thread, source: "chat",
    sections: { Context: `Said in a conversation: "${d.said}"`, Decision: `${d.what}\n\nDecided ${decided}, in conversation.` },
  };
  mkdirSync(dir, { recursive: true });
  vwriteFile(r.file, maskSecrets(renderRecord(r)));
  return { domain, slug, what: d.what, decided, thread: i.thread };
}

/** Undo a decision saved from a conversation: the record moves aside, never deleted. */
export function undoCaptured(vault: string, domain: string, slug: string): boolean {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("not a decision name");
  const dir = decisionsDir(vault, domain);
  const file = join(dir, `${slug}.md`);
  if (!existsSync(file)) return false;
  if (!/^source: chat$/m.test(readFileSync(file, "utf8"))) throw new Error("only a decision saved from a conversation is undone here");
  mkdirSync(join(dir, "_undone"), { recursive: true });
  renameSync(file, join(dir, "_undone", `${slug}.md`));
  return true;
}

// ── Backfill: every saved thread, once; records only ───────────────────────

interface Turn { role: string; content: string; ts: number }
function threadTurns(file: string): { turns: Turn[]; created: number } {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) {
    const turns: Turn[] = [];
    for (const l of text.split("\n")) { try { const o = JSON.parse(l); if (o && typeof o.content === "string") turns.push({ role: String(o.role), content: o.content, ts: Number(o.ts) || 0 }); } catch { /* skip */ } }
    return { turns, created: turns.find((t) => t.ts)?.ts ?? 0 };
  }
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const created = fm ? Date.parse(/^created:\s*(.+)$/m.exec(fm[1]!)?.[1]?.trim() ?? "") || 0 : 0;
  const turns: Turn[] = [];
  let role = "", buf: string[] = [];
  const flush = () => { if (role && buf.join("").trim()) turns.push({ role, content: buf.join("\n").trim(), ts: created }); buf = []; };
  for (const line of text.slice(fm ? fm[0].length : 0).split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { flush(); role = /^(you|me|user)$/i.test(h[1]!) ? "user" : "assistant"; continue; }
    buf.push(line);
  }
  flush();
  return { turns, created };
}

export interface BackfillResult { threads: number; prompts: number; found: Captured[]; saved: number }

/** Read every thread in every domain and save the decisions the user stated. Dry run writes nothing. */
export function backfillDecisions(vault: string, o: { dryRun?: boolean; now?: number; streams?: boolean } = {}): BackfillResult {
  const out: BackfillResult = { threads: 0, prompts: 0, found: [], saved: 0 };
  const seen = new Set<string>();
  for (const d of listDomainDirs(vault)) {
    const base = resolveDomainDir(vault, d);
    for (const dir of [join(base, "memory", "threads"), join(base, "_threads")]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).sort()) {
        if (!/\.(md|jsonl)$/.test(f)) continue;
        const slug = f.replace(/\.(md|jsonl)$/, "");
        const key = `${d}/${slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.threads++;
        let t: { turns: Turn[]; created: number };
        try { t = threadTurns(join(dir, f)); } catch { continue; }
        const domain = d.startsWith("_") ? "general" : d;
        for (const turn of t.turns) {
          if (turn.role !== "user") continue;
          const when = turn.ts || t.created || (o.now ?? Date.now());
          if (o.dryRun) {
            const m = decisionMade(turn.content);
            if (m && !out.found.some((x) => x.thread === slug && similar(x.what, m.what) >= 0.6)) out.found.push({ domain, slug: "", what: m.what, decided: ymd(when), thread: slug });
            continue;
          }
          const c = captureDecision(vault, { text: turn.content, domain, thread: slug, now: when });
          if (c) { out.found.push(c); out.saved++; }
        }
      }
    }
  }
  // The prompts captured from the user's other AI tools (build/_meta/prompts),
  // typed by the user: short, not pasted output, not an agent's instructions.
  if (o.streams !== false) {
    const dir = runtimePath(vault, join("_meta", "prompts"));
    const domains = listDomainDirs(vault).filter((d) => !d.startsWith("_") && d !== "general");
    const typed = new Set<string>();
    if (existsSync(dir)) for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
      for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
        let row: { prompt?: unknown; epoch_ms?: unknown; ts?: unknown; tool?: unknown; session?: unknown };
        try { row = JSON.parse(l); } catch { continue; }
        const text = typeof row.prompt === "string" ? row.prompt.trim() : "";
        if (!text || text.length > 3000 || /^(-\n)?You are\b/.test(text) || /\*\*|```|^\s*[|#>-]/m.test(text) || typed.has(text)) continue;
        typed.add(text);
        const when = Number(row.epoch_ms) || Date.parse(String(row.ts ?? "")) || (o.now ?? Date.now());
        const thread = `${String(row.tool ?? "ai").replace(/[^a-z0-9-]/gi, "")}-${String(row.session ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 8)}`;
        const top = scoreDomains(vault, text, domains)[0];
        const domain = top && top.score >= 2 ? top.slug : "general";
        out.prompts++;
        if (o.dryRun) {
          const m = decisionMade(text);
          if (m && !out.found.some((x) => similar(x.what, m.what) >= 0.8)) out.found.push({ domain, slug: "", what: m.what, decided: ymd(when), thread });
          continue;
        }
        const c = captureDecision(vault, { text, domain, thread, now: when });
        if (c) { out.found.push(c); out.saved++; }
      }
    }
  }
  return out;
}
