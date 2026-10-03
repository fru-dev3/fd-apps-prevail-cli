// Goals G5, beyond one person: a household of Compasses with shared goals,
// and the conflicts between people, with consent per person enforced in code.
//
//   build/household.json              members: id, name, relation, consent
//   build/household/<id>/compass.md    a member's own Compass (same grammar)
//   build/household/shared.md          shared goals: "- [ ] Title ~id:sg-x
//                                      ~members:me,<id> ~hours:N ~usd:N"
//   build/_meta/household/consent.jsonl every consent change, who and when
//
// Consent rules (code, not prompt):
//   - two scopes per member: compass (their Compass is read, shown and
//     checked for conflicts) and metrics (their numbers count in family
//     metrics). Both start off.
//   - only the member can say yes: turning a scope on needs their own name
//     typed as the confirmation; anyone can turn one off, at once.
//   - every reader goes through memberCompass / consented, which return
//     nothing without consent; a shared goal names a member without consent
//     but nothing of theirs is read.
//   - removing a member moves their folder to build/household/_archive/
//     (never deleted) and turns every scope off.
// Nothing here is about a real person: tests and fixtures use invented ones.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRoot, runtimePath } from "./path-safety.ts";
import { items, parseCompass, readCompass, type CompassDoc } from "./compass.ts";
import { parseModArgs } from "./cli-args.ts";
import { listMissionSlugs, readMission } from "./missions.ts";

export type Scope = "compass" | "metrics";
export const SCOPES: Scope[] = ["compass", "metrics"];
export interface Consent { on: boolean; ts: number; by: "member" | "owner" }
export interface Member { id: string; name: string; relation: string; added: string; consent: Partial<Record<Scope, Consent>>; removed?: string }
export interface Household { members: Member[] }

const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const idOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
export const householdPath = (vault: string) => join(buildRoot(vault), "household.json");
export const householdDir = (vault: string) => join(buildRoot(vault), "household");
const consentLog = (vault: string) => join(runtimePath(vault, "_meta"), "household", "consent.jsonl");

export function readHousehold(vault: string): Household {
  try { const j = JSON.parse(read(householdPath(vault))) as Household; return { members: Array.isArray(j.members) ? j.members : [] }; } catch { return { members: [] }; }
}
function saveHousehold(vault: string, h: Household): void {
  mkdirSync(buildRoot(vault), { recursive: true });
  writeFileSync(householdPath(vault), `${JSON.stringify(h, null, 2)}\n`);
}
const active = (h: Household) => h.members.filter((m) => !m.removed);

export function addMember(vault: string, i: { name: string; relation?: string; now?: number }): Member {
  const name = i.name.replace(/\s+/g, " ").trim().slice(0, 60);
  const id = idOf(name);
  if (!id || id === "me") throw new Error("a member needs a name");
  const h = readHousehold(vault);
  if (active(h).some((m) => m.id === id)) throw new Error(`${name} is already in the household`);
  const m: Member = { id, name, relation: (i.relation ?? "family").slice(0, 30), added: new Date(i.now ?? Date.now()).toISOString().slice(0, 10), consent: {} };
  h.members = [...h.members.filter((x) => x.id !== id), m];
  saveHousehold(vault, h);
  return m;
}

/** Has this member said yes to this scope? The one check every reader makes. */
export function consented(vault: string, id: string, scope: Scope): boolean {
  const m = active(readHousehold(vault)).find((x) => x.id === id);
  return !!m?.consent[scope]?.on;
}

/**
 * Turn a scope on or off. On needs the member's own yes: their name typed as
 * the confirmation (the owner hands them the device). Off works for anyone.
 */
export function setConsent(vault: string, id: string, scope: Scope, on: boolean, o: { confirm?: string; now?: number } = {}): Member {
  if (!SCOPES.includes(scope)) throw new Error(`a scope is compass or metrics, not ${scope}`);
  const h = readHousehold(vault);
  const m = active(h).find((x) => x.id === id);
  if (!m) throw new Error(`no member ${id}`);
  const now = o.now ?? Date.now();
  if (on && (o.confirm ?? "").trim().toLowerCase() !== m.name.toLowerCase()) throw new Error(`only ${m.name} can say yes: they type their own name to agree`);
  m.consent[scope] = { on, ts: now, by: on ? "member" : "owner" };
  saveHousehold(vault, h);
  mkdirSync(join(consentLog(vault), ".."), { recursive: true });
  appendFileSync(consentLog(vault), `${JSON.stringify({ ts: now, member: id, scope, on, by: on ? "member" : "owner" })}\n`);
  return m;
}

export function removeMember(vault: string, id: string, now = Date.now()): { moved: string | null } {
  const h = readHousehold(vault);
  const m = active(h).find((x) => x.id === id);
  if (!m) throw new Error(`no member ${id}`);
  for (const s of SCOPES) if (m.consent[s]?.on) setConsent(vault, id, s, false, { now });
  const h2 = readHousehold(vault);
  const m2 = h2.members.find((x) => x.id === id && !x.removed)!;
  m2.removed = new Date(now).toISOString().slice(0, 10);
  saveHousehold(vault, h2);
  const from = join(householdDir(vault), id);
  if (!existsSync(from)) return { moved: null };
  const to = join(householdDir(vault), "_archive", `${id}-${m2.removed}`);
  mkdirSync(join(to, ".."), { recursive: true });
  renameSync(from, to);
  return { moved: to };
}

/** A member's Compass, only with their compass consent; null otherwise. */
export function memberCompass(vault: string, id: string): CompassDoc | null {
  if (!consented(vault, id, "compass")) return null;
  const t = read(join(householdDir(vault), id, "compass.md"));
  return t ? parseCompass(t) : null;
}

/** Write a member's Compass (their words, entered with them): needs their compass consent. */
export function setMemberCompass(vault: string, id: string, text: string): string {
  if (!consented(vault, id, "compass")) throw new Error("their Compass is kept only with their yes (compass consent)");
  const dir = join(householdDir(vault), id);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "compass.md");
  if (existsSync(p)) writeFileSync(join(dir, `compass.${new Date().toISOString().replace(/[:.]/g, "-")}.md`), read(p));
  writeFileSync(p, text.endsWith("\n") ? text : `${text}\n`);
  return p;
}

// ── Shared goals ────────────────────────────────────────────────────────────

export interface SharedGoal { id: string; title: string; members: string[]; hours?: number; usd?: number; done: boolean; line: string }
export const sharedPath = (vault: string) => join(householdDir(vault), "shared.md");

export function readShared(vault: string): SharedGoal[] {
  const out: SharedGoal[] = [];
  for (const l of read(sharedPath(vault)).split("\n")) {
    const m = /^- \[([ xX])\]\s+(.*)$/.exec(l);
    if (!m) continue;
    const tok = Object.fromEntries([...m[2]!.matchAll(/~([a-z]+):(\S+)/g)].map((x) => [x[1]!, x[2]!]));
    const title = m[2]!.replace(/\s+~[a-z]+:\S+/g, "").trim();
    out.push({ id: tok.id ?? idOf(title), title, members: (tok.members ?? "me").split(","), ...(tok.hours ? { hours: Number(tok.hours) } : {}), ...(tok.usd ? { usd: Number(tok.usd) } : {}), done: m[1] !== " ", line: l });
  }
  return out;
}

export function addShared(vault: string, i: { title: string; members: string[]; hours?: number; usd?: number }): SharedGoal {
  const h = active(readHousehold(vault));
  const members = [...new Set(["me", ...i.members.filter((x) => x !== "me")])];
  const unknown = members.filter((x) => x !== "me" && !h.some((m) => m.id === x));
  if (unknown.length) throw new Error(`not in the household: ${unknown.join(", ")}`);
  if (members.length < 2) throw new Error("a shared goal has at least one other member");
  const title = i.title.replace(/\s+/g, " ").replace(/[–—]/g, ",").trim().slice(0, 140);
  if (!title) throw new Error("a shared goal needs a title");
  const id = `sg-${idOf(title)}`;
  if (readShared(vault).some((g) => g.id === id)) throw new Error("that shared goal is already there");
  const line = `- [ ] ${title} ~id:${id} ~members:${members.join(",")}${i.hours ? ` ~hours:${i.hours}` : ""}${i.usd ? ` ~usd:${i.usd}` : ""}`;
  mkdirSync(householdDir(vault), { recursive: true });
  const cur = read(sharedPath(vault));
  writeFileSync(sharedPath(vault), `${cur ? cur.replace(/\s*$/, "\n") : "# Shared goals\n\n"}${line}\n`);
  return readShared(vault).find((g) => g.id === id)!;
}

// ── Conflicts between people (code only, each with its evidence) ──────────

export interface PeopleConflict { kind: "rule" | "capacity"; who: string; goal: string; question: string; evidence: string[] }
const STOP = new Set(["never", "the", "a", "an", "to", "of", "and", "for", "my", "our", "on", "in", "at", "with", "more", "than", "be", "do", "not", "no", "any"]);
const content = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => (w.length > 4 ? w.replace(/s$/, "") : w));

/** Rules and capacity: a shared goal that one member's non-negotiable forbids, or hours past what they have. */
export function peopleConflicts(vault: string): PeopleConflict[] {
  const shared = readShared(vault).filter((g) => !g.done);
  const h = active(readHousehold(vault));
  const people: { id: string; name: string; doc: CompassDoc | null }[] = [
    { id: "me", name: "You", doc: readCompass(vault) },
    ...h.map((m) => ({ id: m.id, name: m.name, doc: memberCompass(vault, m.id) })),
  ];
  const out: PeopleConflict[] = [];
  for (const p of people) {
    if (!p.doc) continue; // no consent, nothing read
    const mine = shared.filter((g) => g.members.includes(p.id));
    for (const r of items(p.doc, "rule")) {
      const rw = new Set(content(r.title));
      for (const g of shared) {
        const hit = content(g.title).filter((w) => rw.has(w));
        if (hit.length >= 2 || (hit.length === 1 && rw.size <= 2)) out.push({ kind: "rule", who: p.name, goal: g.title, question: `${p.name === "You" ? "Your" : `${p.name}'s`} non-negotiable "${r.title}" and the shared goal "${g.title}": how do they fit together?`, evidence: [`rule: ${r.title}`, `shared goal: ${g.title}`, `words in both: ${hit.join(", ")}`] });
      }
    }
    const cap = items(p.doc, "capacity").map((c) => Number(c.tokens.hours ?? /(\d+(?:\.\d+)?)\s*hours?/i.exec(c.title)?.[1] ?? NaN)).find((n) => Number.isFinite(n));
    const want = mine.reduce((a, g) => a + (g.hours ?? 0), 0);
    if (cap !== undefined && want > cap) out.push({ kind: "capacity", who: p.name, goal: mine.map((g) => g.title).join("; "), question: `The shared goals ask ${want} hours a week of ${p.name === "You" ? "you" : p.name}; ${p.name === "You" ? "you have" : "they have"} about ${cap}. Which gives?`, evidence: [`capacity: ${cap} hours a week`, ...mine.filter((g) => g.hours).map((g) => `${g.title}: ${g.hours} hours`)] });
  }
  return out;
}

/** The household as the app shows it: members and consent, shared goals, conflicts. Nothing unconsented is read. */
export function householdView(vault: string) {
  const h = active(readHousehold(vault));
  return {
    members: h.map((m) => ({ id: m.id, name: m.name, relation: m.relation, added: m.added, consent: Object.fromEntries(SCOPES.map((s) => [s, !!m.consent[s]?.on])), hasCompass: consented(vault, m.id, "compass") && existsSync(join(householdDir(vault), m.id, "compass.md")) })),
    shared: readShared(vault).map(({ line, ...g }) => ({ ...g, names: g.members.map((x) => (x === "me" ? "You" : h.find((m) => m.id === x)?.name ?? x)) })),
    conflicts: peopleConflicts(vault),
    // Shared projects (missions with a household member who said yes).
    projects: (() => { try { return sharedProjects(vault); } catch { return []; } })(),
  };
}

/** Projects a household member was brought into (their own yes was required to join). */
export function sharedProjects(vault: string): { slug: string; name: string; members: string[] }[] {
  const out: { slug: string; name: string; members: string[] }[] = [];
  for (const slug of listMissionSlugs(vault)) {
    const m = readMission(vault, slug);
    const members = (m?.people ?? []).filter((p) => p.startsWith("household/")).map((p) => p.slice("household/".length));
    if (m && members.length) out.push({ slug, name: m.name, members });
  }
  return out;
}

// ── CLI: prevail compass household ... ─────────────────────────────────────

export async function householdCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "list";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  try {
    if (sub === "list") { const v = householdView(vault); if (args.json) out(v); else console.log(JSON.stringify(v, null, 2)); return 0; }
    if (sub === "add") { const m = addMember(vault, { name: args.get("name") ?? args.pos.slice(1).join(" "), relation: args.get("relation") }); if (args.json) out(m); else console.log(`Added ${m.name}. Nothing of theirs is read until they say yes.`); return 0; }
    if (sub === "consent") {
      const [id, scope, onOff] = [args.pos[1] ?? "", args.pos[2] ?? "", args.pos[3] ?? ""];
      const m = setConsent(vault, id, scope as Scope, onOff === "on", { confirm: args.get("confirm") });
      if (args.json) out({ ok: true, member: m }); else console.log(`${m.name}: ${scope} ${onOff}.`);
      return 0;
    }
    if (sub === "remove") { const r = removeMember(vault, args.pos[1] ?? ""); if (args.json) out(r); else console.log(r.moved ? `Moved their folder to ${r.moved}.` : "Removed."); return 0; }
    if (sub === "compass") {
      const id = args.pos[1] ?? "";
      if (args.get("file")) { const f = args.get("file")!; const p = setMemberCompass(vault, id, f === "-" ? readFileSync(0, "utf8") : readFileSync(f, "utf8")); if (args.json) out({ ok: true, path: p }); return 0; }
      const d = memberCompass(vault, id);
      if (args.json) out(d ? { items: items(d).map((x) => ({ id: x.id, kind: x.kind, title: x.title })) } : { error: "no consent, or no Compass yet" }); else console.log(d ? items(d).map((x) => `${x.kind}: ${x.title}`).join("\n") : "Nothing to show: no consent, or no Compass yet.");
      return 0;
    }
    if (sub === "shared") {
      if ((args.pos[1] ?? "list") === "add") {
        const g = addShared(vault, { title: args.get("title") ?? "", members: (args.get("members") ?? "").split(",").map((s) => s.trim()).filter(Boolean), ...(args.get("hours") ? { hours: Number(args.get("hours")) } : {}), ...(args.get("usd") ? { usd: Number(args.get("usd")) } : {}) });
        if (args.json) out(g); else console.log(`Shared goal ${g.id} for ${g.members.join(", ")}.`);
        return 0;
      }
      const s = readShared(vault); if (args.json) out(s); else for (const g of s) console.log(`${g.done ? "[x]" : "[ ]"} ${g.title} (${g.members.join(", ")})`); return 0;
    }
    if (sub === "conflicts") { const c = peopleConflicts(vault); if (args.json) out(c); else for (const x of c) console.log(`${x.question}\n  ${x.evidence.join("; ")}`); return 0; }
  } catch (e) { if (args.json) { out({ ok: false, error: (e as Error).message }); return 0; } console.error((e as Error).message); return 1; }
  console.error("usage: prevail compass household list | add --name N [--relation R] | consent <id> compass|metrics on|off [--confirm <their name>] | remove <id> | compass <id> [--file f|-] | shared [list] | shared add --title T --members a,b [--hours N] [--usd N] | conflicts [--json]");
  return 1;
}
