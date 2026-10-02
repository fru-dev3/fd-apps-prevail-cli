// The Compass conversation: one question at a time, in chat, resumable across
// days. The first sitting is about five minutes (roles, hopes and fears,
// values, non-negotiables); the rest is drawn out over the following weeks,
// one question at a time. Every answer becomes proposed lines whose titles
// and quotes are the user's own words (code splits the answer; no model
// writes them), and the user confirms them in one reply.
//
// State: build/_meta/compass/interview.json (machine-managed).
//
// In a General chat: "set up my Compass" (or "continue my Compass", "ask me
// more") starts or resumes it; while it is active every General message is
// an answer. "later" pauses, "skip" moves on.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addItem, compassId, compassMetaDir, confirm, drop, findById, items, mission, readCompass, saveCompass, setWoop,
  type CompassItem, type Field, type Kind,
} from "./compass.ts";

type Step = "roles" | "hope" | "fear" | "values" | "rules" | "confirm" | "enough" | "missing" | "goal" | "outcome" | "obstacle" | "plan" | "expect" | "mission";
interface Q { id: Step; sitting: 1 | 2; text: (ctx: Ctx) => string }
interface Ctx { role?: string; value?: string; goal?: string; proposed: { id: string; kind: string; title: string }[] }

const OBJECTIVES = "health, money security, rest, friendships, learning, faith or meaning, community, adventure";

const QUESTIONS: Q[] = [
  { id: "roles", sitting: 1, text: () => "Who are you to the people in your life? For example a parent, a partner, a son or daughter, a friend, the one who builds things. Name them your way, separated by commas." },
  { id: "hope", sitting: 1, text: (c) => `Think of who matters most to you as ${c.role ? `a ${c.role.toLowerCase()}` : "you are now"}. Ten years from now, what do you hope they say about you?` },
  { id: "fear", sitting: 1, text: () => "And what would you hate for them to say?" },
  { id: "values", sitting: 1, text: () => "What matters most to you? Name up to three things you want more of in your life, your words, separated by commas." },
  { id: "rules", sitting: 1, text: () => "Is there anything you would never trade, even for a lot of money? Separate them with commas, or say none." },
  { id: "confirm", sitting: 1, text: (c) => `Here is what I heard, in your words:\n${c.proposed.map((p, i) => `${i + 1}. ${p.title} (${p.kind})`).join("\n")}\nReply "yes to all", or "drop 2" (or "drop 2, 4") to leave some out.` },
  { id: "enough", sitting: 2, text: (c) => `For ${c.value ?? "what matters most to you"}, what would enough look like? Past enough, I stop pushing.` },
  { id: "missing", sitting: 2, text: () => `People usually miss about half of what matters to them. Common ones: ${OBJECTIVES}. Are any of these yours too? Name them, or say none.` },
  { id: "goal", sitting: 2, text: () => "Is there one thing you want to have done in the next year or two? Say it the way you would say it to a friend." },
  { id: "outcome", sitting: 2, text: (c) => `Picture ${c.goal ? `"${c.goal}"` : "it"} done. What is the best thing about that?` },
  { id: "obstacle", sitting: 2, text: () => "What in you is most likely to get in the way?" },
  { id: "plan", sitting: 2, text: () => "So when that happens, what will you do? Say it as: if (that happens), then I (will do this)." },
  { id: "expect", sitting: 2, text: () => "How sure are you that you will get there, 1 to 5?" },
  { id: "mission", sitting: 2, text: () => "Last one. In one sentence, what is your life about? Rough is fine; it is yours to change." },
];

export interface InterviewState {
  v: 1;
  status: "active" | "paused" | "done";
  next: number;
  started: number;
  updated: number;
  answers: { id: Step; text: string; ts: number }[];
  proposed: string[];
  role?: string; value?: string; goal?: string;
}

const statePath = (vault: string) => join(compassMetaDir(vault), "interview.json");

export function readInterview(vault: string): InterviewState | null {
  try { return JSON.parse(readFileSync(statePath(vault), "utf8")) as InterviewState; } catch { return null; }
}
function save(vault: string, s: InterviewState): void {
  mkdirSync(compassMetaDir(vault), { recursive: true });
  writeFileSync(statePath(vault), `${JSON.stringify(s, null, 2)}\n`);
}

export const interviewActive = (vault: string) => readInterview(vault)?.status === "active";
export const TRIGGER = /\b(set up|start|continue|resume|finish)\b[^.?!]{0,20}\bcompass\b|\binterview me\b|^ask me more\b/i;
export const isInterviewTrigger = (text: string) => TRIGGER.test(text.trim());

/** Split an answer into short phrases in the user's own words. */
export function phrases(answer: string, max = 6): string[] {
  const lead = /^(i am|i'm|im|i'd say|probably|maybe|well|so|and|also|a|an|the|my|being)\s+/i;
  return answer
    .split(/\n|;|,|\.\s|\band\b|\balso\b/i)
    .map((p) => { let t = p.replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim(); for (let i = 0; i < 3; i++) t = t.replace(lead, ""); return t; })
    .filter((p) => p.length >= 2 && p.split(" ").length <= 8 && !/^(none|nothing|no|not really|n\/a)$/i.test(p))
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .slice(0, max);
}

const ctx = (vault: string, s: InterviewState): Ctx => {
  const doc = readCompass(vault);
  return {
    role: s.role, value: s.value ?? items(doc, "value").sort((a, b) => Number(a.tokens.rank ?? 99) - Number(b.tokens.rank ?? 99))[0]?.title, goal: s.goal,
    proposed: s.proposed.map((id) => findById(doc, id).item).filter((x): x is CompassItem => !!x && x.tokens.status === "proposed").map((x) => ({ id: x.id, kind: x.kind === "rule" ? "never trade" : x.kind, title: x.title })),
  };
};

function propose(vault: string, s: InterviewState, kind: Kind, titles: string[], answer: string, extra: Field[] = [], tokens: Record<string, string> = {}, now = Date.now()): string[] {
  const doc = readCompass(vault);
  const have = new Set(items(doc).map((i) => `${i.kind}:${i.title.toLowerCase()}`));
  const added: string[] = [];
  let rank = items(doc, "value").length;
  for (const title of titles) {
    if (have.has(`${kind}:${title.toLowerCase()}`)) continue;
    const id = compassId(kind, title);
    const t = { ...tokens, status: "proposed", ...(kind === "value" ? { rank: String(++rank) } : {}) };
    addItem(doc, { kind, id, title, done: kind === "goal" ? false : null, tokens: t, flags: [], fields: [{ key: "words", value: JSON.stringify(answer.trim().slice(0, 300)) }, ...extra, { key: "from", value: `Compass conversation, ${new Date(now).toISOString().slice(0, 10)}` }], paths: [], raw: [] });
    added.push(id);
  }
  if (added.length) saveCompass(vault, doc, added.map((id) => ({ id, from: "none", to: "proposed", reason: "Compass conversation", evidence: [answer.slice(0, 300)], by: "user" as const })), now);
  s.proposed.push(...added);
  return added;
}

function setField(vault: string, id: string, key: string, value: string, now: number): void {
  const doc = readCompass(vault);
  const it = findById(doc, id).item;
  if (!it) return;
  const v = JSON.stringify(value.trim().slice(0, 300));
  const f = it.fields.find((x) => x.key === key);
  if (f) f.value = v; else { const at = it.fields.findIndex((x) => x.key === "from"); if (at >= 0) it.fields.splice(at, 0, { key, value: v }); else it.fields.push({ key, value: v }); }
  it.dirty = true;
  saveCompass(vault, doc, [{ id, from: it.tokens.status ?? "confirmed", to: it.tokens.status ?? "confirmed", reason: `${key} in the Compass conversation`, evidence: [value.slice(0, 200)], by: "user" }], now);
}

function ask(vault: string, s: InterviewState): string {
  const q = QUESTIONS[s.next];
  return q ? q.text(ctx(vault, s)) : "";
}

/** Skip questions that no longer apply (nothing to confirm, no goal for the WOOP, a mission already written). */
function settle(vault: string, s: InterviewState): void {
  for (;;) {
    const q = QUESTIONS[s.next];
    if (!q) { s.status = "done"; return; }
    const c = ctx(vault, s);
    if (q.id === "confirm" && !c.proposed.length) { s.next++; continue; }
    if ((q.id === "outcome" || q.id === "obstacle" || q.id === "plan" || q.id === "expect") && !s.goal) { s.next++; continue; }
    if (q.id === "mission" && mission(readCompass(vault))?.text) { s.next++; continue; }
    if (q.id === "enough" && !c.value) { s.next++; continue; }
    return;
  }
}

export function startInterview(vault: string, now = Date.now()): { reply: string; state: InterviewState } {
  let s = readInterview(vault);
  if (s?.status === "done") return { reply: "We finished the Compass conversation. Your Compass page has everything; tell me anything new and I will offer it in the weekly review.", state: s };
  if (!s) s = { v: 1, status: "active", next: 0, started: now, updated: now, answers: [], proposed: [] };
  s.status = "active";
  s.updated = now;
  settle(vault, s);
  if ((s.status as string) === "done") { save(vault, s); return { reply: "Your Compass conversation is done.", state: s }; }
  const lead = s.answers.length ? "Picking up where we left off." : `Let's set up your Compass: a few questions, about five minutes today and a few more over the coming weeks. Say "later" to stop any time, "skip" to pass.`;
  save(vault, s);
  return { reply: `${lead}\n\n${ask(vault, s)}`, state: s };
}

export function pauseInterview(vault: string, now = Date.now()): void {
  const s = readInterview(vault);
  if (s && s.status === "active") { s.status = "paused"; s.updated = now; save(vault, s); }
}

/** One answer. Returns the reply: the next question, or where things stand. */
export function answerInterview(vault: string, text: string, now = Date.now()): { reply: string; state: InterviewState } {
  const s = readInterview(vault);
  if (!s || s.status !== "active") return startInterview(vault, now);
  const t = text.trim();
  if (/^(later|stop|pause|not now|enough for (now|today))\b/i.test(t)) {
    s.status = "paused"; s.updated = now; save(vault, s);
    return { reply: `Paused. Say "continue my Compass" any day to pick up here.`, state: s };
  }
  const q = QUESTIONS[s.next]!;
  const skip = /^(skip|pass|next)\b/i.test(t);
  if (!skip) {
    s.answers.push({ id: q.id, text: t.slice(0, 1000), ts: now });
    applyAnswer(vault, s, q.id, t, now);
  }
  s.next++;
  s.updated = now;
  settle(vault, s);
  // The first sitting ends after the confirm step: the rest waits a few days.
  const finishedSitting = q.id === "confirm" || (q.sitting === 1 && QUESTIONS[s.next]?.sitting === 2);
  if ((s.status as string) === "done") { save(vault, s); return { reply: "That is the whole Compass conversation. Thank you. It is all on your Compass page, in your words.", state: s }; }
  if (finishedSitting) {
    s.status = "paused";
    save(vault, s);
    const head = q.id === "confirm" ? confirmReply(t) : "";
    return { reply: `${head}That is enough for today. Your Compass has a start. I will ask a few more questions over the next weeks, one at a time, in your weekly review. Say "continue my Compass" to keep going now.`, state: s };
  }
  save(vault, s);
  return { reply: ask(vault, s), state: s };
}

function confirmReply(t: string): string {
  return /drop/i.test(t) ? "Done: I left those out and kept the rest. " : "Confirmed. ";
}

const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

function applyAnswer(vault: string, s: InterviewState, id: Step, t: string, now: number): void {
  if (id === "roles") {
    const added = propose(vault, s, "role", phrases(t), t, [], {}, now);
    s.role = added.length ? findById(readCompass(vault), added[0]!).item?.title : phrases(t)[0];
  } else if (id === "hope" || id === "fear") {
    const role = items(readCompass(vault), "role").find((r) => r.title === s.role) ?? items(readCompass(vault), "role")[0];
    if (role) setField(vault, role.id, id, t, now);
  } else if (id === "values" || id === "missing") {
    const added = propose(vault, s, "value", phrases(t, id === "values" ? 3 : 6), t, [], {}, now);
    if (id === "values" && added[0]) s.value = findById(readCompass(vault), added[0]).item?.title;
  } else if (id === "rules") {
    // "I would never miss the games" reads as the rule "Never miss the games" (the user's words, minus "I would").
    propose(vault, s, "rule", phrases(t).map((p) => p.replace(/^(?:I(?:'d| would| will|'ll)?\s+)?never\s+/i, "Never ")), t, [], {}, now);
  } else if (id === "confirm") {
    const c = ctx(vault, s);
    const ids = c.proposed.map((p) => p.id);
    const nums = [...t.matchAll(/\b(\d{1,2})\b/g)].map((m) => Number(m[1])).concat([...t.toLowerCase().matchAll(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/g)].map((m) => ORD[m[1]!]!));
    if (/drop|not|remove|leave out/i.test(t) && nums.length) {
      const gone = nums.map((n) => ids[n - 1]).filter((x): x is string => !!x);
      drop(vault, gone, "left out in the Compass conversation", now);
      confirm(vault, ids.filter((x) => !gone.includes(x)), "yes in the Compass conversation", now);
    } else if (/\b(yes|yep|yeah|all|correct|right|good|confirm)\b/i.test(t)) {
      confirm(vault, ids, "yes in the Compass conversation", now);
    }
  } else if (id === "enough") {
    const v = items(readCompass(vault), "value").find((x) => x.title === (s.value ?? ctx(vault, s).value));
    if (v) setField(vault, v.id, "enough", t, now);
  } else if (id === "goal") {
    const title = phrases(t, 1)[0] ?? t.slice(0, 80);
    const added = propose(vault, s, "goal", [title.length > 80 ? title.slice(0, 80) : title], t, [], {}, now);
    if (added[0]) { confirm(vault, added, "said in the Compass conversation", now); s.goal = title; s.proposed = s.proposed.filter((x) => x !== added[0]); }
  } else if (id === "outcome" || id === "obstacle" || id === "plan" || id === "expect") {
    const g = items(readCompass(vault), "goal").find((x) => x.title === s.goal);
    if (!g) return;
    if (id === "expect") { const n = Number(/[1-5]/.exec(t)?.[0]); if (n) setWoop(vault, g.id, { expect: n }, now); }
    else setWoop(vault, g.id, { [id]: t }, now);
  } else if (id === "mission") {
    const doc = readCompass(vault);
    const m = mission(doc);
    if (m && !m.text) {
      const sec = doc.sections.find((x) => x.kind === "mission")!;
      sec.mission = { text: t.replace(/\s+/g, " ").trim().slice(0, 400), tokens: {}, fields: [{ key: "words", value: JSON.stringify(t.trim().slice(0, 400)) }, { key: "from", value: `Compass conversation, ${new Date(now).toISOString().slice(0, 10)}` }], raw: [""], dirty: true };
      saveCompass(vault, doc, [{ id: "mission", from: "none", to: "confirmed", reason: "said in the Compass conversation", evidence: [t.slice(0, 300)], by: "user" }], now);
    }
  }
}

/** The next question the weekly review can carry (second sitting onward), if any. */
export function nextInterviewQuestion(vault: string): { id: string; text: string } | null {
  const s = readInterview(vault);
  if (!s || s.status === "done") return null;
  const copy = { ...s, answers: [...s.answers], proposed: [...s.proposed] };
  settle(vault, copy);
  const q = QUESTIONS[copy.next];
  return q && copy.status !== "done" ? { id: q.id, text: q.text(ctx(vault, copy)) } : null;
}

export function interviewExists(vault: string): boolean { return existsSync(statePath(vault)); }
