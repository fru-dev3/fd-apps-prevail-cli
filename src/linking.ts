// Linking: a conversation lives in ONE place but touches many.
//
// After a chat turn (chat-json.ts), the touch step (route.ts classifyTouches)
// says which other domains and which of the user's own ("Yours") entities the
// exchange concerns, with one dated fact line each. This module writes those
// lines, answers `prevail updates`, and folds them into state once a day on
// the hub. Everything automatic here is additive: lines are appended, managed
// sections are rewritten, and nothing is ever deleted.
//
// Files (all synced with the vault, none under build/_meta):
//   data/domains/<slug>/memory/updates.jsonl
//       { ts, from_domain, thread, fact, entities: [id] }   one per touch
//   data/entities/<kind dir>/<slug>/updates.jsonl
//       { ts, from_domain, thread, fact }                   one per touch
//   data/domains/<home>/memory/touches.jsonl
//       { ts, thread, domains: [slug], entities: [id] }     one per turn: a
//       thread's reach, since threads themselves are never rewritten
// Checkpoints (per machine; only the hub consolidates):
//   build/_meta/linking/consolidate.json
// Topics with no home (per machine; read by the structure suggestions):
//   build/_meta/linking/unhomed.jsonl
//       { ts, thread, home, label, fact, effort? }          one per label per turn

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  KIND_DIR, ensureAutoPage, entityDir, extractLinks, nameMatchers, parseEntityId, readIndex, resolveEntityId, setEntityAcross, slugify, yoursEntities,
  type EntityKind,
} from "./entities.ts";
import { readManifest } from "./manifest.ts";
import { tryAcquireLock } from "./file-lock.ts";
import { isClientMachine, CLIENT_ROLE_MESSAGE } from "./machine-role.ts";
import { listDomainDirs, v4ContentPath } from "./vault-layout-v4.ts";
import { entitiesContainer, missionScopeSlug, resolveDomainDir, runtimePath } from "./path-safety.ts";
import { activeMissions as listActiveMissions } from "./missions.ts";
import { TOUCH_MAX_DOMAINS, TOUCH_MIN_MESSAGE, labelFor, type TouchEntityOption, type TouchHit, type TouchOptions, type TouchProjectOption, type TouchResult, type UnhomedHit } from "./route.ts";
import { vappendLine, vreadFile, vwriteFile, vwriteFileAtomic } from "./vault-session.ts";
import { noteInMemory, scoreDomains, spendModelCall, STRONG, UNHOMED_MIN_CHARS, UNHOMED_PER_DAY } from "./domain-touch.ts";
import { maskDeep } from "./secret-redact.ts";

export interface DomainUpdate { ts: number; from_domain: string; thread: string; fact: string; entities: string[] }
export interface EntityUpdate { ts: number; from_domain: string; thread: string; fact: string }
export interface TouchLine { ts: number; thread: string; domains: string[]; entities: string[] }
export type UpdateTarget = { kind: "domain"; slug: string } | { kind: "entity"; id: string };
export type UpdateRow = (DomainUpdate | EntityUpdate) & { target: UpdateTarget };

const UPDATES = "updates.jsonl";

export function domainUpdatesPath(vault: string, slug: string): string {
  return join(resolveDomainDir(vault, slug), "memory", UPDATES);
}

export function entityUpdatesPath(vault: string, id: string): string | null {
  // A mission (or the retired project/<slug> id of one that was migrated) keeps
  // its notes in its own memory/updates.jsonl.
  const ms = missionScopeSlug(id.replace(/^project\//, "mission/"));
  if (ms && existsSync(join(resolveDomainDir(vault, `_mission-${ms}`), "mission.md"))) return domainUpdatesPath(vault, `_mission-${ms}`);
  const p = parseEntityId(id);
  return p?.kind ? join(entityDir(vault, p.kind, p.slug), UPDATES) : null;
}

export function touchesPath(vault: string, home: string): string {
  return join(resolveDomainDir(vault, home), "memory", "touches.jsonl");
}

export interface UnhomedLine extends UnhomedHit { ts: number; thread: string; home: string }

export const unhomedPath = (vault: string) => runtimePath(vault, join("_meta", "linking", "unhomed.jsonl"));

export function readUnhomed(vault: string): UnhomedLine[] {
  return readJsonl<UnhomedLine>(unhomedPath(vault)).filter((r) => Number.isFinite(r.ts) && typeof r.label === "string" && typeof r.fact === "string");
}

// One atomic line append under the file's lock (the same helper the ledgers use).
export function appendJsonl(path: string, row: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const lock = tryAcquireLock(`${path}.lock`);
  try { vappendLine(path, `${JSON.stringify(maskDeep(row).value)}\n`); } finally { lock?.release(); }
}

export function readJsonl<T>(path: string): T[] {
  let raw = "";
  try { raw = vreadFile(path); } catch { return []; }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* a torn line from a sync */ }
  }
  return out;
}

// ── Writing a touch ─────────────────────────────────────────────────────

export interface RecordTouchInput {
  home: string;
  thread: string;
  domains: TouchHit[];
  entities: string[];
  /** Entity-specific fact lines, by id; otherwise the first domain fact. */
  entityFacts?: Record<string, string>;
  /** Used for an entity touch with no domain fact at all. */
  fallbackFact: string;
  ts?: number;
}

/** Append the update lines and the touch line for one turn. Returns what was written. */
export function recordTouch(vault: string, t: RecordTouchInput): { domains: { slug: string; fact: string; line?: string }[]; entities: string[]; ts: number } {
  const ts = t.ts ?? Date.now();
  const entities = [...new Set(t.entities.map((id) => (id.startsWith("mission/") ? id : resolveEntityId(vault, id))))].filter((id) => id.startsWith("mission/") || parseEntityId(id)?.kind);
  const domains = t.domains.filter((d) => d.slug !== t.home);
  const lines = new Map<string, string>();
  for (const d of domains) {
    appendJsonl(domainUpdatesPath(vault, d.slug), { ts, from_domain: t.home, thread: t.thread, fact: d.fact, entities } satisfies DomainUpdate);
    // The domain's memory grows from every chat: one dated line, quietly (Undo takes it back).
    try { lines.set(d.slug, noteInMemory(vault, d.slug, { ts, from: t.home, thread: t.thread, fact: d.fact })); } catch { /* the update line is written */ }
  }
  for (const id of entities) {
    const path = entityUpdatesPath(vault, id);
    if (!path) continue;
    const fact = t.entityFacts?.[id] ?? domains[0]?.fact ?? t.fallbackFact;
    appendJsonl(path, { ts, from_domain: t.home, thread: t.thread, fact } satisfies EntityUpdate);
    // After a touch, a Yours entity over the threshold gets its page folder.
    if (id.startsWith("mission/")) continue;
    try { ensureAutoPage(vault, id, undefined, ts); } catch { /* the line is written; the page can wait for refresh */ }
  }
  if (domains.length || entities.length) {
    appendJsonl(touchesPath(vault, t.home), { ts, thread: t.thread, domains: domains.map((d) => d.slug), entities } satisfies TouchLine);
  }
  return { domains: domains.map((d) => ({ slug: d.slug, fact: d.fact, ...(lines.has(d.slug) ? { line: lines.get(d.slug)! } : {}) })), entities, ts };
}

// ── The touch step (after a chat turn) ──────────────────────────────────

/** Hard deadline for the whole step; on timeout nothing is written or emitted. */
export const TOUCH_TIMEOUT_MS = 8_000;
export const TOUCH_MAX_ENTITIES = 4;

export interface TouchStepInput {
  vault: string;
  home: string;
  thread: string;
  message: string;
  reply: string;
  /** Bunker Mode, --local-only or the domain's privacy.localOnly. */
  localOnly: boolean;
  incognito: boolean;
  /** Is the classifier local? No local classifier exists today, so false. */
  classifierLocal?: boolean;
  classify: (o: TouchOptions) => Promise<TouchResult>;
  provider?: TouchOptions["provider"];
  timeoutMs?: number;
  now?: number;
  /** Every tool call on the turn failed (at least one ran). */
  toolsAllFailed?: boolean;
  /** A mission turn: its attached domains are offered first and marked. */
  prefer?: string[];
}

export interface TouchedPayload { domains: { slug: string; fact: string; line?: string }[]; entities: string[]; ts?: number; by?: "code" | "model" }

/** The active missions (and any entity project not yet migrated), for the touch step. */
export function activeProjects(vault: string): TouchProjectOption[] {
  const missions = listActiveMissions(vault).map((m) => ({ id: m.id, name: m.name, aliases: [] as string[], outcome: m.outcome }));
  const legacy = readIndex(vault).entities
    .filter((e) => e.kind === "project" && (e.project?.status ?? "active") === "active" && !missions.some((m) => m.id === `mission/${e.id.slice(8)}`))
    .map((e) => ({ id: e.id, name: e.name, aliases: e.aliases, outcome: e.project?.outcome ?? "" }));
  return [...missions, ...legacy];
}

// A reply that is mainly an error: empty, led by "error"/"failed", or short and
// about a failure. Such a turn concerns nothing, so it touches nothing.
const ERROR_LEAD_RE = /^(error|failed|failure)\b/i;
const ERROR_WORD_RE = /\b(error|failed|fails|couldn'?t|could not|unable to|not granted|haven'?t granted|permission|denied|not available|unavailable)\b/i;
export function replyIsError(reply: string): boolean {
  const t = reply.trim();
  return !t || ERROR_LEAD_RE.test(t) || (t.length <= 600 && ERROR_WORD_RE.test(t));
}

export function touchSkipReason(i: Pick<TouchStepInput, "message" | "localOnly" | "incognito" | "classifierLocal"> & { reply?: string; toolsAllFailed?: boolean }): string | null {
  if (i.incognito) return "incognito";
  if (i.toolsAllFailed) return "tool calls failed";
  if (i.reply !== undefined && replyIsError(i.reply)) return "error reply";
  if (i.message.trim().length < TOUCH_MIN_MESSAGE) return "short message";
  if (i.localOnly && !i.classifierLocal) return "local only";
  return null;
}

/** The user's own words: drops injected context blocks ("# APP CONTEXT: ...",
 *  "# ENTITY ...", preambles) that lead a message, joined by "---" rules. */
export function userText(message: string): string {
  const parts = message.split(/\n\s*---\s*\n/);
  let i = 0;
  while (i < parts.length - 1 && /^\s*# [A-Z][A-Z ]+/.test(parts[i]!)) i++;
  return parts.slice(i).join("\n---\n");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The user's own entities this exchange names: Yours entities linked in the
 * reply (prevail:// links the model wrote), plus Yours names or aliases in the
 * USER's own text. Never injected context, tool output or error text. Names of
 * 4 characters or fewer match whole-word and case-sensitive. At most
 * TOUCH_MAX_ENTITIES.
 */
export function touchedEntities(yours: TouchEntityOption[], message: string, reply: string): string[] {
  const bySlug = new Map<string, string>();
  for (const e of yours) {
    bySlug.set(e.id, e.id);
    for (const n of [e.name, ...e.aliases]) { const s = slugify(n); if (s && !bySlug.has(s)) bySlug.set(s, e.id); }
  }
  const out: string[] = [];
  const push = (id: string | undefined) => { if (id && !out.includes(id)) out.push(id); };
  for (const l of extractLinks(reply)) {
    const s = slugify(l.value);
    push(bySlug.get(`${l.kind}/${s}`) ?? bySlug.get(s));
  }
  const raw = userText(message);
  const text = raw.toLowerCase();
  for (const e of yours) {
    const names = [e.name, ...e.aliases].map((n) => n.trim()).filter(Boolean);
    const short = names.filter((n) => n.length <= 4);
    const hit = nameMatchers(names.filter((n) => n.length > 4)).some((re) => { re.lastIndex = 0; return re.test(text); })
      || short.some((n) => new RegExp(`(^|[^A-Za-z0-9])${escapeRe(n)}(?=$|[^A-Za-z0-9])`).test(raw));
    if (hit) push(e.id);
  }
  return out.slice(0, TOUCH_MAX_ENTITIES);
}

function domainOptions(vault: string, home: string, prefer: string[] = []): { slug: string; description: string }[] {
  const opts = listDomainDirs(vault)
    .map((d) => d.toLowerCase())
    .filter((d) => d !== home && d !== "general" && !d.startsWith("_"))
    .map((slug) => {
      let description = "";
      try { description = (readManifest(vault, slug)?.identity.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 120); } catch { /* none */ }
      return { slug, description };
    });
  if (!prefer.length) return opts;
  const first = opts.filter((o) => prefer.includes(o.slug)).map((o) => ({ ...o, description: `part of this project${o.description ? `; ${o.description}` : ""}` }));
  return [...first, ...opts.filter((o) => !prefer.includes(o.slug))];
}

/**
 * Classify one finished turn and write what it touched. Resolves to the
 * `touched` payload, or null when skipped, timed out, or nothing was touched.
 * Never throws.
 */
export async function runTouchStep(i: TouchStepInput): Promise<TouchedPayload | null> {
  try {
    if (touchSkipReason(i)) return null;
    const home = i.home.toLowerCase();
    const domains = domainOptions(i.vault, home, i.prefer);
    let yours: TouchEntityOption[] = [];
    let projects: TouchProjectOption[] = [];
    try { projects = activeProjects(i.vault); } catch { /* no index yet */ }
    // Projects that are paused, done or archived are never touched.
    try { yours = yoursEntities(i.vault).filter((e) => !e.id.startsWith("project/") || projects.some((p) => p.id === e.id)); } catch { /* no index yet */ }
    // Even with nothing to link, the step runs: it notices topics with no home.
    const named = touchedEntities(yours, i.message, i.reply);
    // A mission counts when the user names it.
    const said = userText(i.message).toLowerCase();
    for (const p of projects) if (p.id.startsWith("mission/") && p.name.length > 3 && said.includes(p.name.toLowerCase()) && !named.includes(p.id)) named.push(p.id);
    // Code first: the user's own words against each domain's name and routing
    // keywords. Clear hits are touches by code; a single hit is a tie the
    // model breaks, inside the daily ceiling; no hit asks no model.
    const ts = i.now ?? Date.now();
    const scored = scoreDomains(i.vault, userText(i.message), domains.map((d) => d.slug));
    // One domain named, even by one word, is no tie: code takes it. Weak hits
    // beside others are ties the model breaks.
    const strong = scored.length === 1 ? scored : scored.filter((h) => h.score >= STRONG);
    const ties = scored.filter((h) => !strong.includes(h));
    let res: TouchResult | null = { domains: strong.map((h) => ({ slug: h.slug, confidence: 1, fact: h.fact })), entity_facts: {}, source: "none" };
    let by: "code" | "model" = "code";
    if (ties.length && spendModelCall(i.vault, ts)) {
      const deadline = i.timeoutMs ?? TOUCH_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), deadline); });
      const asked = await Promise.race([
        i.classify({
          home, message: i.message, reply: i.reply, domains: domains.filter((d) => ties.some((t) => t.slug === d.slug)), provider: i.provider,
          entities: yours.filter((e) => named.includes(e.id) && !e.id.startsWith("project/")), projects,
          // The runner kills its own child a little before the step gives up.
          timeoutMs: Math.max(1_000, deadline - 500),
        }),
        timeout,
      ]);
      clearTimeout(timer);
      if (asked) {
        by = "model";
        res = { ...asked, domains: [...res.domains, ...asked.domains.filter((d) => !strong.some((s) => s.slug === d.slug))].slice(0, TOUCH_MAX_DOMAINS) };
      }
    }
    // A turn that names no domain asks no model to route it, but a small daily
    // allowance still looks for topics with no home, so new domains keep
    // being suggested (owner's default, 2026-10-02).
    if (!scored.length && said.length >= UNHOMED_MIN_CHARS && spendModelCall(i.vault, ts, UNHOMED_PER_DAY, "unhomed-budget")) {
      const deadline = i.timeoutMs ?? TOUCH_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), deadline); });
      const asked = await Promise.race([
        i.classify({ home, message: i.message, reply: i.reply, domains: [], provider: i.provider, entities: [], projects: [], timeoutMs: Math.max(1_000, deadline - 500) }),
        timeout,
      ]);
      clearTimeout(timer);
      // Only its topics with no home are taken; it routes nothing.
      if (asked?.unhomed?.length) res = { ...res, unhomed: asked.unhomed };
    }
    if (!res) return null;
    for (const u of res.unhomed ?? []) {
      appendJsonl(unhomedPath(i.vault), { ts, thread: i.thread, home, label: u.label, fact: u.fact, ...(u.effort ? { effort: true } : {}) } satisfies UnhomedLine);
    }
    const active = new Set(projects.map((p) => p.id));
    // Entities come only from the user's words and the reply's links (named);
    // a project the classifier names counts only when named too.
    const entities = named.filter((id) => !(id.startsWith("project/") || id.startsWith("mission/")) || active.has(id)).filter((id) => id !== home.replace(/^_mission-/, "mission/")).slice(0, TOUCH_MAX_ENTITIES);
    if (!res.domains.length && !entities.length) return null;
    const excerpt = i.message.replace(/\s+/g, " ").trim();
    const w = recordTouch(i.vault, {
      home, thread: i.thread, domains: res.domains, entities, entityFacts: res.entity_facts,
      fallbackFact: `Came up in ${labelFor(home)}: ${excerpt.length > 160 ? `${excerpt.slice(0, 157)}...` : excerpt}`,
      ts,
    });
    return w.domains.length || w.entities.length ? { ...w, by } : null;
  } catch {
    return null;
  }
}

// ── Reading: `prevail updates` ──────────────────────────────────────────

export interface UpdatesQuery { domain?: string; entity?: string; since?: number; limit?: number }

function entityIds(vault: string): string[] {
  const out: string[] = [];
  const root = entitiesContainer(vault);
  for (const [kind, dir] of Object.entries(KIND_DIR) as [EntityKind, string][]) {
    let names: string[] = [];
    try { names = readdirSync(join(root, dir)); } catch { continue; }
    for (const n of names) if (!n.startsWith(".") && existsSync(join(root, dir, n, UPDATES))) out.push(`${kind}/${n}`);
  }
  return out;
}

/** Update lines, newest first, each with its target. No filter = every domain and entity. */
export function readUpdates(vault: string, q: UpdatesQuery = {}): UpdateRow[] {
  const rows: UpdateRow[] = [];
  const domains = q.domain ? [q.domain] : q.entity ? [] : listDomainDirs(vault);
  for (const slug of domains) {
    for (const r of readJsonl<DomainUpdate>(domainUpdatesPath(vault, slug))) rows.push({ ...r, target: { kind: "domain", slug } });
  }
  const ents = q.entity ? [resolveEntityId(vault, q.entity)] : q.domain ? [] : entityIds(vault);
  for (const id of ents) {
    const path = entityUpdatesPath(vault, id);
    if (path) for (const r of readJsonl<EntityUpdate>(path)) rows.push({ ...r, target: { kind: "entity", id } });
  }
  const since = q.since ?? 0;
  return rows
    .filter((r) => Number.isFinite(r.ts) && r.ts >= since && typeof r.fact === "string")
    .sort((a, b) => b.ts - a.ts)
    .slice(0, Math.max(1, q.limit ?? 200));
}

// ── Daily consolidation (hub only) ──────────────────────────────────────

export const ACROSS_HEADING = "## Across your life";
/** Bullets kept in a state.md / entity page section. */
export const ACROSS_BULLETS = 6;
/** A source domain that touched this one this often is durable: it goes into memory.md. */
export const DURABLE_AT = 3;
const DAY = 864e5;

interface Checkpoints { domains: Record<string, { ts: number; run: number }>; entities: Record<string, { ts: number; run: number }> }

const checkpointPath = (vault: string) => runtimePath(vault, join("_meta", "linking", "consolidate.json"));

function readCheckpoints(vault: string): Checkpoints {
  try {
    const c = JSON.parse(vreadFile(checkpointPath(vault))) as Partial<Checkpoints>;
    return { domains: c.domains ?? {}, entities: c.entities ?? {} };
  } catch { return { domains: {}, entities: {} }; }
}

function writeCheckpoints(vault: string, c: Checkpoints): void {
  const p = checkpointPath(vault);
  mkdirSync(dirname(p), { recursive: true });
  vwriteFileAtomic(p, `${JSON.stringify(c, null, 2)}\n`);
}

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export function acrossBullet(r: { ts: number; from_domain: string; fact: string }): string {
  return `- ${day(r.ts)} · from ${labelFor(r.from_domain)}: ${r.fact}`;
}

/** Replace (or append) a `## Heading` section in a markdown document. */
export function replaceSection(md: string, heading: string, body: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  const block = body.trim() ? [heading, "", body.trim(), ""] : [];
  if (start < 0) return block.length ? `${md.replace(/\s*$/, "")}${md.trim() ? "\n\n" : ""}${block.join("\n")}` : md;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

function readText(path: string): string {
  try { return vreadFile(path); } catch { return ""; }
}

function consolidateDomain(vault: string, slug: string): boolean {
  const all = readJsonl<DomainUpdate>(domainUpdatesPath(vault, slug)).filter((r) => r.fact).sort((a, b) => b.ts - a.ts);
  if (!all.length) return false;
  const dir = resolveDomainDir(vault, slug);
  const statePath = v4ContentPath(dir, "memory/state.md", "_state.md");
  const state = readText(statePath);
  const nextState = replaceSection(state, ACROSS_HEADING, all.slice(0, ACROSS_BULLETS).map(acrossBullet).join("\n"));
  if (nextState !== state) vwriteFile(statePath, nextState);

  // Durable: a domain that keeps touching this one earns a line in memory.md
  // (the newest fact from it), rewritten in place rather than appended.
  const bySource = new Map<string, DomainUpdate[]>();
  for (const r of all) (bySource.get(r.from_domain) ?? bySource.set(r.from_domain, []).get(r.from_domain)!).push(r);
  const durable = [...bySource.values()].filter((rs) => rs.length >= DURABLE_AT).map((rs) => acrossBullet(rs[0]!));
  const memPath = v4ContentPath(dir, "memory/memory.md", "_memory.md");
  const mem = readText(memPath);
  if (durable.length || mem.includes(ACROSS_HEADING)) {
    const nextMem = replaceSection(mem, ACROSS_HEADING, durable.join("\n"));
    if (nextMem !== mem) vwriteFile(memPath, nextMem);
  }
  return true;
}

function consolidateEntity(vault: string, id: string): boolean {
  const path = entityUpdatesPath(vault, id);
  if (!path) return false;
  const all = readJsonl<EntityUpdate>(path).filter((r) => r.fact).sort((a, b) => b.ts - a.ts);
  if (!all.length) return false;
  return setEntityAcross(vault, id, all.slice(0, ACROSS_BULLETS).map(acrossBullet));
}

export interface ConsolidateOptions {
  domain?: string;
  entity?: string;
  /** Manual runs ignore the once-a-day gate. */
  force?: boolean;
  now?: number;
  /** Test seam for the machine role. */
  isClient?: () => boolean;
}

export interface ConsolidateResult { ok: boolean; skipped?: string; domains: string[]; entities: string[] }

/**
 * Fold update lines newer than each checkpoint into state (and memory, and
 * entity pages). Once a day per target unless forced. Hub only: a client
 * returns without touching anything. Never deletes an update line.
 */
export function consolidate(vault: string, o: ConsolidateOptions = {}): ConsolidateResult {
  if ((o.isClient ?? isClientMachine)()) return { ok: false, skipped: CLIENT_ROLE_MESSAGE, domains: [], entities: [] };
  const now = o.now ?? Date.now();
  const cp = readCheckpoints(vault);
  const done: ConsolidateResult = { ok: true, domains: [], entities: [] };
  const due = (c: { ts: number; run: number } | undefined, newest: number) => newest > (c?.ts ?? 0) && (o.force || now - (c?.run ?? 0) >= DAY);
  const newestTs = (path: string | null) => (path ? readJsonl<{ ts: number }>(path).reduce((m, r) => Math.max(m, Number(r.ts) || 0), 0) : 0);

  const domains = o.domain ? [o.domain] : o.entity ? [] : listDomainDirs(vault);
  for (const slug of domains) {
    const newest = newestTs(domainUpdatesPath(vault, slug));
    if (!due(cp.domains[slug], newest)) continue;
    try {
      if (consolidateDomain(vault, slug)) { cp.domains[slug] = { ts: newest, run: now }; done.domains.push(slug); }
    } catch { /* one domain failing never stops the rest */ }
  }
  const ents = o.entity ? [resolveEntityId(vault, o.entity)] : o.domain ? [] : entityIds(vault);
  for (const id of ents) {
    const newest = newestTs(entityUpdatesPath(vault, id));
    if (!due(cp.entities[id], newest)) continue;
    try {
      // An entity with no page keeps its lines until it gets one.
      if (consolidateEntity(vault, id)) { cp.entities[id] = { ts: newest, run: now }; done.entities.push(id); }
    } catch { /* keep going */ }
  }
  if (done.domains.length || done.entities.length) writeCheckpoints(vault, cp);
  return done;
}

// ── Recommendation rule ─────────────────────────────────────────────────

/**
 * A domain needs catching up when its updates.jsonl has lines newer than its
 * state.md, with 2 or more of them or the oldest over 3 days old.
 */
export function catchUpCount(vault: string, slug: string, now = Date.now()): number {
  const lines = readJsonl<DomainUpdate>(domainUpdatesPath(vault, slug));
  if (!lines.length) return 0;
  let stateMs = 0;
  try { stateMs = statSync(v4ContentPath(resolveDomainDir(vault, slug), "memory/state.md", "_state.md")).mtimeMs; } catch { /* no state yet */ }
  const fresh = lines.filter((r) => Number(r.ts) > stateMs);
  if (!fresh.length) return 0;
  const oldest = Math.min(...fresh.map((r) => Number(r.ts)));
  return fresh.length >= 2 || now - oldest > 3 * DAY ? fresh.length : 0;
}

// ── CLI: prevail updates | consolidate | config ─────────────────────────

export async function linkingCommand(cmd: string, a: string[], vaultPath?: string | null): Promise<number> {
  const get = (flag: string): string | undefined => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; };
  const json = a.includes("--json");
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (msg: string) => { if (json) out({ ok: false, error: msg }); else console.error(`prevail ${cmd}: ${msg}`); return 1; };
  const { readConfig } = await import("./config.ts");
  const { resolveDefaultVaultPath } = await import("./vault.ts");
  const vault = get("--vault") ?? vaultPath ?? readConfig()?.vaultPath ?? resolveDefaultVaultPath();

  if (cmd === "updates" && a[0] === "undo") {
    // Undo a turn's notes: --thread T --ts N --domains a,b (exactly the lines written then).
    const { unnote, notedLine } = await import("./domain-touch.ts");
    const ts = Number(get("--ts")); const thread = get("--thread") ?? "";
    if (!Number.isFinite(ts) || !thread) return fail("usage: prevail updates undo --thread T --ts N --domains a,b");
    const undone: string[] = [];
    for (const slug of (get("--domains") ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      const row = readJsonl<DomainUpdate>(domainUpdatesPath(vault, slug)).find((r) => r.ts === ts && r.thread === thread);
      if (!row) continue;
      if (unnote(vault, slug, { ts, thread, from: row.from_domain, fact: row.fact, line: notedLine({ ts, from: row.from_domain, thread, fact: row.fact }) })) undone.push(slug);
    }
    if (json) out({ ok: true, undone }); else console.log(undone.length ? `Taken back from ${undone.join(", ")}.` : "Nothing to take back.");
    return 0;
  }
  if (cmd === "updates") {
    const sinceRaw = get("--since");
    const since = sinceRaw ? Date.parse(sinceRaw) : undefined;
    if (sinceRaw && !Number.isFinite(since)) return fail(`--since must be an ISO date, not "${sinceRaw}"`);
    const limit = Number(get("--limit"));
    const rows = readUpdates(vault, { domain: get("--domain"), entity: get("--entity"), since, limit: Number.isFinite(limit) && limit > 0 ? limit : undefined });
    if (json) { out(rows); return 0; }
    for (const r of rows) console.log(`${day(r.ts)}  ${r.target.kind === "domain" ? r.target.slug : r.target.id}  from ${r.from_domain}: ${r.fact}`);
    return 0;
  }
  if (cmd === "consolidate") {
    const r = consolidate(vault, { domain: get("--domain"), entity: get("--entity"), force: true });
    if (json) { out(r); return r.ok ? 0 : 1; }
    if (!r.ok) { console.error(r.skipped); return 1; }
    console.log(`consolidated ${r.domains.length} domains, ${r.entities.length} entities`);
    return 0;
  }
  if (cmd === "config") {
    const cfg = await import("./config.ts");
    const pos = a.filter((x, i) => !x.startsWith("--") && !(i > 0 && a[i - 1] === "--vault"));
    const [sub, key, value] = pos;
    if (key !== "autosave" || (sub !== "get" && sub !== "set")) return fail("usage: prevail config get autosave | set autosave off|yours|all [--json]");
    if (sub === "set") {
      try { cfg.setAutosave(value as never); } catch (e) { return fail((e as Error).message); }
    }
    const v = cfg.readAutosave();
    if (json) out({ ok: true, autosave: v });
    else console.log(v);
    return 0;
  }
  return fail(`unknown command ${cmd}`);
}
