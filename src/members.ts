// Group chat: a thread can have several specialists as members, and the chief
// of staff passes each user turn through to the ones it concerns, who answer
// in the thread as themselves (ux ask 5, 2026-10-02).
//
// Routing is code first, in this order:
//   1. Explicit: chips (`to`) and leading "@A @B" in the user's own text. Always
//      wins, in every scope (General included), and never asks a model.
//   2. Members: each member's cue words and mandate against the message; the
//      top score answers. Only a tie between members spends one cheap model call.
//   3. Nothing matched: the turn goes on as before (the chief of staff answers).
// "just you" at the start of a message skips the members for that turn.
//
// A member's answer is one turn on the user's runtime with read-only tools; the
// ceilings that keep acting tools away from specialists hold here too (a
// specialist above act-ask, or an outside agent, never answers in a thread).
// Long or costly work becomes the existing job card instead (jobs.ts).

import { userText } from "./linking.ts";
import type { RouteRunner } from "./route.ts";
import { ceilingRank, loadSpecialists, type Specialist } from "./specialists.ts";

/** What each reply records at send time, stored with the turn. */
export interface TurnMeta {
  /** "chief" or a specialist id. */
  speaker: string;
  /** The speaker's name when the reply was written. */
  name?: string;
  members?: string[];
  /** The scope label: a domain, a project, an entity or "general". */
  scope?: string;
  /** The context the turn used (apps, entities, domains, files). */
  context?: string[];
}

export interface Routed { specialist: string; name: string; why: string }
export interface MemberRoute { route: Routed[]; explicit: boolean; ask: string }

const AT = /^\s*@([A-Za-z][A-Za-z-]{1,40})\b[:,]?\s*/;
const JUST_YOU = /^\s*(just you|only you|you alone)\b[:,.]?\s*/i;
const MAX_EXPLICIT = 4;

/** The leading "@A @B" names of a message, and the rest of it. */
export function leadingMentions(text: string): { names: string[]; rest: string } {
  const names: string[] = [];
  let rest = text;
  for (let m = AT.exec(rest); m; m = AT.exec(rest)) { names.push(m[1]!); rest = rest.slice(m[0].length); }
  return { names, rest };
}

/** What the user typed on this turn: after the desktop's "User's next message:" when there is one. */
export function visibleText(message: string): string {
  const k = message.lastIndexOf("User's next message: ");
  return (k >= 0 ? message.slice(k + "User's next message: ".length) : userText(message)).trim();
}

function byName(specs: Specialist[], name: string): Specialist | undefined {
  const n = name.trim().toLowerCase();
  return specs.find((s) => s.on && (s.id === n || s.name.toLowerCase() === n));
}

// The words that say a message is a member's kind of work.
const CUES: Record<string, RegExp> = {
  researcher: /\b(find|research|look (into|up)|sources?|compare|best|options?|evidence|studies|study|reviews?|which one|what are)\b/gi,
  scout: /\b(what else|ideas?|discover|surprise|missing|alternatives?|didn'?t think of|new)\b/gi,
  planner: /\b(plan|plans|steps?|schedule|timeline|roadmap|milestones?|sequence|next steps?|organi[sz]e|week|order of)\b/gi,
  steward: /\b(should i|fits?|values?|ideal|worth it|align(ed|ment)?|priorit(y|ies|i[sz]e))\b/gi,
  editor: /\b(summar(y|i[sz]e)|one page|brief|outline|tidy|format)\b/gi,
  writer: /\b(draft|write|email|letter|message|reply|wording|word it|note to)\b/gi,
  analyst: /\b(numbers?|spend(ing)?|budget|how much|average|trend|chart|percent|costs?)\b/gi,
  historian: /\b(last time|history|when did|what happened|previously|decided|used to)\b/gi,
  sentinel: /\b(deadlines?|due|risks?|expir(e|es|ing)|overdue|slipping|renewal)\b/gi,
  auditor: /\b(verify|double-?check|accurate|correct|fact-?check)\b/gi,
  builder: /\b(build|script|code|automat(e|ion)|tool|app|site)\b/gi,
  clerk: /\b(file|folder|receipts?|paperwork|inbox)\b/gi,
  operator: /\b(book|order|buy|cancel|renew|pay|sign up)\b/gi,
  coach: /\b(goals?|habits?|motivat\w*|stuck|accountab\w*)\b/gi,
  skeptic: /\b(what could go wrong|pre-?mortem|downsides?|fail(ure)?)\b/gi,
  interviewer: /\b(ask me|interview)\b/gi,
  mechanic: /\b(connectors?|sync(ing)?|broken|failing)\b/gi,
  negotiator: /\b(negotiat\w*|haggle|counter(offer)?|discount|deal)\b/gi,
  liaison: /\b(call|check in|catch up|reach out|birthday|friends?|family)\b/gi,
  tutor: /\b(learn|teach|quiz|explain|lessons?)\b/gi,
  confidant: /\b(feel(ing)?s?|reflect|journal|dreams?|worried|anxious)\b/gi,
};

const STOP = new Set(["about", "their", "there", "which", "would", "never", "every", "where", "these", "those", "other", "after", "before", "under", "while", "being", "having", "result", "specialist"]);

/** How much a message is this member's kind of work (0 = not at all). */
export function memberScore(s: Specialist, message: string): number {
  const t = message.toLowerCase();
  let n = (message.match(CUES[s.id] ?? /$^/g) ?? []).length * 2;
  if (new RegExp(`\\b${s.name.toLowerCase().replace(/[^a-z0-9 ]/g, "")}\\b`).test(t)) n += 3;
  // A custom specialist has no cue list: its mandate's longer words stand in.
  if (!CUES[s.id]) for (const w of new Set(s.mandate.toLowerCase().match(/[a-z]{6,}/g) ?? [])) if (!STOP.has(w) && t.includes(w)) n += 1;
  return n;
}

/** The members (or named specialists) who answer this turn. */
export async function routeTurn(vault: string, i: { message: string; to?: string[]; members?: string[]; runner?: RouteRunner | null; specs?: Specialist[] }): Promise<MemberRoute> {
  const said = i.message.trim();
  if (JUST_YOU.test(said)) return { route: [], explicit: true, ask: said.replace(JUST_YOU, "") || said };
  const lead = leadingMentions(said);
  // Nothing named and no members: an ordinary turn, nothing read.
  if (!i.to?.length && !lead.names.length && !i.members?.length) return { route: [], explicit: false, ask: said };
  const specs = i.specs ?? loadSpecialists(vault);
  const named: Routed[] = [];
  for (const n of [...(i.to ?? []), ...lead.names]) {
    const s = byName(specs, n);
    if (s && !named.some((x) => x.specialist === s.id)) named.push({ specialist: s.id, name: s.name, why: "named by you" });
  }
  // A leading name that is no specialist stays in the text (it may be a person).
  const ask = (lead.names.every((n) => byName(specs, n)) ? lead.rest : said).trim() || said;
  if (named.length) return { route: named.slice(0, MAX_EXPLICIT), explicit: true, ask };

  const members = [...new Set(i.members ?? [])].map((m) => byName(specs, m)).filter((s): s is Specialist => !!s);
  if (!members.length) return { route: [], explicit: false, ask };
  const scored = members.map((s) => ({ s, n: memberScore(s, ask) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  if (!scored.length) return { route: [], explicit: false, ask };
  const top = scored.filter((x) => x.n === scored[0]!.n);
  if (top.length === 1) return { route: [{ specialist: top[0]!.s.id, name: top[0]!.s.name, why: "fits the message" }], explicit: false, ask };
  // A tie: one cheap model call picks, from the tied members only.
  let picked = top.slice(0, 2).map((x) => x.s);
  if (i.runner) {
    try {
      const raw = await i.runner({
        system: "You route a chat message to the team members who should answer it. Reply with member ids only, comma separated, best first, at most two.",
        prompt: `Message: ${ask.slice(0, 1500)}\n\nMembers:\n${top.map((x) => `${x.s.id}: ${x.s.mandate.split("\n")[0]!.slice(0, 200)}`).join("\n")}`,
        timeoutMs: 20_000,
      });
      const ids = (raw.toLowerCase().match(/[a-z][a-z0-9-]*/g) ?? []).filter((x) => top.some((t) => t.s.id === x));
      if (ids.length) picked = [...new Set(ids)].slice(0, 2).map((x) => top.find((t) => t.s.id === x)!.s);
    } catch { /* the code pick stands */ }
  }
  return { route: picked.map((s) => ({ specialist: s.id, name: s.name, why: "fits the message" })), explicit: false, ask };
}

// Work too big for one answer in the thread: a deliverable, or depth asked for.
const LONG = /\b(deep|thorough(ly)?|in[- ]depth|comprehensive|full report|a report|one[- ]page|a page|spreadsheet|every|all of (my|the)|as a job|in the background)\b/i;
export function longWork(ask: string): boolean { return LONG.test(ask) || ask.length > 1200; }

/** May this specialist answer in a thread? Null when yes; otherwise why not. Enforced in code. */
export function cannotAnswer(s: Specialist): string | null {
  if (!s.on) return `the ${s.name} is off`;
  if (ceilingRank(s.ceiling) > ceilingRank("act-ask")) return `the ${s.name} would act on its own; that is never allowed`;
  if (s.outside) return `the ${s.name} is an outside agent; it only works as a job, with your yes for each brief`;
  return null;
}

/** The read-only built-ins a member may use while answering (never one that writes or runs commands). */
export function memberTools(s: Specialist): string[] {
  return [...(s.tools.includes("web") ? ["WebSearch", "WebFetch"] : []), ...(s.tools.includes("vault-read") ? ["Read", "Grep", "Glob"] : [])];
}

/** The block that makes a turn this member's answer. */
export function memberPrompt(s: Specialist, o: { notes?: string; chief: string | null; members: string[]; earlier: { name: string; text: string }[]; explicit: boolean }): string {
  return [
    `You are the ${s.name}, a specialist in a group chat with the user${o.chief ? ` and ${o.chief}, their chief of staff` : " and their chief of staff"}. ${o.explicit ? "The user asked you by name." : `${o.chief ?? "The chief of staff"} passed this message to you because it is your kind of work.`}`,
    "Answer the user directly, as yourself, in plain words. Be short: lead with the answer. You never contact anyone, buy anything or change anything; if something needs doing, say what and the user decides.",
    `## Mandate\n${s.mandate}`,
    s.method ? `## Method\n${s.method}` : "",
    s.never ? `## Never\n${s.never}` : "",
    o.notes ? `## The user's instructions for you here\n${o.notes}` : "",
    o.members.length > 1 ? `Members of this chat: ${o.members.join(", ")}.` : "",
    o.earlier.length ? `## Already said on this turn\n${o.earlier.map((e) => `### ${e.name}\n${e.text.slice(0, 1500)}`).join("\n\n")}\nDo not repeat it. Add only what is new from your side; if you have nothing to add, say so in one line.` : "",
  ].filter(Boolean).join("\n\n");
}

/** The chief of staff's closing line after several members answered: only when they disagree or the user must decide. */
export async function closingLine(runner: RouteRunner, ask: string, replies: { name: string; text: string }[]): Promise<string | null> {
  try {
    const raw = await runner({
      system: "You are a chief of staff reading your team's answers. If they disagree, or something needs the user's decision, write ONE short sentence that names it. Otherwise reply exactly NONE.",
      prompt: `The user asked: ${ask.slice(0, 1000)}\n\n${replies.map((r) => `${r.name}: ${r.text.slice(0, 1500)}`).join("\n\n")}`,
      timeoutMs: 20_000,
    });
    const line = raw.trim().split("\n")[0]!.trim();
    return !line || /^none\b/i.test(line) ? null : line.slice(0, 300);
  } catch { return null; }
}
