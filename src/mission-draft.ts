// Missions created by talking (Fru, 2026-10-02: "chat mode is the default: I
// describe the project, you figure out the details and fill the fields").
//
// One step per turn of the New mission conversation: the model reads what was
// said and proposes the mission's fields plus the ONE question that matters
// most next; code then checks every field before it reaches the draft. Dates
// must be real dates, domains, apps and specialists must exist, a person must
// be someone the vault knows AND the user named, a budget is a number. What
// fails a check is dropped (and said why), never guessed. Nothing is created
// here: the desktop creates the mission only on the user's explicit go.

import { existsSync, readdirSync } from "node:fs";

import { readChiefOfStaff } from "./chief-of-staff.ts";
import { listPages } from "./entities.ts";
import { appsContainer } from "./path-safety.ts";
import type { RouteRunner } from "./route.ts";
import { loadSpecialists } from "./specialists.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";

export interface DraftTurn { role: "user" | "assistant"; text: string }
export interface MissionDraft {
  name?: string; outcome?: string; why?: string; start?: string; target?: string;
  owner?: string; consult?: string[]; inform?: string[];
  apps?: string[]; specialists?: string[]; people?: string[];
  budgetUsd?: number; hoursWk?: number;
  milestones?: { title: string; due?: string }[];
  match?: { calendar?: string[]; email_from?: string[]; merchants?: string[] };
}
export interface Dropped { field: string; value: string; why: string }
export interface DraftReply {
  draft: MissionDraft;
  /** Fields this turn filled or changed. */
  filled: string[];
  dropped: Dropped[];
  /** The one question to ask next, or null when there is nothing that matters left. */
  question: string | null;
  /** What the chief of staff says back: a short acknowledgement, then the question. */
  reply: string;
  /** Name, outcome and target are known: the mission can be started. */
  ready: boolean;
  missing: ("name" | "outcome" | "target")[];
  /** The user's last message is an explicit go ("go", "start it", "yes, create it"). */
  go: boolean;
}

export interface DraftContext {
  today: string;
  domains: string[];
  never: string[];
  apps: string[];
  specialists: { id: string; name: string; returns: string }[];
  people: { id: string; name: string; aliases: string[] }[];
}

const REQUIRED = ["name", "outcome", "target"] as const;
const FALLBACK_Q: Record<(typeof REQUIRED)[number], string> = {
  name: "What should we call it?",
  outcome: "What does done look like, in a sentence?",
  target: "By when would you like it done?",
};
// An explicit go. A bare "yes" or "looks good" counts only as the answer to "say go" or "start it?".
const GO_RE = /^\s*(?:ok(?:ay)?[, ]+|yes[, ]+|yep[, ]+|great[, ]+|perfect[, ]+)?(?:go|go ahead|start(?: it| the mission)?|create(?: it| the mission)?|make it|do it|ship it|let'?s go|let'?s do it|start mission)\s*[.!]*\s*$/i;
const YES_RE = /^\s*(?:yes|yep|yeah|sure|ok(?:ay)?|looks good|sounds good|that'?s it|perfect|great)\s*[.!]*\s*$/i;

/** The vault as the extraction step sees it: names only, never contents. */
export function draftContext(vault: string, now = Date.now()): DraftContext {
  const domains = listDomainDirs(vault).map((d) => d.toLowerCase()).filter((d) => d !== "general" && !d.startsWith("_"));
  let never: string[] = [];
  try { never = readChiefOfStaff(vault).neverRead; } catch { /* no chief file */ }
  let apps: string[] = [];
  try { const root = appsContainer(vault); if (existsSync(root)) apps = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_")).map((e) => e.name); } catch { /* none */ }
  const specialists = loadSpecialists(vault).filter((s) => s.on).map((s) => ({ id: s.id, name: s.name, returns: s.returns }));
  let people: DraftContext["people"] = [];
  try { people = listPages(vault).filter((p) => p.kind === "person").map((p) => ({ id: p.id, name: p.doc.name, aliases: p.doc.aliases ?? [] })); } catch { /* none */ }
  return { today: new Date(now).toISOString().slice(0, 10), domains, never, apps, specialists, people };
}

/** A real calendar date: "2026-02-31" is not one. */
export function realYmd(s: unknown): string | null {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return null;
  const d = new Date(`${s.trim()}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s.trim() ? s.trim() : null;
}

/** "$1,500", "1500", 1500 to 1500; anything else to null. */
export function moneyOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,\s]/g, "").replace(/usd$/i, "")) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.round(n * 100) / 100 : null;
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length >= 2 && t.length <= max ? t : null;
};
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Check every field the model proposed against the vault. What passes goes into
 * the draft; the rest is dropped with a reason, never repaired by guessing.
 */
export function validateFields(raw: unknown, ctx: DraftContext, userText: string): { fields: MissionDraft; dropped: Dropped[] } {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: MissionDraft = {};
  const dropped: Dropped[] = [];
  const drop = (field: string, value: unknown, why: string) => dropped.push({ field, value: typeof value === "string" ? value : JSON.stringify(value), why });
  const said = words(userText);
  const named = (x: string) => said.includes(words(x));

  for (const k of ["name", "outcome", "why"] as const) {
    if (f[k] == null || f[k] === "") continue;
    const v = str(f[k], k === "name" ? 120 : k === "outcome" ? 300 : 600);
    if (v) out[k] = v; else drop(k, f[k], "not a short line of text");
  }
  for (const k of ["start", "target"] as const) {
    if (f[k] == null || f[k] === "") continue;
    const d = realYmd(f[k]);
    if (d) out[k] = d; else drop(k, f[k], "not a real date (YYYY-MM-DD)");
  }
  if (out.target && out.target < (out.start ?? ctx.today)) { drop("target", out.target, `before ${out.start ? "the start" : "today"}`); delete out.target; }

  // Domains: real ones only; a never-read domain only when the user named it.
  const domainOk = (field: string, d: unknown): string | null => {
    const s = typeof d === "string" ? d.trim().toLowerCase() : "";
    if (!s) return null;
    if (!ctx.domains.includes(s)) { drop(field, d, "no such domain"); return null; }
    if (ctx.never.includes(s) && !named(s)) { drop(field, d, "a domain you keep out unless you name it"); return null; }
    return s;
  };
  if (f.owner != null && f.owner !== "") { const o = domainOk("owner", f.owner); if (o) out.owner = o; }
  for (const k of ["consult", "inform"] as const) {
    if (!Array.isArray(f[k])) continue;
    const xs = [...new Set((f[k] as unknown[]).map((d) => domainOk(k, d)).filter((x): x is string => !!x && x !== out.owner))];
    out[k] = xs;
  }
  if (out.consult && out.inform) out.inform = out.inform.filter((d) => !out.consult!.includes(d));

  if (Array.isArray(f.apps)) out.apps = [...new Set((f.apps as unknown[]).filter((a) => { const ok = typeof a === "string" && ctx.apps.includes(a); if (!ok) drop("apps", a, "not a connected app"); return ok; }) as string[])];
  if (Array.isArray(f.specialists)) {
    const ids = new Set(ctx.specialists.map((s) => s.id));
    out.specialists = [...new Set((f.specialists as unknown[]).map((s) => (typeof s === "string" ? s.toLowerCase() : "")).filter((s) => { const ok = ids.has(s); if (!ok) drop("specialists", s, "no such specialist, or it is off"); return ok; }))];
  }
  // People: someone the vault knows, and the user said their name. Never invented.
  if (Array.isArray(f.people)) {
    const keep: string[] = [];
    for (const p of f.people as unknown[]) {
      const id = typeof p === "string" ? p.trim().toLowerCase() : "";
      const known = ctx.people.find((x) => x.id === id || x.id === `person/${id}`);
      if (!known) { drop("people", p, "not someone in your people"); continue; }
      if (![known.name, ...known.aliases, known.id.split("/")[1]!.replace(/-/g, " ")].some(named)) { drop("people", p, "you did not name them"); continue; }
      if (!keep.includes(known.id)) keep.push(known.id);
    }
    out.people = keep;
  }
  if (f.budgetUsd != null && f.budgetUsd !== "") { const b = moneyOf(f.budgetUsd); if (b !== null) out.budgetUsd = b; else drop("budgetUsd", f.budgetUsd, "not an amount"); }
  if (f.hoursWk != null && f.hoursWk !== "") { const h = moneyOf(f.hoursWk); if (h !== null && h <= 168) out.hoursWk = h; else drop("hoursWk", f.hoursWk, "not a number of hours a week"); }
  if (Array.isArray(f.milestones)) {
    out.milestones = [];
    for (const m of (f.milestones as unknown[]).slice(0, 8)) {
      const o = (m && typeof m === "object" ? m : { title: m }) as { title?: unknown; due?: unknown };
      const title = str(o.title, 120);
      if (!title) { drop("milestones", m, "no title"); continue; }
      const due = o.due == null || o.due === "" ? undefined : realYmd(o.due);
      if (due === null) drop("milestones", o.due, `the date for "${title}" is not a real date`);
      out.milestones.push({ title, ...(due ? { due } : {}) });
    }
  }
  if (f.match && typeof f.match === "object") {
    const m = f.match as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((x) => str(x, 60)).filter((x): x is string => !!x))].slice(0, 5) : []);
    const r = { calendar: list(m.calendar), email_from: list(m.email_from), merchants: list(m.merchants) };
    out.match = Object.fromEntries(Object.entries(r).filter(([, v]) => v.length));
  }
  return { fields: out, dropped };
}

/** The model's JSON, from a reply that may carry prose or a code fence around it. */
export function parseModelJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const v = JSON.parse(m[0]); return v && typeof v === "object" ? v as Record<string, unknown> : null; } catch { return null; }
}

/** One question, short: the text up to its first question mark. */
export function oneQuestion(q: unknown): string | null {
  if (typeof q !== "string") return null;
  const t = q.replace(/\s+/g, " ").trim();
  const i = t.indexOf("?");
  const one = (i >= 0 ? t.slice(0, i + 1) : t).trim();
  return one.length >= 4 && one.length <= 220 ? one : null;
}

export function buildDraftPrompt(turns: DraftTurn[], draft: MissionDraft, ctx: DraftContext): { system: string; prompt: string } {
  const system = [
    "You help a person start a mission: an effort with an outcome and an end date. Read the conversation and fill the mission's fields.",
    "Reply with ONE JSON object and nothing else:",
    '{"fields": {"name": "...", "outcome": "...", "why": "...", "start": "YYYY-MM-DD", "target": "YYYY-MM-DD", "owner": "<domain>", "consult": ["<domain>"], "inform": ["<domain>"], "apps": ["<app id>"], "specialists": ["<specialist id>"], "people": ["person/<slug>"], "budgetUsd": 0, "hoursWk": 0, "milestones": [{"title": "...", "due": "YYYY-MM-DD"}], "match": {"calendar": ["..."], "email_from": ["..."], "merchants": ["..."]}},',
    ' "say": "one short sentence acknowledging what you learned", "question": "the ONE question that matters most now, or null"}',
    "Domains have roles: owner is the one domain the mission belongs to; consult are domains whose context it reads along (\"money should read along\", \"check with health\"); inform are domains that only get told the outcome.",
    "Rules: include only fields the conversation supports; leave the rest out. Use only the ids listed below. Never add a person the user did not name. Resolve relative dates (\"by June\", \"in three months\") against today. A name is short, starts with a verb or a noun, and has no date in it. The outcome is what done looks like, in the user's terms.",
    "Ask about the target date, the outcome and the budget before anything else, one at a time. Do not ask about something already in the draft. When name, outcome and target are known and nothing else clearly matters, set question to null and say the mission is ready to start.",
    "No em dashes. Plain words.",
  ].join("\n");
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "(none)");
  const prompt = [
    `Today: ${ctx.today}`,
    `Domains: ${list(ctx.domains)}`,
    `Apps: ${list(ctx.apps)}`,
    `Specialists: ${list(ctx.specialists.map((s) => `${s.id} (${s.name}, returns ${s.returns})`))}`,
    `People: ${list(ctx.people.slice(0, 200).map((p) => `${p.id} (${p.name})`))}`,
    `Draft so far: ${JSON.stringify(draft)}`,
    "Conversation:",
    ...turns.slice(-16).map((t) => `${t.role === "user" ? "User" : "You"}: ${t.text.slice(0, 1500)}`),
  ].join("\n");
  return { system, prompt };
}

export async function draftMission(vault: string, i: { turns: DraftTurn[]; draft?: MissionDraft; now?: number; runner?: RouteRunner; ctx?: DraftContext }): Promise<DraftReply> {
  const ctx = i.ctx ?? draftContext(vault, i.now);
  const turns = (i.turns ?? []).filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string" && t.text.trim());
  const userText = turns.filter((t) => t.role === "user").map((t) => t.text).join("\n");
  // The previous draft was checked once already; check it again, the vault may have moved.
  const prev = validateFields(i.draft ?? {}, ctx, userText).fields;
  let parsed: Record<string, unknown> | null = null;
  if (turns.some((t) => t.role === "user")) {
    const runner = i.runner ?? (await import("./route.ts")).claudeRouteRunner;
    const { system, prompt } = buildDraftPrompt(turns, prev, ctx);
    // One retry: a reply that does not parse (or a timeout) is usually a one-off.
    for (let n = 0; n < 2 && !parsed; n++) {
      try { parsed = parseModelJson(await runner({ system, prompt, timeoutMs: 45_000 })); } catch { parsed = null; }
    }
  }
  const { fields, dropped } = validateFields(parsed?.fields ?? {}, ctx, userText);
  const draft: MissionDraft = { ...prev };
  const filled: string[] = [];
  for (const [k, v] of Object.entries(fields) as [keyof MissionDraft, unknown][]) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(v)) filled.push(k);
    (draft as Record<string, unknown>)[k] = v;
  }
  const missing = REQUIRED.filter((k) => !draft[k]);
  const ready = missing.length === 0;
  const last = [...turns].reverse().find((t) => t.role === "user")?.text ?? "";
  const asked = [...turns].reverse().find((t, n, a) => t.role === "assistant" && a.slice(0, n).some((x) => x.role === "user"))?.text ?? "";
  const go = ready && (GO_RE.test(last) || (YES_RE.test(last) && /\b(go|start)\b/i.test(asked)));
  let question = oneQuestion(parsed?.question);
  if (!question && missing.length) question = FALLBACK_Q[missing[0]!];
  if (question && ready && go) question = null;
  const say = typeof parsed?.say === "string" ? parsed.say.replace(/\s+/g, " ").replace(/\s+[\u2013\u2014-]\s+/g, ", ").replace(/[\u2013\u2014]/g, ",").trim().slice(0, 240) : "";
  const reply = !parsed && turns.some((t) => t.role === "user")
    ? `I could not read that just now. ${question ?? "Tell me a little more about it?"}`
    : [say, question ?? (ready ? "Say go to start it, or keep adding details." : "")].filter(Boolean).join(" ");
  return { draft, filled, dropped, question, reply: reply || (question ?? ""), ready, missing: [...missing], go };
}

/**
 * Start the mission from a chat draft: the user said go. Every field is checked
 * again here (the draft came back through the desktop), then created as one
 * mission with its match rules.
 */
export async function createFromDraft(vault: string, raw: unknown, now = Date.now()): Promise<{ mission: import("./missions.ts").MissionView; dropped: Dropped[] }> {
  const ctx = draftContext(vault, now);
  // People were checked against the user's words when drafted; here they must still exist.
  const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const names = Array.isArray(r.people) ? (r.people as unknown[]).map((p) => ctx.people.find((x) => x.id === p)?.name ?? "").join(" ") : "";
  const { fields: d, dropped } = validateFields(raw, ctx, names);
  if (!d.name) throw new Error("a mission needs a name");
  const ms = await import("./missions.ts");
  const domains = [
    ...(d.owner ? [{ slug: d.owner, role: "owner" as const }] : []),
    ...(d.consult ?? []).map((slug) => ({ slug, role: "consulted" as const })),
    ...(d.inform ?? []).map((slug) => ({ slug, role: "informed" as const })),
  ];
  let mission = ms.createMission(vault, {
    name: d.name, outcome: d.outcome, why: d.why, start: d.start, target: d.target, domains,
    apps: d.apps, specialists: d.specialists, people: d.people, budgetUsd: d.budgetUsd, hoursWk: d.hoursWk,
    milestones: d.milestones, from: "from a conversation", now,
  });
  if (d.match && Object.keys(d.match).length) mission = ms.setMission(vault, mission.slug, { match: d.match }, now);
  return { mission, dropped };
}
