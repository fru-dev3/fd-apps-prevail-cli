// The Compass: the user's mission, values, roles, goals and their paths,
// non-negotiables, negotiables and capacity, in one plain file,
// build/compass.md. The user owns the what and the why; every line is in the
// user's own words (a quote from them is kept beside it), and nothing a model
// drafts counts until the user confirms it.
//
//   # Compass
//
//   ## Mission
//   Live fully. Love deeply.
//   ~status:proposed
//     words: "Live fully. Love deeply."
//     from: build/ideal-state.md
//
//   ## Values
//   - Peace of mind ~id:v-peace ~rank:2 ~tier:1
//     words: "Grow wealth while preserving peace of mind."
//     enough: calm 4 of 5 most weeks
//   ## Roles
//   - Father ~id:r-father ~people:person/<slug>
//     hope: "..."
//   ## Goals
//   - [ ] Financial independence ~id:g-fi ~serves:v-freedom,v-peace ~status:active ~due:2028-12-31
//     why: "..."
//     path: Cash buffer first ~id:p-buffer ~status:proposed
//       expect: 12 months of costs in cash by 2027-06
//   ## Non-negotiables
//   - Home for dinner 5 nights a week ~id:nn-dinner ~check:dinners_home_wk>=5
//   ## Negotiables
//   - Stay in Minnesota ~id:ng-mn
//     trade: "Would move for the right role."
//   ## Capacity
//   - hours_for_goals_wk: 10
//
// Grammar: "- " items with ~key:value tokens (a bare ~local marks a line that
// never goes to a cloud model); indented "key: value" lines belong to the item
// above; "path:" lines (goals only) are items of their own, with their fields
// indented one level more. Unknown lines and sections are kept verbatim, and
// an item nobody changed is written back byte for byte.
//
// Statuses: a proposed line carries ~status:proposed. Confirming a goal makes
// it active once its WOOP is done (outcome, obstacle, an if-then plan), else
// "confirmed" (the user's, not started); confirming a value, role, rule or negotiable drops the token
// (they are ranked and versioned, never done). Every confirmed change keeps
// the prior file in build/compass.versions/<ISO>.md and adds a line to
// build/_meta/compass/ledger.jsonl.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { buildRoot, resolveDomainDir, runtimePath } from "./path-safety.ts";
import { vreadFile } from "./vault-session.ts";
import { listVersions, writeVersioned } from "./goals.ts";
import { parseModArgs } from "./cli-args.ts";

export type Kind = "value" | "role" | "goal" | "rule" | "negotiable" | "capacity" | "routine" | "other";

export interface Field { key: string; value: string }
export interface CompassPath { id: string; title: string; tokens: Record<string, string>; fields: Field[] }
export interface CompassItem {
  kind: Kind;
  id: string;
  title: string;
  done: boolean | null;        // goals only: [ ] or [x]
  tokens: Record<string, string>;
  flags: string[];             // bare markers such as "local"
  fields: Field[];
  paths: CompassPath[];
  raw: string[];               // the lines as read; written back unless dirty
  dirty?: boolean;
}
export interface Mission { text: string; tokens: Record<string, string>; fields: Field[]; raw: string[]; dirty?: boolean }
type Block = { item: CompassItem } | { raw: string };
export interface CompassSection { heading: string; kind: Kind | "mission"; blocks: Block[]; mission?: Mission }
export interface CompassDoc { head: string[]; sections: CompassSection[] }

const SECTION_KIND: Record<string, Kind | "mission"> = {
  mission: "mission", values: "value", roles: "role", goals: "goal",
  "non-negotiables": "rule", rules: "rule", negotiables: "negotiable", capacity: "capacity", routines: "routine",
};
export const SECTION_TITLE: Record<Exclude<Kind, "other"> | "mission", string> = {
  mission: "Mission", value: "Values", role: "Roles", goal: "Goals", rule: "Non-negotiables",
  negotiable: "Negotiables", capacity: "Capacity", routine: "Routines",
};
const ORDER: (Exclude<Kind, "other"> | "mission")[] = ["mission", "value", "role", "goal", "rule", "negotiable", "capacity", "routine"];
const PREFIX: Record<Kind, string> = { value: "v", role: "r", goal: "g", rule: "nn", negotiable: "ng", capacity: "c", routine: "rt", other: "x" };

const TOKEN = /\s+~([a-z][a-z0-9_-]*)(?::(\S+))?/g;

function splitTokens(s: string): { title: string; tokens: Record<string, string>; flags: string[] } {
  const tokens: Record<string, string> = {};
  const flags: string[] = [];
  const title = ` ${s}`.replace(TOKEN, (_m, k: string, v?: string) => { if (v === undefined) flags.push(k); else tokens[k] = v; return ""; }).trim();
  return { title, tokens, flags };
}

export function compassId(kind: Kind, title: string): string {
  return `${PREFIX[kind]}-${createHash("sha1").update(`${kind}\n${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`).digest("hex").slice(0, 6)}`;
}

function parseItem(kind: Kind, lines: string[]): CompassItem {
  const first = lines[0]!.replace(/^-\s+/, "");
  let done: boolean | null = null;
  let rest = first;
  const box = /^\[( |x|X)\]\s+/.exec(first);
  if (box) { done = box[1] !== " "; rest = first.slice(box[0].length); }
  const { title, tokens, flags } = splitTokens(rest);
  const item: CompassItem = { kind, id: tokens.id ?? compassId(kind, title), title, done, tokens, flags, fields: [], paths: [], raw: lines };
  let path: CompassPath | null = null;
  for (const l of lines.slice(1)) {
    const pm = /^ {2,3}path:\s*(.*)$/.exec(l);
    if (pm) {
      const t = splitTokens(pm[1]!);
      path = { id: t.tokens.id ?? compassId("other", t.title), title: t.title, tokens: t.tokens, fields: [] };
      item.paths.push(path);
      continue;
    }
    const deep = /^ {4,}([a-z][a-z0-9_ -]*):\s*(.*)$/i.exec(l);
    if (deep && path) { path.fields.push({ key: deep[1]!.trim(), value: deep[2]! }); continue; }
    const f = /^\s+([a-z][a-z0-9_ -]*):\s*(.*)$/i.exec(l);
    if (f) { path = null; item.fields.push({ key: f[1]!.trim(), value: f[2]! }); }
  }
  return item;
}

function parseMission(lines: string[]): Mission {
  const m: Mission = { text: "", tokens: {}, fields: [], raw: lines };
  const text: string[] = [];
  for (const l of lines) {
    if (/^~\S/.test(l.trim()) && /^\s*~/.test(l)) { Object.assign(m.tokens, splitTokens(` ${l.trim()}`).tokens); continue; }
    const f = /^\s{2,}([a-z][a-z0-9_ -]*):\s*(.*)$/i.exec(l);
    if (f) { m.fields.push({ key: f[1]!.trim(), value: f[2]! }); continue; }
    text.push(l);
  }
  m.text = text.join("\n").trim();
  return m;
}

export function parseCompass(body: string): CompassDoc {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const doc: CompassDoc = { head: [], sections: [] };
  let sec: CompassSection | null = null;
  let buf: string[] = [];
  const flushMission = () => { if (sec?.kind === "mission") sec.mission = parseMission(buf); buf = []; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const h = /^##\s+(.+?)\s*$/.exec(l);
    if (h) {
      flushMission();
      sec = { heading: l, kind: SECTION_KIND[h[1]!.toLowerCase()] ?? "other", blocks: [] };
      doc.sections.push(sec);
      continue;
    }
    if (!sec) { doc.head.push(l); continue; }
    if (sec.kind === "mission") { buf.push(l); continue; }
    if (sec.kind !== "other" && /^- \S/.test(l)) {
      const item = [l];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) item.push(lines[++i]!);
      sec.blocks.push({ item: parseItem(sec.kind as Kind, item) });
      continue;
    }
    sec.blocks.push({ raw: l });
  }
  flushMission();
  return doc;
}

const tokenStr = (t: Record<string, string>, flags: string[] = []) =>
  Object.entries(t).map(([k, v]) => ` ~${k}:${v.replace(/\s+/g, "-")}`).join("") + flags.map((f) => ` ~${f}`).join("");
// Prose rule: a spaced em or en dash becomes a comma (as in migrated goals).
const clean = (s: string) => s.replace(/\s*\u2014\s*/g, ", ").replace(/\s+\u2013\s+/g, ", ").replace(/\s+/g, " ").trim();

export function renderItem(it: CompassItem): string[] {
  const box = it.kind === "goal" ? `[${it.done ? "x" : " "}] ` : "";
  const out = [`- ${box}${clean(it.title)}${tokenStr({ id: it.id, ...it.tokens }, it.flags)}`];
  for (const f of it.fields) out.push(`  ${f.key}: ${clean(f.value)}`);
  for (const p of it.paths) {
    out.push(`  path: ${clean(p.title)}${tokenStr({ id: p.id, ...p.tokens })}`);
    for (const f of p.fields) out.push(`    ${f.key}: ${clean(f.value)}`);
  }
  return out;
}

function renderMission(m: Mission): string[] {
  const out = m.text ? m.text.split("\n") : [];
  if (Object.keys(m.tokens).length) out.push(tokenStr(m.tokens).trim());
  for (const f of m.fields) out.push(`  ${f.key}: ${clean(f.value)}`);
  return out;
}

export function serializeCompass(doc: CompassDoc): string {
  const out: string[] = [...doc.head];
  for (const s of doc.sections) {
    out.push(s.heading);
    if (s.kind === "mission" && s.mission) {
      if (s.mission.dirty) out.push("", ...renderMission(s.mission), "");
      else out.push(...s.mission.raw);
      continue;
    }
    for (const b of s.blocks) {
      if ("raw" in b) out.push(b.raw);
      else out.push(...(b.item.dirty ? renderItem(b.item) : b.item.raw));
    }
  }
  const text = out.join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

export const items = (doc: CompassDoc, kind?: Kind): CompassItem[] =>
  doc.sections.flatMap((s) => s.blocks.flatMap((b) => ("item" in b && (!kind || b.item.kind === kind) ? [b.item] : [])));
export const mission = (doc: CompassDoc): Mission | null => doc.sections.find((s) => s.kind === "mission")?.mission ?? null;
export const isProposed = (x: { tokens: Record<string, string> }) => x.tokens.status === "proposed";
const field = (x: { fields: Field[] }, k: string) => x.fields.find((f) => f.key === k)?.value;

function section(doc: CompassDoc, kind: Exclude<Kind, "other"> | "mission"): CompassSection {
  let s = doc.sections.find((x) => x.kind === kind);
  if (s) return s;
  s = { heading: `## ${SECTION_TITLE[kind]}`, kind, blocks: kind === "mission" ? [] : [{ raw: "" }] };
  if (kind === "mission") s.mission = { text: "", tokens: {}, fields: [], raw: [""], dirty: true };
  // Keep the canonical order: insert before the first section that comes after it.
  const at = doc.sections.findIndex((x) => x.kind !== "other" && ORDER.indexOf(x.kind as typeof ORDER[number]) > ORDER.indexOf(kind));
  if (at < 0) doc.sections.push(s); else doc.sections.splice(at, 0, s);
  return s;
}

/** Add an item to its section (after the section's last item), marked dirty. */
export function addItem(doc: CompassDoc, it: CompassItem): void {
  const s = section(doc, it.kind as Exclude<Kind, "other">);
  it.dirty = true;
  let last = -1;
  s.blocks.forEach((b, i) => { if ("item" in b) last = i; });
  if (last < 0) {
    // An empty section: a blank line, the item, a blank line before the next heading.
    const lead = s.blocks.length && "raw" in s.blocks[0]! && s.blocks[0].raw === "" ? 1 : 0;
    if (!lead) s.blocks.unshift({ raw: "" });
    s.blocks.splice(1, 0, { item: it });
    const next = s.blocks[2];
    if (!next || !("raw" in next) || next.raw !== "") s.blocks.splice(2, 0, { raw: "" });
  } else s.blocks.splice(last + 1, 0, { item: it });
}

export function findById(doc: CompassDoc, id: string): { item?: CompassItem; path?: CompassPath; parent?: CompassItem; mission?: Mission } {
  if (id === "mission") { const m = mission(doc); return m ? { mission: m } : {}; }
  for (const it of items(doc)) {
    if (it.id === id) return { item: it };
    const p = it.paths.find((x) => x.id === id);
    if (p) return { path: p, parent: it };
  }
  return {};
}

// ── The file ────────────────────────────────────────────────────────────────

export function compassPath(vault: string): string { return join(buildRoot(vault), "compass.md"); }
export function compassMetaDir(vault: string): string { return join(runtimePath(vault, "_meta"), "compass"); }
const EMPTY = "# Compass\n\n## Mission\n\n## Values\n\n## Roles\n\n## Goals\n\n## Non-negotiables\n\n## Negotiables\n";

function readText(p: string): string {
  if (!existsSync(p)) return "";
  try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } }
}

export function readCompass(vault: string): CompassDoc {
  return parseCompass(readText(compassPath(vault)) || EMPTY);
}

export interface LedgerLine { ts: number; id: string; from: string; to: string; reason: string; evidence?: string[]; by: "user" | "model" | "bootstrap" }

function appendJsonl(p: string, rows: unknown[]): void {
  if (!rows.length) return;
  mkdirSync(join(p, ".."), { recursive: true });
  appendFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Write the Compass: the prior text is kept as a version; each change is a ledger line. */
export function saveCompass(vault: string, doc: CompassDoc, changes: Omit<LedgerLine, "ts">[], now = Date.now()): string | null {
  const kept = writeVersioned(compassPath(vault), serializeCompass(doc), now);
  appendJsonl(join(compassMetaDir(vault), "ledger.jsonl"), changes.map((c) => ({ ts: now, ...c })));
  return kept;
}

export function readLedger(vault: string): LedgerLine[] {
  return readText(join(compassMetaDir(vault), "ledger.jsonl")).split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as LedgerLine]; } catch { return []; } });
}

const statusOf = (x: { tokens: Record<string, string> }, kind: Kind | "mission") => x.tokens.status ?? (kind === "goal" ? "active" : "confirmed");

// WOOP (wish, outcome, obstacle, plan): a goal goes active only once it has
// the outcome the user pictures, the obstacle inside them, and an if-then
// plan, in their words. Until then a confirmed goal is "confirmed" (theirs,
// not started). An expectation of 1 or 2 out of 5 makes it a small trial
// ("prototyping") instead.
export const IF_THEN = /\bif\b[\s\S]{2,}?(\bthen\b|,)/i;
export function woopComplete(it: { fields: Field[] }): boolean {
  const f = (k: string) => (field(it, k) ?? "").replace(/^"|"$/g, "").trim();
  return !!f("outcome") && !!f("obstacle") && IF_THEN.test(f("plan"));
}
const activeOrTrial = (it: CompassItem) => (Number(field(it, "expect") ?? 5) <= 2 ? "prototyping" : "active");

/** Confirm proposed lines (all, or by id). A goal becomes active when its WOOP is done, else confirmed; others lose the token. */
export function confirm(vault: string, ids: string[] | "all", reason = "confirmed", now = Date.now()): string[] {
  const doc = readCompass(vault);
  const changes: Omit<LedgerLine, "ts">[] = [];
  const want = (id: string) => ids === "all" || ids.includes(id);
  const m = mission(doc);
  if (m && isProposed(m) && want("mission")) { delete m.tokens.status; m.dirty = true; changes.push({ id: "mission", from: "proposed", to: "confirmed", reason, by: "user" }); }
  for (const it of items(doc)) {
    if (isProposed(it) && want(it.id)) {
      if (it.kind === "goal") it.tokens.status = woopComplete(it) ? activeOrTrial(it) : "confirmed"; else delete it.tokens.status;
      it.dirty = true;
      changes.push({ id: it.id, from: "proposed", to: statusOf(it, it.kind), reason, by: "user" });
    }
  }
  if (changes.length) saveCompass(vault, doc, changes, now);
  return changes.map((c) => c.id);
}

/** Drop a proposed line. It leaves the file; the prior text stays in a version and the ledger keeps its words. */
export function drop(vault: string, ids: string[], reason = "dropped", now = Date.now()): string[] {
  const doc = readCompass(vault);
  const changes: Omit<LedgerLine, "ts">[] = [];
  for (const s of doc.sections) {
    s.blocks = s.blocks.filter((b) => {
      if (!("item" in b) || !ids.includes(b.item.id) || !isProposed(b.item)) return true;
      changes.push({ id: b.item.id, from: "proposed", to: "dropped", reason, evidence: [b.item.title, ...(field(b.item, "words") ? [field(b.item, "words")!] : [])], by: "user" });
      return false;
    });
    if (s.kind === "mission" && s.mission && ids.includes("mission") && isProposed(s.mission)) {
      changes.push({ id: "mission", from: "proposed", to: "dropped", reason, evidence: [s.mission.text], by: "user" });
      s.mission = { text: "", tokens: {}, fields: [], raw: [""], dirty: true };
    }
  }
  if (changes.length) saveCompass(vault, doc, changes, now);
  return changes.map((c) => c.id);
}

export interface Woop { outcome?: string; obstacle?: string; plan?: string; expect?: number }

/**
 * Record a goal's WOOP in the user's words. When outcome, obstacle and an
 * if-then plan are all there, a confirmed (or proposed) goal goes active, or
 * becomes a small trial when the user expects 1 or 2 out of 5.
 */
export function setWoop(vault: string, id: string, w: Woop, now = Date.now()): { id: string; status: string; complete: boolean } {
  const doc = readCompass(vault);
  const it = items(doc, "goal").find((g) => g.id === id);
  if (!it) throw new Error(`no goal ${id}`);
  const put = (k: string, v: string | undefined) => {
    if (v === undefined || !v.trim()) return;
    const val = JSON.stringify(clean(v));
    const f = it.fields.find((x) => x.key === k);
    const at = it.fields.findIndex((x) => x.key === "from");
    if (f) f.value = val; else if (at >= 0) it.fields.splice(at, 0, { key: k, value: val }); else it.fields.push({ key: k, value: val });
  };
  put("outcome", w.outcome); put("obstacle", w.obstacle); put("plan", w.plan);
  if (w.expect !== undefined) {
    if (!Number.isInteger(w.expect) || w.expect < 1 || w.expect > 5) throw new Error("expect is 1 to 5");
    const f = it.fields.find((x) => x.key === "expect");
    if (f) f.value = String(w.expect); else it.fields.push({ key: "expect", value: String(w.expect) });
  }
  it.dirty = true;
  const before = it.tokens.status ?? "active";
  const complete = woopComplete(it);
  const changes: Omit<LedgerLine, "ts">[] = [];
  if (complete && (before === "confirmed" || before === "prototyping" || (before === "active" && activeOrTrial(it) === "prototyping"))) {
    const to = activeOrTrial(it);
    if (to !== before) { it.tokens.status = to; changes.push({ id, from: before, to, reason: "WOOP done", evidence: [field(it, "plan") ?? ""], by: "user" }); }
  }
  if (!changes.length) changes.push({ id, from: before, to: before, reason: "WOOP updated", by: "user" });
  saveCompass(vault, doc, changes, now);
  return { id, status: it.tokens.status ?? "active", complete };
}

/** Confirmed goals still waiting for their WOOP, oldest first. */
export function goalsNeedingWoop(vault: string): CompassItem[] {
  return items(readCompass(vault), "goal").filter((g) => g.tokens.status === "confirmed" && !woopComplete(g));
}

// ── In every chat turn ──────────────────────────────────────────────────────

export const COMPASS_HEADER = "# COMPASS";

/**
 * The confirmed Compass, short, for one chat turn: the mission, ranked values
 * with their "enough", non-negotiables and the life goals. Proposed lines are
 * left out (nothing counts until the user confirms it), and so are lines
 * marked ~local unless the turn runs on a local model.
 */
export function compassBlock(vault: string, opts: { local?: boolean } = {}): string {
  if (!existsSync(compassPath(vault))) return "";
  const doc = readCompass(vault);
  const ok = (x: { tokens: Record<string, string>; flags?: string[] }) => !isProposed(x) && (opts.local || !x.flags?.includes("local"));
  const parts: string[] = [];
  const m = mission(doc);
  if (m && m.text && !isProposed(m)) parts.push(`Mission: ${m.text.replace(/^>\s*/gm, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim()}`);
  const values = items(doc, "value").filter(ok).sort((a, b) => Number(a.tokens.rank ?? 99) - Number(b.tokens.rank ?? 99));
  if (values.length) {
    parts.push("Values, most important first:");
    values.slice(0, 8).forEach((v, i) => parts.push(`${i + 1}. ${v.title}${field(v, "enough") ? ` (enough: ${field(v, "enough")})` : ""}`));
  }
  const rules = items(doc, "rule").filter(ok);
  if (rules.length) { parts.push("Non-negotiables (never trade these away):"); for (const r of rules.slice(0, 8)) parts.push(`- ${r.title}`); }
  const byId = new Map(values.map((v) => [v.id, v.title]));
  const goals = items(doc, "goal").filter((g) => ok(g) && (g.tokens.status ?? "active") === "active");
  if (goals.length) {
    parts.push("Life goals:");
    for (const g of goals.slice(0, 8)) {
      const serves = (g.tokens.serves ?? "").split(",").map((s) => byId.get(s)).filter(Boolean);
      parts.push(`- ${g.title}${serves.length ? ` (serves ${serves.join(", ")})` : ""}${g.tokens.due ? ` by ${g.tokens.due}` : ""}`);
    }
  }
  const shaping = items(doc, "goal").filter((g) => ok(g) && (g.tokens.status === "confirmed" || g.tokens.status === "prototyping"));
  if (shaping.length) parts.push(`Goals they confirmed but have not started (no plan yet, or a small trial): ${shaping.slice(0, 6).map((g) => g.title).join("; ")}`);
  const roles = items(doc, "role").filter(ok);
  if (roles.length) parts.push(`Roles: ${roles.map((r) => r.title).join(", ")}`);
  if (!parts.length) return "";
  return [`${COMPASS_HEADER}: the user's own mission, values, rules and life goals, confirmed by them. Keep advice consistent with these, and say plainly when a request works against one.`, ...parts].join("\n").slice(0, 2500);
}

// ── Bootstrap: a first Compass drafted from the vault, every line quoted ─────

export interface Source { path: string; text: string }

/** What the bootstrap reads: the constitution, the profile, General's memory and source notes, archived Vision. */
export function bootstrapSources(vault: string): Source[] {
  const out: Source[] = [];
  const add = (p: string, cap = 8000) => { const t = readText(p).trim(); if (t) out.push({ path: relative(vault, p), text: t.slice(0, cap) }); };
  const b = buildRoot(vault);
  add(join(b, "ideal-state.md"));
  add(join(b, "user.md"), 4000);
  const g = resolveDomainDir(vault, "general");
  add(join(g, "memory", "memory.md"), 12000);
  add(join(g, "source", "goals.md"), 3000);
  add(join(g, "source", "mission.md"), 3000);
  const archived = join(g, "..", "_archive", "vision");
  if (existsSync(archived)) { add(join(archived, "ideal-state.md"), 4000); add(join(archived, "memory", "memory.md"), 6000); }
  else { const v = resolveDomainDir(vault, "vision"); add(join(v, "ideal-state.md"), 4000); add(join(v, "memory", "memory.md"), 6000); }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[*_`>#"“”‘’']/g, "").replace(/[^a-z0-9$%]+/g, " ").trim();
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "your", "you", "are", "was", "will", "into", "over", "more", "less", "than", "have", "has", "not", "but", "all", "one", "own", "its", "who", "what", "when", "being", "of", "to", "a", "an", "in", "on", "at", "by", "as", "or", "be", "is", "my", "me", "i"]);

/** Where a quote appears verbatim (ignoring case, markup and punctuation), or null. */
export function quoteSource(quote: string, sources: Source[]): Source | null {
  const q = norm(quote);
  if (q.length < 3) return null;
  return sources.find((s) => norm(s.text).includes(q)) ?? null;
}

/** A title drafted from a quote may use only the user's words: every content word appears in the sources. */
export function titleFromUserWords(title: string, sources: Source[]): boolean {
  const all = new Set(norm(sources.map((s) => s.text).join(" ")).split(" "));
  const words = norm(title).split(" ").filter((w) => w.length >= 3 && !STOP.has(w));
  if (!words.length) return false;
  const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "");
  const stems = new Set([...all].map(stem));
  return words.every((w) => all.has(w) || stems.has(stem(w)));
}

export interface Draft {
  mission?: { text: string; quote: string };
  values?: { title: string; quote: string; enough?: string }[];
  roles?: { title: string; quote: string; hope?: string; fear?: string }[];
  goals?: { title: string; quote: string; serves?: string[]; due?: string; domain?: string }[];
  rules?: { title: string; quote: string }[];
  negotiables?: { title: string; quote: string; trade?: string }[];
}

export function bootstrapPrompt(sources: Source[]): string {
  return [
    "You are drafting the first Compass for a person from their own notes. You never invent: every line you return must carry a QUOTE copied word for word from the notes below, and its title must reuse words from that quote.",
    "Return JSON only, this shape:",
    '{ "mission": { "text": "<their mission sentence, copied exactly>", "quote": "<same>" },',
    '  "values": [{ "title": "<2-4 words from the quote>", "quote": "<exact words>", "enough": "<only if they said what enough looks like, else omit>" }],',
    '  "roles": [{ "title": "<role, e.g. Father>", "quote": "<exact words>" }],',
    '  "goals": [{ "title": "<short, from the quote>", "quote": "<exact words>", "serves": ["<value titles>"], "due": "YYYY-MM-DD if they said one" }],',
    '  "rules": [{ "title": "<a hard rule they stated>", "quote": "<exact words>" }],',
    '  "negotiables": [{ "title": "<a preference they would trade>", "quote": "<exact words>" }] }',
    "Values are directions that are never done (freedom, peace of mind, family presence). Goals are life-level destinations with a done, not tasks or app work. Rules are only what they called non-negotiable or never to trade. At most 8 values, 6 roles, 6 goals, 6 rules. List values most important first. Skip anything you cannot quote.",
    "",
    ...sources.map((s) => `=== ${s.path} ===\n${s.text}`),
  ].join("\n");
}

function parseDraft(raw: string): Draft | null {
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(raw.slice(a, b + 1)) as Draft; } catch { return null; }
}

/** Without a model: the constitution's motto as the mission, its principles as candidate values. */
export function fallbackDraft(sources: Source[]): Draft {
  const c = sources.find((s) => s.path.endsWith("ideal-state.md"))?.text ?? "";
  const motto = c.match(/^>\s*(.+)$/m)?.[1]?.replace(/\*\*/g, "").trim();
  const principles = /^##\s+Core principles\s*$/im.exec(c);
  const values: Draft["values"] = [];
  if (principles) {
    const rest = c.slice(principles.index + principles[0].length);
    const end = /^##\s/m.exec(rest);
    for (const l of (end ? rest.slice(0, end.index) : rest).split("\n")) {
      const m = /^\s*-\s+(.*\S)\s*$/.exec(l);
      if (m) values.push({ title: m[1]!.replace(/[.;]$/, ""), quote: m[1]! });
    }
  }
  return { ...(motto ? { mission: { text: motto, quote: motto } } : {}), values: values.slice(0, 8) };
}

export interface BootstrapResult { added: { kind: Kind | "mission"; id: string; title: string; from: string }[]; rejected: { kind: string; title: string; why: string }[]; method: "model" | "fallback" }

/**
 * Add a draft to the Compass as proposed lines. Code keeps the ownership rule:
 * a line whose quote is not in the user's notes, or whose title uses words
 * the user never wrote, is rejected. Lines already in the Compass (same
 * title) are skipped. Nothing is confirmed here.
 */
export function applyDraft(vault: string, draft: Draft, sources: Source[], method: BootstrapResult["method"], now = Date.now()): BootstrapResult {
  const doc = readCompass(vault);
  const res: BootstrapResult = { added: [], rejected: [], method };
  const have = new Set(items(doc).map((i) => `${i.kind}:${norm(i.title)}`));
  const proposals: unknown[] = [];
  const check = (kind: string, title: string, quote: string): Source | null => {
    if (!title?.trim() || !quote?.trim()) { res.rejected.push({ kind, title: title ?? "", why: "no quote" }); return null; }
    const src = quoteSource(quote, sources);
    if (!src) { res.rejected.push({ kind, title, why: "quote not found in the user's notes" }); return null; }
    if (!titleFromUserWords(title, sources)) { res.rejected.push({ kind, title, why: "title uses words the user never wrote" }); return null; }
    return src;
  };
  const m = mission(doc);
  if (draft.mission?.text && (!m || !m.text)) {
    const src = check("mission", draft.mission.text, draft.mission.quote || draft.mission.text);
    if (src && quoteSource(draft.mission.text, sources)) {
      const s = section(doc, "mission");
      s.mission = { text: draft.mission.text.trim(), tokens: { status: "proposed" }, fields: [{ key: "words", value: JSON.stringify(draft.mission.quote || draft.mission.text) }, { key: "from", value: src.path }], raw: [""], dirty: true };
      res.added.push({ kind: "mission", id: "mission", title: draft.mission.text, from: src.path });
      proposals.push({ ts: now, kind: "mission", text: draft.mission.quote || draft.mission.text, source: { file: src.path }, confidence: 0.8, status: "proposed" });
    }
  }
  const valueIds = new Map<string, string>();
  for (const v of items(doc, "value")) valueIds.set(norm(v.title), v.id);
  const put = (kind: Kind, title: string, quote: string, extra: Field[], tokens: Record<string, string> = {}) => {
    const src = check(kind, title, quote);
    if (!src || have.has(`${kind}:${norm(title)}`)) return null;
    have.add(`${kind}:${norm(title)}`);
    const id = compassId(kind, title);
    const it: CompassItem = { kind, id, title: clean(title), done: kind === "goal" ? false : null, tokens: { ...tokens, status: "proposed" }, flags: [], fields: [{ key: "words", value: JSON.stringify(clean(quote)) }, ...extra, { key: "from", value: src.path }], paths: [], raw: [] };
    addItem(doc, it);
    res.added.push({ kind, id, title: it.title, from: src.path });
    proposals.push({ ts: now, kind, id, text: clean(quote), source: { file: src.path }, confidence: 0.7, status: "proposed" });
    return it;
  };
  let rank = items(doc, "value").length;
  for (const v of draft.values ?? []) {
    const it = put("value", v.title, v.quote, v.enough ? [{ key: "enough", value: v.enough }] : [], { rank: String(++rank) });
    if (it) valueIds.set(norm(it.title), it.id);
  }
  for (const r of draft.roles ?? []) put("role", r.title, r.quote, [...(r.hope ? [{ key: "hope", value: JSON.stringify(r.hope) }] : []), ...(r.fear ? [{ key: "fear", value: JSON.stringify(r.fear) }] : [])]);
  for (const g of draft.goals ?? []) {
    const serves = (g.serves ?? []).map((t) => valueIds.get(norm(t))).filter(Boolean) as string[];
    put("goal", g.title, g.quote, [], { ...(serves.length ? { serves: serves.join(",") } : {}), ...(g.due && /^\d{4}-\d{2}-\d{2}$/.test(g.due) ? { due: g.due } : {}), ...(g.domain && /^[a-z0-9-]+$/.test(g.domain) ? { domain: g.domain } : {}) });
  }
  for (const r of draft.rules ?? []) put("rule", r.title, r.quote, []);
  for (const n of draft.negotiables ?? []) put("negotiable", n.title, n.quote, n.trade ? [{ key: "trade", value: JSON.stringify(n.trade) }] : []);
  if (res.added.length) {
    saveCompass(vault, doc, res.added.map((a) => ({ id: a.id, from: "none", to: "proposed", reason: `bootstrap (${method})`, evidence: [a.from], by: "bootstrap" as const })), now);
    appendJsonl(join(compassMetaDir(vault), "proposals.jsonl"), proposals);
  }
  return res;
}

export async function bootstrapCompass(vault: string, run?: (prompt: string) => Promise<string>, now = Date.now()): Promise<BootstrapResult> {
  const sources = bootstrapSources(vault);
  let draft: Draft | null = null;
  if (run && sources.length) { try { draft = parseDraft(await run(bootstrapPrompt(sources))); } catch { draft = null; } }
  return applyDraft(vault, draft ?? fallbackDraft(sources), sources, draft ? "model" : "fallback", now);
}

// ── JSON for the app and MCP ────────────────────────────────────────────────

export function compassJson(vault: string) {
  const doc = readCompass(vault);
  const m = mission(doc);
  const view = (it: CompassItem) => ({
    id: it.id, kind: it.kind, title: it.title, status: statusOf(it, it.kind), done: it.done, tokens: it.tokens, local: it.flags.includes("local"),
    fields: Object.fromEntries(it.fields.map((f) => [f.key, f.value.replace(/^"(.*)"$/, "$1")])),
    paths: it.paths.map((p) => ({ id: p.id, title: p.title, status: p.tokens.status ?? "proposed", tokens: p.tokens, fields: Object.fromEntries(p.fields.map((f) => [f.key, f.value])) })),
  });
  const all = items(doc);
  return {
    path: compassPath(vault),
    exists: existsSync(compassPath(vault)),
    mission: m && m.text ? { text: m.text, status: statusOf(m, "mission"), fields: Object.fromEntries(m.fields.map((f) => [f.key, f.value.replace(/^"(.*)"$/, "$1")])) } : null,
    values: all.filter((i) => i.kind === "value").sort((a, b) => Number(a.tokens.rank ?? 99) - Number(b.tokens.rank ?? 99)).map(view),
    roles: all.filter((i) => i.kind === "role").map(view),
    goals: all.filter((i) => i.kind === "goal").map(view),
    rules: all.filter((i) => i.kind === "rule").map(view),
    negotiables: all.filter((i) => i.kind === "negotiable").map(view),
    proposed: all.filter(isProposed).length + (m && isProposed(m) ? 1 : 0),
  };
}

export function compassVersions(vault: string): { name: string; path: string }[] {
  return listVersions(compassPath(vault)).map((p) => ({ name: p.split("/").pop()!.replace(/\.md$/, ""), path: p }));
}

export async function compassCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "show";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const ids = () => (args.has("all") ? "all" as const : args.pos.slice(1).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean));
  if (sub === "show") {
    const j = compassJson(vault);
    if (args.json) out(j);
    else process.stdout.write(readText(compassPath(vault)) || "No Compass yet: prevail compass bootstrap\n");
    return 0;
  }
  if (sub === "block") { process.stdout.write(`${compassBlock(vault)}\n`); return 0; }
  if (sub === "bootstrap") {
    let run: ((p: string) => Promise<string>) | undefined;
    if (!args.has("no-model")) {
      const { detectClis, runChatTurn, defaultModelFor } = await import("./cli-bridge.ts");
      let clis = await detectClis();
      if (process.env.PREVAIL_BUNKER === "1") clis = clis.filter((c) => ["ollama", "lmstudio", "mlx"].includes(c.kind));
      const cli = clis.find((c) => c.kind === "claude") ?? clis.find((c) => c.kind === "codex") ?? clis[0];
      const cwd = resolveDomainDir(vault, "general");
      try { mkdirSync(cwd, { recursive: true }); } catch { /* exists */ }
      if (cli) run = (prompt) => runChatTurn({ prompt, cwd, cli, model: defaultModelFor(cli.kind), isFirst: true, bare: true });
    }
    const r = await bootstrapCompass(vault, run);
    if (args.json) out(r);
    else { console.log(`Drafted ${r.added.length} proposed lines (${r.method}); rejected ${r.rejected.length}.`); for (const a of r.added) console.log(`  + ${a.kind} ${a.title}  (${a.from})`); for (const x of r.rejected) console.log(`  - ${x.kind} ${x.title}: ${x.why}`); }
    return 0;
  }
  if (sub === "confirm" || sub === "drop") {
    const want = ids();
    if (want !== "all" && !want.length) { console.error(`usage: prevail compass ${sub} <id>[,<id>] | --all`); return 1; }
    if (sub === "drop" && want === "all") { console.error("drop takes ids, never --all"); return 1; }
    const done = sub === "confirm" ? confirm(vault, want, args.get("reason") ?? "confirmed") : drop(vault, want as string[], args.get("reason") ?? "dropped");
    if (args.json) out({ ok: true, [sub === "confirm" ? "confirmed" : "dropped"]: done });
    else console.log(`${sub === "confirm" ? "Confirmed" : "Dropped"} ${done.length}: ${done.join(", ") || "nothing"}`);
    return 0;
  }
  if (sub === "woop") {
    try {
      const n = args.get("expect");
      const r = setWoop(vault, args.pos[1] ?? "", { outcome: args.get("outcome"), obstacle: args.get("obstacle"), plan: args.get("plan"), ...(n !== undefined ? { expect: Number(n) } : {}) });
      if (args.json) out({ ok: true, ...r }); else console.log(`${r.id}: ${r.status}${r.complete ? "" : " (WOOP not complete: outcome, obstacle and an if-then plan)"}`);
      return 0;
    } catch (e) { if (args.json) out({ ok: false, error: (e as Error).message }); else console.error((e as Error).message); return 1; }
  }
  if (sub === "interview") {
    const iv = await import("./interview.ts");
    const act = args.pos[1] ?? "status";
    const r = act === "start" ? iv.startInterview(vault) : act === "answer" ? iv.answerInterview(vault, args.pos.slice(2).join(" ") || args.get("text") || "") : act === "pause" ? (iv.pauseInterview(vault), { reply: "Paused.", state: iv.readInterview(vault) }) : { reply: iv.nextInterviewQuestion(vault)?.text ?? "", state: iv.readInterview(vault) };
    if (args.json) out(r); else console.log(r.reply);
    return 0;
  }
  if (sub === "candidates") {
    const { topCandidates } = await import("./said.ts");
    const c = topCandidates(vault, Number(args.get("limit") ?? 10) || 10);
    if (args.json) out(c); else for (const x of c) console.log(`${x.kind.padEnd(6)} ${x.title}  (${x.count}x) ${x.key}`);
    return 0;
  }
  if (sub === "versions") { const v = compassVersions(vault); if (args.json) out(v); else for (const x of v) console.log(x.name); return 0; }
  if (sub === "ledger") { const l = readLedger(vault); if (args.json) out(l); else for (const x of l) console.log(`${new Date(x.ts).toISOString()} ${x.id} ${x.from} -> ${x.to} (${x.reason})`); return 0; }
  console.error("usage: prevail compass show|block|bootstrap|confirm|drop|woop <id> [--outcome] [--obstacle] [--plan] [--expect 1-5]|interview start|answer <text>|pause|status|candidates|versions|ledger [--json]");
  return 1;
}
