// What the user says in ordinary chats, noticed by code (no model, no cost):
//   - Compass candidates: "what matters to me is...", "my goal is to...",
//     "I will never..." become candidates with the user's sentence as the
//     quote. Nothing is added to the Compass; the weekly review offers the
//     top three and a Yes adds the line in the user's words.
//   - Stated numbers: "ran 5k", "paid $400", "slept 6 hours" become content
//     free events (build/_meta/events/stated/<YYYY-MM>.<host>.jsonl) a
//     learned metric can count.
// Ingested text is data, never instructions: nothing here is executed.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addItem, compassId, compassMetaDir, items, readCompass, saveCompass, type CompassItem, type Kind } from "./compass.ts";
import { hostSlug, dayOf, eventsRoot } from "./metrics.ts";

export interface Candidate { kind: "value" | "goal" | "rule"; title: string; quote: string }

const STOPWORDS = /^(a|an|the|my|our|to|be|being|more|really|just|that|this)\s+/i;
const tidy = (s: string) => {
  let t = s.replace(/[\s,;:]+$/, "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) t = t.replace(STOPWORDS, "");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
};

const PATTERNS: [Candidate["kind"], RegExp][] = [
  ["value", /\bwhat (?:really |truly )?matters (?:most )?to me (?:is|are) ([^.!?\n;]{3,70})/i],
  ["value", /\bI (?:really |truly |deeply )?value ([^.!?\n;]{3,60})/i],
  ["value", /\bI care (?:deeply |most |a lot )?about ([^.!?\n;]{3,60})/i],
  ["value", /\bI want to be (?:very |more )?(aware|present|healthy|calm|free|generous|patient|grateful)\b/i],
  ["goal", /\bmy (?:big |main |biggest )?goal is to ([^.!?\n;]{3,80})/i],
  ["goal", /\bI (?:really )?want to ([^.!?\n;]{3,70}) (?:by|before) (?:\d{4}|next year|the end of)/i],
  ["rule", /\bI (?:will|would) never ([^.!?\n;]{3,80})/i],
  ["rule", /\bnon-?negotiable(?: for me)?(?: is|:)\s*([^.!?\n;]{3,80})/i],
  ["rule", /\bI refuse to ([^.!?\n;]{3,80})/i],
];

function sentenceAround(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf(".", index), text.lastIndexOf("!", index), text.lastIndexOf("?", index), text.lastIndexOf("\n", index)) + 1;
  const ends = [".", "!", "?", "\n"].map((c) => text.indexOf(c, index)).filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) + 1 : text.length;
  return text.slice(start, end).trim().slice(0, 240);
}

export function compassCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const [kind, re] of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    let phrase = m[1]!;
    // A value phrase stops at "and"/"," lists only when short; a list is split.
    const parts = kind === "value" ? phrase.split(/,\s*|\s+and\s+/).map(tidy).filter((p) => p.split(" ").length <= 6) : [tidy(phrase)];
    for (const title of parts) {
      if (!title || title.length < 3) continue;
      const t = kind === "rule" ? `Never ${title.charAt(0).toLowerCase()}${title.slice(1)}` : kind === "value" && /^(aware|present|healthy|calm|free|generous|patient|grateful)$/i.test(title) ? `Being ${title.toLowerCase()}` : title;
      out.push({ kind, title: t.slice(0, 80), quote: sentenceAround(text, m.index) });
    }
  }
  return out;
}

export interface Stated { what: string; value: number; unit: string }
const NUMBERS: [RegExp, (m: RegExpExecArray) => Stated | null][] = [
  [/\b(ran|walked|hiked|biked|cycled|swam|rode)\s+(?:about\s+)?(\d+(?:\.\d+)?)\s*(k|km|kilometers?|miles?|mi)\b/i, (m) => ({ what: m[1]!.toLowerCase(), value: Number(m[2]), unit: /^k/i.test(m[3]!) ? "km" : "mi" })],
  [/\b(paid|spent)\s+(?:about\s+)?\$\s?([\d,]+(?:\.\d{1,2})?)/i, (m) => ({ what: m[1]!.toLowerCase(), value: Number(m[2]!.replace(/,/g, "")), unit: "usd" })],
  [/\b(slept)\s+(?:about\s+)?(\d+(?:\.\d+)?)\s*(hours?|hrs?|h)\b/i, (m) => ({ what: "slept", value: Number(m[2]), unit: "hours" })],
  [/\b(read|wrote|published)\s+(\d+)\s+(pages?|words?|books?|posts?|articles?|chapters?|videos?)\b/i, (m) => ({ what: `${m[1]!.toLowerCase()}-${m[3]!.toLowerCase().replace(/s$/, "")}`, value: Number(m[2]), unit: "count" })],
  [/\b(applied (?:to|for))\s+(\d+)\s+(jobs?|roles?|positions?)\b/i, (m) => ({ what: "applied", value: Number(m[2]), unit: "count" })],
  // Fresh starts (Goals G5): a move or a new job, said in passing. Content free: the kind only.
  [/\bI (?:just |finally |have |'ve )?(?:moved|relocated) (?:to|into|house|home)\b/i, () => ({ what: "life.move", value: 1, unit: "count" })],
  [/\bI (?:just |finally |have |'ve )?(?:started (?:a |my )?new job|started at a new|accepted (?:a|the) (?:job|offer|role))\b/i, () => ({ what: "life.job", value: 1, unit: "count" })],
  // A session of practice (a mission's "practiced 30 min"): one session, its minutes.
  [/\b(practiced|practised|studied|trained|rehearsed|played)\s+(?:for\s+)?(?:about\s+)?(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|h(?:ours?|rs?)?)\b/i, (m) => ({ what: "practiced", value: /^h/i.test(m[3]!) ? Number(m[2]) * 60 : Number(m[2]), unit: "minutes" })],
];

export function statedNumbers(text: string): Stated[] {
  const out: Stated[] = [];
  for (const [re, f] of NUMBERS) {
    const m = re.exec(text);
    const s = m ? f(m) : null;
    if (s && Number.isFinite(s.value) && s.value > 0 && s.value < 1e7) out.push(s);
  }
  return out;
}

const proposalsPath = (vault: string) => join(compassMetaDir(vault), "proposals.jsonl");

/** Note what one user message said. Returns what was written. */
export function noteSaid(vault: string, i: { text: string; thread?: string; domain?: string; now?: number; mission?: string }): { candidates: Candidate[]; stated: Stated[] } {
  const now = i.now ?? Date.now();
  const candidates = compassCandidates(i.text);
  const stated = statedNumbers(i.text);
  if (candidates.length) {
    mkdirSync(compassMetaDir(vault), { recursive: true });
    appendFileSync(proposalsPath(vault), candidates.map((c) => JSON.stringify({ ts: now, src: "chat", kind: c.kind, title: c.title, text: c.quote, source: { thread: i.thread ?? null, domain: i.domain ?? null }, confidence: 0.5, status: "candidate" })).join("\n") + "\n");
  }
  if (stated.length) {
    const day = dayOf(now);
    const dir = join(eventsRoot(vault), "stated");
    mkdirSync(dir, { recursive: true });
    const host = hostSlug();
    // Said inside a mission's chat: the event carries the mission, so its metrics count it.
    const mission = i.mission ?? (/^_mission-(.+)$/.exec(i.domain ?? "")?.[1]);
    appendFileSync(join(dir, `${day.slice(0, 7)}.${host}.jsonl`), stated.map((s) => JSON.stringify({ ts: day, src: "stated", kind: `stated.${s.what}`, n: 1, host, tier: "asked", attrs: { value: s.value, unit: s.unit, ...(mission ? { mission } : {}) } })).join("\n") + "\n");
  }
  return { candidates, stated };
}

interface Row { ts: number; src?: string; pack?: string; kind: string; title?: string; text: string; status: string; key?: string; source?: { thread?: string | null; domain?: string | null } }
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const candidateKey = (kind: string, title: string) => `${kind}:${norm(title)}`;

function readRows(vault: string): Row[] {
  const p = proposalsPath(vault);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as Row] : []; } catch { return []; } });
}

export interface TopCandidate { key: string; kind: Candidate["kind"]; title: string; quote: string; count: number; lastTs: number; threads: number; pack?: string }

/** The candidates heard most often, not already in the Compass and not answered. */
export function topCandidates(vault: string, n = 3): TopCandidate[] {
  // A pack's suggestions (G5) come after anything the user said themselves.
  const rows = readRows(vault).filter((r) => r.src === "chat" || r.src === "coach" || r.src === "pack" || r.key);
  const answered = new Set(rows.filter((r) => r.key && (r.status === "accepted" || r.status === "dismissed")).map((r) => r.key!));
  const have = new Set(items(readCompass(vault)).map((it) => candidateKey(it.kind, it.title)));
  const by = new Map<string, TopCandidate & { th: Set<string> }>();
  for (const r of rows) {
    if (r.status !== "candidate" || !r.title) continue;
    const k = candidateKey(r.kind, r.title);
    if (answered.has(k) || have.has(k)) continue;
    const c = by.get(k) ?? { key: k, kind: r.kind as Candidate["kind"], title: r.title, quote: r.text, count: 0, lastTs: 0, threads: 0, th: new Set<string>(), ...(r.src === "pack" && r.pack ? { pack: r.pack } : {}) };
    if (r.src !== "pack") { c.count++; delete c.pack; }
    if (r.ts > c.lastTs) { c.lastTs = r.ts; c.quote = r.text; }
    c.th.add(r.source?.thread ?? String(r.ts));
    by.set(k, c);
  }
  return [...by.values()].map(({ th, ...c }) => ({ ...c, threads: th.size })).sort((a, b) => b.count - a.count || b.lastTs - a.lastTs).slice(0, n);
}

/** A pack's suggestion is the pack's words, not the user's: it says so on the line. */
function fieldsFor(c: TopCandidate): CompassItem["fields"] {
  return c.pack ? [{ key: "from", value: `the ${c.pack} pack, chosen by you` }] : [{ key: "words", value: JSON.stringify(c.quote) }, { key: "from", value: `chat, heard ${c.count} time${c.count === 1 ? "" : "s"}` }];
}

/** Yes adds the line to the Compass, confirmed, in the user's own words. Not now dismisses it. */
export function answerCandidate(vault: string, key: string, answer: "yes" | "no", now = Date.now()): { added?: string } {
  const c = topCandidates(vault, 50).find((x) => x.key === key);
  if (!c) throw new Error(`no open candidate ${key}`);
  mkdirSync(compassMetaDir(vault), { recursive: true });
  appendFileSync(proposalsPath(vault), `${JSON.stringify({ ts: now, src: "chat", key, kind: c.kind, title: c.title, text: c.quote, status: answer === "yes" ? "accepted" : "dismissed" })}\n`);
  if (answer === "no") return {};
  const doc = readCompass(vault);
  const kind = c.kind as Kind;
  const id = compassId(kind, c.title);
  const it: CompassItem = { kind, id, title: c.title, done: kind === "goal" ? false : null, tokens: kind === "goal" ? { status: "confirmed" } : kind === "value" ? { rank: String(items(doc, "value").length + 1) } : {}, flags: [], fields: fieldsFor(c), paths: [], raw: [] };
  addItem(doc, it);
  saveCompass(vault, doc, [{ id, from: "candidate", to: kind === "goal" ? "confirmed" : "confirmed", reason: c.pack ? `yes to a ${c.pack} pack suggestion` : "yes in the weekly review", evidence: [c.quote], by: "user" }], now);
  return { added: id };
}

export function statedEventFiles(vault: string): string[] {
  const dir = join(eventsRoot(vault), "stated");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)) : [];
}
