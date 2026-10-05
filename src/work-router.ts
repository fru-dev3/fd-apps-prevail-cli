// Work mode's router: one prompt (often dictated, often about several
// unrelated things) becomes goals, and each goal one or more tasks, each with
// a destination (a domain, a project, a person or other entity, an event, an
// app, or a project's code folder), the specialists it needs, an agent kind
// and a machine.
//
//   routeWork(vault, text) -> { goals: [{ text, tasks: [RoutedTask] }], source }
//
// One model call (the route runner, Haiku over stdin) splits and routes; code
// checks every id it names against the catalog, so a destination is always
// something that exists. What does not exist yet (a domain, a project, a
// person, an app, a specialist, a machine) comes back as a suggestion the
// user accepts with one click, never as a write. With no model (runner null,
// or PREVAIL_BUNKER=1) code alone splits on sentences and routes by the words
// the text uses; that plan is a guess, so nothing it routes starts alone.

import { homedir } from "node:os";
import { basename } from "node:path";
import { listPages, readIndex } from "./entities.ts";
import { appRecords } from "./ia.ts";
import { shapeOf, type Effort, type Shape } from "./jobs.ts";
import { readManifest } from "./manifest.ts";
import { activeMissions, ownerOf } from "./missions.ts";
import { routableDomains, type RouteRunner } from "./route.ts";
import { loadSpecialists } from "./specialists.ts";
import { domainForText, missionForText } from "./tell.ts";

export type DestKind = "domain" | "project" | "entity" | "event" | "app" | "folder";
/** A folder kept relative to a root, so it can be found on each machine. `abs` only works on its own Mac. */
export interface Folder { root: "vault" | "home" | "mono" | "abs"; rel: string }
export interface Destination {
  kind: DestKind;
  id: string;
  label: string;
  /** The space the conversation is filed in: a domain, `_mission-<slug>`, `_app-<id>`, or general (entities). */
  space: string;
  /** The job owner: a domain, `mission/<slug>` or `_app-<id>`. */
  owner: string;
  entity?: string;
  folder?: Folder;
  confidence: number;
  why: string;
}
export type SuggestionKind = "domain" | "project" | "entity" | "app" | "specialist" | "machine";
export interface Suggestion { kind: SuggestionKind; name: string; why: string; draft?: unknown; state: "open" | "accepted" | "declined" }
export interface TaskFlags { open_ended?: boolean; decision?: boolean; money?: boolean; numbers?: boolean }
export interface RoutedTask {
  text: string;
  goal: string;
  dest: Destination | null;
  alternatives: Destination[];
  specialists: string[];
  shape: Shape;
  flags: TaskFlags;
  effort: Effort;
  agentKind: string;
  machine: string;
  suggestions: Suggestion[];
}
export interface RouterPlan { goals: { text: string; tasks: RoutedTask[] }[]; source: "model" | "code" }

export const MAX_GOALS = 5;
export const MAX_TASKS = 8;
export const DEFAULT_AGENT_KIND = "claude";
/** Kinds Herdr knows when `herdr agent start --help` cannot be read. */
export const FALLBACK_AGENT_KINDS = ["claude", "codex", "gemini", "agy", "cursor", "grok", "hermes", "pi", "opencode", "copilot", "amp"];
const SHAPES: Shape[] = ["find", "plan", "do", "understand", "make", "act", "negotiate", "learn", "relate", "reflect"];
const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// ── The catalog: everything a task may be routed to ─────────────────────────

export interface CatalogMachine { label: string; current: boolean; herdr: "saved" | "disabled" | "missing" | "local"; role?: "hub" | "client" }
export interface Catalog {
  domains: { slug: string; description: string }[];
  projects: { slug: string; name: string; outcome: string; repos: string[]; owner?: string }[];
  entities: { id: string; name: string; aliases: string[] }[];
  apps: { id: string; title: string }[];
  specialists: { id: string; name: string; mandate: string }[];
  machines: CatalogMachine[];
  agentKinds: string[];
  /** This machine's label. */
  here: string;
  /** The machine last used per space (a task goes back where its space last ran). */
  lastMachine: Record<string, string>;
  roots: { vault: string; home: string; mono?: string };
}

export function buildCatalog(vault: string, o: Partial<Pick<Catalog, "machines" | "agentKinds" | "here" | "lastMachine" | "roots">> = {}): Catalog {
  const domains = ["general", ...routableDomains(vault).filter((d) => !d.startsWith("_"))].map((slug) => ({ slug, description: (readManifest(vault, slug)?.identity.summary ?? "").slice(0, 120) }));
  let projects: Catalog["projects"] = [];
  try { projects = activeMissions(vault).map((m) => ({ slug: m.slug, name: m.name, outcome: m.outcome, repos: m.repos, ...(ownerOf(m) ? { owner: ownerOf(m) } : {}) })); } catch { /* none */ }
  const entities = new Map<string, Catalog["entities"][number]>();
  try { for (const p of listPages(vault)) if (p.kind !== "project") entities.set(p.id, { id: p.id, name: p.doc.name, aliases: p.doc.aliases.slice(0, 3) }); } catch { /* none */ }
  try {
    for (const e of readIndex(vault).entities.filter((x) => x.kind !== "project").sort((a, b) => b.mention_count - a.mention_count)) {
      if (entities.size >= 60) break;
      if (!entities.has(e.id)) entities.set(e.id, { id: e.id, name: e.name, aliases: e.aliases.slice(0, 3) });
    }
  } catch { /* no index */ }
  let apps: Catalog["apps"] = [];
  // App records come from their manifests, never their data.
  try { apps = appRecords(vault).map((a) => ({ id: a.id, title: a.title })); } catch { /* none */ }
  const specialists = loadSpecialists(vault).filter((s) => s.on).map((s) => ({ id: s.id, name: s.name, mandate: s.mandate.replace(/\s+/g, " ").slice(0, 100) }));
  const here = o.here ?? "local";
  return {
    domains, projects, entities: [...entities.values()].slice(0, 60), apps, specialists,
    machines: o.machines ?? [{ label: here, current: true, herdr: "local" }],
    agentKinds: o.agentKinds ?? FALLBACK_AGENT_KINDS,
    here, lastMachine: o.lastMachine ?? {},
    roots: o.roots ?? { vault, home: homedir() },
  };
}

// ── Destinations ────────────────────────────────────────────────────────────

/** A path as a folder relative to the first root it sits under. */
export function folderOf(path: string, roots: Catalog["roots"]): Folder {
  const p = path.trim();
  if (p === "~" || p.startsWith("~/")) return { root: "home", rel: p.slice(2) };
  const under = (root?: string) => (root && (p === root || p.startsWith(`${root.replace(/\/$/, "")}/`)) ? p.slice(root.replace(/\/$/, "").length + 1) : null);
  // Most specific first: the vault and the code root usually sit inside home.
  const v = under(roots.vault);
  if (v !== null) return { root: "vault", rel: v };
  const m = under(roots.mono);
  if (m !== null) return { root: "mono", rel: m };
  const h = under(roots.home);
  if (h !== null) return { root: "home", rel: h };
  return { root: "abs", rel: p };
}

/** A folder as a path on a machine with these roots; null when that root is unknown there. */
export function folderPath(f: Folder, roots: Partial<Catalog["roots"]>): string | null {
  if (f.root === "abs") return f.rel;
  const r = roots[f.root];
  if (!r) return null;
  return f.rel ? `${r.replace(/\/$/, "")}/${f.rel}` : r;
}

const label = (slug: string) => slug.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** The destination for a catalog id, or null when it is not in the catalog. */
export function destination(cat: Catalog, kind: string, id: string, o: { confidence?: number; why?: string } = {}): Destination | null {
  const base = { confidence: Math.max(0, Math.min(1, Number.isFinite(o.confidence) ? o.confidence! : 0.7)), why: (o.why ?? "").replace(/\s+/g, " ").trim().slice(0, 160) };
  const want = String(id ?? "").trim();
  if (kind === "domain") {
    const d = cat.domains.find((x) => x.slug === want.toLowerCase());
    return d ? { kind: "domain", id: d.slug, label: label(d.slug), space: d.slug, owner: d.slug, ...base } : null;
  }
  if (kind === "project") {
    const p = cat.projects.find((x) => x.slug === want.replace(/^mission\//, ""));
    if (!p) return null;
    return { kind: "project", id: p.slug, label: p.name, space: `_mission-${p.slug}`, owner: `mission/${p.slug}`, ...(p.repos[0] ? { folder: folderOf(p.repos[0], cat.roots) } : {}), ...base };
  }
  if (kind === "folder") {
    const p = cat.projects.find((x) => x.repos.includes(want));
    if (!p) return null;
    return { kind: "folder", id: want, label: `${p.name}: ${basename(want)}`, space: `_mission-${p.slug}`, owner: `mission/${p.slug}`, folder: folderOf(want, cat.roots), ...base };
  }
  if (kind === "entity" || kind === "event") {
    const e = cat.entities.find((x) => x.id === want);
    if (!e) return null;
    return { kind: e.id.startsWith("event/") ? "event" : "entity", id: e.id, label: e.name, space: "general", owner: "general", entity: e.id, ...base };
  }
  if (kind === "app") {
    const a = cat.apps.find((x) => x.id === want);
    return a ? { kind: "app", id: a.id, label: a.title, space: `_app-${a.id}`, owner: `_app-${a.id}`, ...base } : null;
  }
  return null;
}

// ── Agent kind and machine ──────────────────────────────────────────────────

const CLI_KIND: Record<string, string> = { claude: "claude", codex: "codex", antigravity: "agy", gemini: "gemini" };

/** The destination's own engine (its manifest's cli) as a Herdr kind; claude otherwise. */
export function defaultKind(vault: string, dest: Destination | null, cat?: Catalog): string {
  if (!dest) return DEFAULT_AGENT_KIND;
  const domain = dest.kind === "domain" ? dest.id : dest.kind === "project" || dest.kind === "folder" ? cat?.projects.find((p) => `mission/${p.slug}` === dest.owner)?.owner : undefined;
  if (!domain) return DEFAULT_AGENT_KIND;
  try { return CLI_KIND[readManifest(vault, domain)?.config.cli ?? ""] ?? DEFAULT_AGENT_KIND; } catch { return DEFAULT_AGENT_KIND; }
}

/** The kind the text asks for in so many words ("with codex", "use gemini"). */
function kindSaid(text: string, kinds: string[]): string | null {
  const m = /\b(?:with|use|using|in|via|ask)\s+([a-z][a-z0-9_-]{1,31})\b/i.exec(text);
  const k = m?.[1]?.toLowerCase();
  return k && kinds.includes(k) ? k : null;
}

/** A machine label the text names ("on mini-foo"). */
function machineSaid(text: string, cat: Catalog): string | null {
  for (const m of cat.machines) if (m.label.length >= 2 && new RegExp(`\\bon (the )?${m.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) return m.label;
  return null;
}

function defaultMachine(cat: Catalog, dest: Destination | null): string {
  const last = dest ? cat.lastMachine[dest.space] : undefined;
  return last && cat.machines.some((m) => m.label === last) ? last : cat.here;
}

// ── The model path ──────────────────────────────────────────────────────────

export function buildWorkPrompt(text: string, cat: Catalog): { system: string; prompt: string } {
  const system = [
    "You are a chief of staff's router. The user fired one prompt, often dictated and about several unrelated things.",
    `Find what they are trying to achieve: at most ${MAX_GOALS} goals, and for each goal the tasks to delegate (at most ${MAX_TASKS} tasks in all).`,
    "Route each task to exactly one destination from the lists you are given, by id. Never invent an id.",
    "When a task needs a home that is not listed (a life area, a project, a person or other entity, an app, a specialist), still route it to the closest listed home, and name what is missing in `missing`.",
    "Reply with ONLY one JSON object, no prose and no code fence:",
    '{"goals":[{"text":"<the goal in the user\'s words>","tasks":[{"text":"<one task, an imperative line with every name, date and amount the user said>","dest":{"kind":"domain|project|folder|entity|app","id":"<listed id>"},"alternatives":[{"kind":"...","id":"..."}],"confidence":<0..1>,"why":"<one short line>","specialists":["<listed specialist id>"],"shape":"find|plan|do|understand|make|act|negotiate|learn|relate|reflect","flags":{"open_ended":<bool>,"decision":<bool>,"money":<bool>,"numbers":<bool>},"effort":"quick|standard|deep","agent":"<agent kind, only when the user asked for one>","machine":"<machine label, only when the user named one or the work is deep>","missing":[{"kind":"domain|project|entity|app|specialist","name":"<short name>","why":"<one line>","draft":{"kind":"<for an entity only: person|place|org|thing|event>"}}]}]}]}',
    "`missing` is only for a home the work should have and does not (a life area, project, person, thing, app or specialist); never for a detail the prompt leaves out, like a file path or a date.",
    "For a missing entity, say what it is in draft.kind: a pet, a car or a gadget is a thing, a business is an org, only a human is a person.",
    "A project's code work goes to its folder (kind folder, the repo path as id). A person, place, product, thing or event the user names goes to that entity when it is listed.",
    "No em dashes. Plain words.",
  ].join("\n");
  const lines = [
    "Domains (id: what it covers):", ...cat.domains.map((d) => `- ${d.slug}${d.description ? `: ${d.description}` : ""}`),
    ...(cat.projects.length ? ["", "Projects (id = name: outcome; folders):", ...cat.projects.map((p) => `- ${p.slug} = ${p.name}${p.outcome ? `: ${p.outcome}` : ""}${p.repos.length ? `; folders: ${p.repos.join(", ")}` : ""}`)] : []),
    ...(cat.entities.length ? ["", "Entities and events (id = name / aliases):", ...cat.entities.map((e) => `- ${e.id} = ${[e.name, ...e.aliases].join(" / ")}`)] : []),
    ...(cat.apps.length ? ["", "Apps (id = name):", ...cat.apps.map((a) => `- ${a.id} = ${a.title}`)] : []),
    "", "Specialists (id: what they are for):", ...cat.specialists.map((s) => `- ${s.id}: ${s.mandate || s.name}`),
    "", `Machines: ${cat.machines.map((m) => `${m.label}${m.current ? " (this one)" : ""}${m.role === "hub" ? " (hub)" : ""}`).join(", ")}`,
    `Agent kinds: ${cat.agentKinds.join(", ")}`,
    "", "The user's prompt:", `"""${text.slice(0, 6000)}"""`,
  ];
  return { system, prompt: lines.join("\n") };
}

const str = (x: unknown, n: number) => (typeof x === "string" ? x.replace(/\s+/g, " ").replace(/\s*[—–]\s*/g, ", ").trim().slice(0, n) : "");

/** Check a router reply against the catalog. Null when it is not usable at all. */
export function parseWorkReply(raw: string, cat: Catalog, o: { fallback?: (text: string) => Destination | null; kindFor?: (dest: Destination | null, text: string) => string; userText?: string } = {}): RouterPlan | null {
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let j: { goals?: unknown };
  try { j = JSON.parse(raw.slice(a, b + 1)) as { goals?: unknown }; } catch { return null; }
  if (!Array.isArray(j.goals)) return null;
  const said = o.userText ?? "";
  const specIds = new Set(cat.specialists.map((s) => s.id));
  const exists = (kind: SuggestionKind, name: string) => {
    const n = name.toLowerCase();
    if (kind === "domain") return cat.domains.some((d) => d.slug === n.replace(/\s+/g, "-"));
    if (kind === "project") return cat.projects.some((p) => p.name.toLowerCase() === n || p.slug === n);
    if (kind === "entity") return cat.entities.some((e) => e.name.toLowerCase() === n);
    if (kind === "app") return cat.apps.some((x) => x.title.toLowerCase() === n || x.id === n);
    if (kind === "specialist") return cat.specialists.some((s) => s.name.toLowerCase() === n || s.id === n);
    return cat.machines.some((m) => m.label === name);
  };
  const goals: RouterPlan["goals"] = [];
  let count = 0;
  for (const g of j.goals.slice(0, MAX_GOALS) as { text?: unknown; tasks?: unknown }[]) {
    if (!g || typeof g !== "object" || !Array.isArray(g.tasks)) continue;
    const gt = str(g.text, 300);
    const tasks: RoutedTask[] = [];
    for (const t of g.tasks as Record<string, unknown>[]) {
      if (count >= MAX_TASKS) break;
      const text = str(t?.text, 400);
      if (!text) continue;
      const d = (t.dest ?? {}) as { kind?: string; id?: string };
      const why = str(t.why, 160);
      let dest = destination(cat, String(d.kind ?? ""), String(d.id ?? ""), { confidence: Number(t.confidence), why });
      if (!dest && o.fallback) dest = o.fallback(text);
      const alternatives = (Array.isArray(t.alternatives) ? t.alternatives as { kind?: string; id?: string }[] : [])
        .map((x) => destination(cat, String(x?.kind ?? ""), String(x?.id ?? ""), { confidence: 0.3 }))
        .filter((x): x is Destination => !!x && !(dest && x.kind === dest.kind && x.id === dest.id)).slice(0, 2);
      const suggestions: Suggestion[] = [];
      for (const m of Array.isArray(t.missing) ? t.missing as { kind?: string; name?: string; why?: string; draft?: unknown }[] : []) {
        const kind = String(m?.kind ?? "") as SuggestionKind;
        const name = str(m?.name, 60);
        if (!["domain", "project", "entity", "app", "specialist"].includes(kind) || !name || exists(kind, name) || suggestions.some((s) => s.kind === kind && s.name === name)) continue;
        suggestions.push({ kind, name, why: str(m?.why, 160), ...(m?.draft && typeof m.draft === "object" ? { draft: m.draft } : {}), state: "open" });
      }
      const shape = SHAPES.includes(t.shape as Shape) ? (t.shape as Shape) : shapeOf(text) ?? "plan";
      const f = (t.flags ?? {}) as Record<string, unknown>;
      const flags: TaskFlags = {};
      for (const k of ["open_ended", "decision", "money", "numbers"] as const) if (typeof f[k] === "boolean") flags[k] = f[k] as boolean;
      const effort: Effort = t.effort === "quick" || t.effort === "deep" ? t.effort : "standard";
      const askedKind = typeof t.agent === "string" ? t.agent.trim().toLowerCase() : "";
      const agentKind = askedKind && KIND_RE.test(askedKind) && cat.agentKinds.includes(askedKind) ? askedKind : (o.kindFor ?? (() => DEFAULT_AGENT_KIND))(dest, text);
      // Another machine only when the user named it, or for deep work on a saved, enabled Herdr machine (the hub).
      let machine = defaultMachine(cat, dest);
      const mm = typeof t.machine === "string" ? t.machine.trim() : "";
      if (mm && mm !== machine) {
        const known = cat.machines.find((x) => x.label === mm);
        const named = new RegExp(`\\b${mm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(said);
        if (known && (named || (effort === "deep" && known.herdr === "saved"))) machine = known.label;
        else if (!known && named && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(mm)) suggestions.push({ kind: "machine", name: mm, why: "named in the prompt, not a saved Herdr machine yet", state: "open" });
      }
      tasks.push({
        text, goal: gt || text, dest, alternatives,
        specialists: [...new Set((Array.isArray(t.specialists) ? t.specialists : []).filter((x): x is string => typeof x === "string" && specIds.has(x)))].slice(0, 3),
        shape, flags, effort, agentKind, machine, suggestions,
      });
      count++;
    }
    if (tasks.length) goals.push({ text: gt || tasks[0]!.text, tasks });
  }
  return goals.length ? { goals, source: "model" } : null;
}

// ── The code path ───────────────────────────────────────────────────────────

const CONNECT = /\s*(?:;|\balso,?\s+|\bseparately,?\s+|\banother thing,?\s+|\band then\s+|\bplus,?\s+)/i;

// A dictated lead-in ("ok a few things") announces work; it is not a task.
const PREAMBLE = /^(?:(?:ok(?:ay)?|so|right|alright|well|hey|um+|uh+)[\s,]+)*(?:i have |i've got |i got |there are )?(?:a few|a couple(?: of)?|some|several|two|three|four|five) (?:things|items|tasks)(?: for you| to do| today)?$/i;

/** One prompt into goal-sized pieces: lines and bullets, then sentences, then "also" and the like. */
export function splitGoals(text: string): string[] {
  const pieces: string[] = [];
  for (const line of text.replace(/\r/g, "").split(/\n+/)) {
    const l = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    if (!l) continue;
    for (const sentence of l.split(/(?<=[.!?])\s+/)) {
      for (const p of sentence.split(CONNECT)) {
        const t = p.replace(/^(?:and|so|then)\s+/i, "").replace(/[.!:]+$/, "").trim();
        if (t && !PREAMBLE.test(t)) pieces.push(t);
      }
    }
  }
  // A scrap of under three words belongs to the piece before it.
  const merged: string[] = [];
  for (const p of pieces) {
    if (merged.length && p.split(/\s+/).length < 3) merged[merged.length - 1] = `${merged[merged.length - 1]}, ${p}`;
    else merged.push(p);
  }
  if (merged.length > MAX_GOALS) merged.splice(MAX_GOALS - 1, merged.length, merged.slice(MAX_GOALS - 1).join(". "));
  return merged;
}

const wordIn = (name: string, text: string) => name.length >= 3 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);

/** Where code alone would send one task: an entity it names, a project, an app it names, a domain by its words, else General. */
export async function codeDestination(vault: string, text: string, cat: Catalog): Promise<Destination> {
  // A name said in full is the strongest signal; a project matches on any one of its words.
  const ent = cat.entities.find((e) => [e.name, ...e.aliases].some((n) => wordIn(n, text)));
  if (ent) return destination(cat, "entity", ent.id, { confidence: 0.6, why: `names ${ent.name}` })!;
  try {
    const ms = await missionForText(vault, text);
    const d = ms ? destination(cat, "project", ms.slug, { confidence: 0.6, why: `the words point at the project ${ms.name}` }) : null;
    if (d) return d;
  } catch { /* no missions */ }
  const app = cat.apps.find((x) => wordIn(x.title, text) || wordIn(x.id, text));
  if (app) return destination(cat, "app", app.id, { confidence: 0.5, why: `names ${app.title}` })!;
  const dom = domainForText(vault, text);
  const d = destination(cat, "domain", dom, dom === "general" ? { confidence: 0.2, why: "nothing in the words points elsewhere; kept in General" } : { confidence: 0.5, why: `uses ${dom}'s words` });
  return d ?? { kind: "domain", id: "general", label: "General", space: "general", owner: "general", confidence: 0.2, why: "kept in General" };
}

export async function codeRoute(vault: string, text: string, cat: Catalog): Promise<RouterPlan> {
  const goals: RouterPlan["goals"] = [];
  for (const g of splitGoals(text).slice(0, MAX_TASKS)) {
    const dest = await codeDestination(vault, g, cat);
    const money = /\$\s?\d|\b(price|prices|cost|costs|budget|pay|quote|quotes)\b/i.test(g);
    goals.push({
      text: g,
      tasks: [{
        text: g, goal: g, dest, alternatives: [], specialists: [],
        shape: shapeOf(g) ?? "plan",
        flags: { ...(money ? { money: true } : {}), ...(/\b(should i|choose|decide|which one)\b/i.test(g) ? { decision: true } : {}) },
        effort: "standard",
        agentKind: kindSaid(g, cat.agentKinds) ?? defaultKind(vault, dest, cat),
        machine: machineSaid(g, cat) ?? defaultMachine(cat, dest),
        suggestions: [],
      }],
    });
  }
  return { goals, source: "code" };
}

// ── Entry point ─────────────────────────────────────────────────────────────

export interface RouteWorkOptions { runner?: RouteRunner | null; catalog?: Catalog; timeoutMs?: number }

/** Split and route one prompt. Never throws on a model failure: code takes over. */
export async function routeWork(vault: string, text: string, o: RouteWorkOptions = {}): Promise<RouterPlan> {
  const t = text.trim();
  if (!t) throw new Error("nothing to route");
  const cat = o.catalog ?? buildCatalog(vault);
  const bunker = process.env.PREVAIL_BUNKER === "1";
  if (o.runner !== null && !bunker) {
    const runner = o.runner ?? (await import("./route.ts")).claudeRouteRunner;
    const { system, prompt } = buildWorkPrompt(t, cat);
    try {
      const raw = await runner({ system, prompt, timeoutMs: o.timeoutMs ?? 60_000, maxChars: 16_000 });
      // A destination the model got wrong falls back to the general home, never to a guess at another domain.
      const plan = parseWorkReply(raw, cat, { userText: t, fallback: () => destination(cat, "domain", "general", { confidence: 0.2, why: "the router named nothing that exists" }), kindFor: (d, tt) => kindSaid(tt, cat.agentKinds) ?? defaultKind(vault, d, cat) });
      if (plan) return plan;
    } catch { /* code takes over */ }
  }
  return codeRoute(vault, t, cat);
}
