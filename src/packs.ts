// Packs per vertical (Specialists Phase 4, Goals G5, Metrics M6): a starting
// set for one kind of life or work (investors, creators, consultants, new
// parents). A pack is only a suggestion until the user takes it:
//
//   specialists  presets built on a core specialist (base: <id>), installed as
//                build/specialists/<id>.md; a preset never goes past its base
//                (ceiling and tools, clamped in specialists.ts)
//   compass      lines PROPOSED for the Compass (proposals.jsonl, src: pack);
//                nothing is confirmed without the user's yes, and the quote
//                says it came from the pack, not from them
//   metrics      catalog metrics to track, and starter ones a pack defines,
//                added under ## Tracking in build/metrics.md
//
// Installing never overwrites a file the user has; every install is a line in
// build/_meta/packs/ledger.jsonl, and uninstall moves files aside (never
// deletes). Nothing in a pack is about a real person.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRoot, runtimePath } from "./path-safety.ts";
import { parseModArgs } from "./cli-args.ts";

export interface PresetDef { id: string; name: string; base: string; mandate: string; doneWhen?: string[] }
export interface CompassDef { kind: "value" | "goal" | "rule"; title: string }
export interface MetricDef { id: string; title: string; per: "week" | "month"; unit?: "count" | "hours" | "usd" | "minutes"; tier: "asked" | "derived" | "measured"; question?: string }
export interface Pack {
  id: string; name: string; who: string;
  specialists: PresetDef[];
  compass: CompassDef[];
  /** Catalog ids to track, plus starter metrics the pack defines (asked weekly until a source exists). */
  metrics: { track: string[]; define: MetricDef[] };
}

export const PACKS: Pack[] = [
  {
    id: "investors", name: "Investors", who: "People who manage their own investments or rental property",
    specialists: [
      { id: "deal-analyst", name: "Deal analyst", base: "analyst", mandate: "Underwrites one deal on the user's own numbers: cash flow, return on cash, the downside case, and what has to be true for it to work.", doneWhen: ["a base case and a downside case", "every number has its source"] },
      { id: "diligence", name: "Diligence", base: "researcher", mandate: "Due diligence on one company, fund or property: who runs it, what could go wrong, what others found, with sources.", doneWhen: ["at least three independent sources", "red flags first"] },
    ],
    compass: [
      { kind: "value", title: "Financial independence" },
      { kind: "rule", title: "Keep six months of costs in cash" },
      { kind: "goal", title: "Know my net worth every month" },
    ],
    metrics: { track: ["m-spend", "m-subscriptions"], define: [
      { id: "m-cash-months", title: "Months of costs in cash", per: "month", unit: "count", tier: "asked", question: "How many months of costs do you hold in cash?" },
      { id: "m-deals-reviewed", title: "Deals reviewed", per: "month", tier: "asked", question: "How many deals did you look at this month?" },
    ] },
  },
  {
    id: "creators", name: "Creators", who: "People who publish videos, writing or audio",
    specialists: [
      { id: "channel-analyst", name: "Channel analyst", base: "analyst", mandate: "Reads the channel's own numbers (views, watch time, subscribers) and says what worked, what did not, and one thing to try next.", doneWhen: ["compares against the channel's own normal", "one thing to try next"] },
      { id: "script-editor", name: "Script editor", base: "writer", mandate: "Drafts and tightens scripts, titles and descriptions in the user's voice. Drafts only.", doneWhen: ["three title options", "the hook is in the first line"] },
    ],
    compass: [
      { kind: "value", title: "Craft" },
      { kind: "goal", title: "Publish on a steady rhythm" },
      { kind: "rule", title: "Never publish something I would not watch myself" },
    ],
    metrics: { track: ["m-videos", "m-yt-views", "m-subscribers"], define: [
      { id: "m-pieces-published", title: "Pieces published", per: "week", tier: "asked", question: "How many pieces did you publish this week?" },
    ] },
  },
  {
    id: "consultants", name: "Consultants", who: "Independent consultants and freelancers",
    specialists: [
      { id: "proposal-writer", name: "Proposal writer", base: "writer", mandate: "Drafts proposals, statements of work and follow-ups in the user's voice, from the client's own words. Drafts only, never sent.", doneWhen: ["scope, price and dates are explicit", "what is out of scope is named"] },
      { id: "client-liaison", name: "Client liaison", base: "liaison", mandate: "Keeps clients and leads warm: who is due a follow-up, and a short note for each. Drafts only.", doneWhen: ["at most five people, each with why now"] },
    ],
    compass: [
      { kind: "value", title: "Freedom" },
      { kind: "rule", title: "No new client without a signed scope" },
      { kind: "goal", title: "Keep billable hours within what I chose" },
    ],
    metrics: { track: ["m-meeting-hours", "m-emails-sent"], define: [
      { id: "m-billable-hours", title: "Billable hours", per: "week", unit: "hours", tier: "asked", question: "How many billable hours this week?" },
      { id: "m-open-leads", title: "Open leads", per: "week", tier: "asked", question: "How many open leads do you have?" },
    ] },
  },
  {
    id: "new-parents", name: "New parents", who: "People with a new baby at home",
    specialists: [
      { id: "family-planner", name: "Family planner", base: "planner", mandate: "Plans the household's weeks around a new baby: sleep shifts, leave, visits, the next appointments.", doneWhen: ["one week at a time", "who does what is explicit"] },
      { id: "benefits-clerk", name: "Benefits clerk", base: "clerk", mandate: "Files the forms and deadlines a new child brings (leave, insurance, benefits) as tasks with dates.", doneWhen: ["each deadline is a task with a date"] },
    ],
    compass: [
      { kind: "value", title: "Family presence" },
      { kind: "rule", title: "Protect sleep before anything optional" },
      { kind: "goal", title: "Share the night shifts fairly" },
    ],
    metrics: { track: ["m-sleep", "m-family-hours"], define: [
      { id: "m-night-shifts", title: "Night shifts you took", per: "week", unit: "count", tier: "asked", question: "How many night shifts did you take this week?" },
    ] },
  },
];

export function getPack(id: string): Pack | null { return PACKS.find((p) => p.id === id) ?? null; }

function ledgerPath(vault: string): string { return join(runtimePath(vault, "_meta"), "packs", "ledger.jsonl"); }

export function packLedger(vault: string, row: Record<string, unknown>, now = Date.now()): void {
  const p = ledgerPath(vault);
  mkdirSync(join(p, ".."), { recursive: true });
  appendFileSync(p, `${JSON.stringify({ ts: now, ...row })}\n`);
}

/** What of a pack is already in the vault, per part. */
export async function packState(vault: string, p: Pack): Promise<{ specialists: string[]; compass: string[]; metrics: string[] }> {
  const specs = new Set((await import("./specialists.ts")).loadSpecialists(vault).map((s) => s.id));
  let compassTitles = new Set<string>();
  try {
    const cm = await import("./compass.ts");
    compassTitles = new Set(cm.items(cm.readCompass(vault)).map((x) => x.title.toLowerCase()));
  } catch { /* no Compass */ }
  try {
    for (const l of readFileSync(join(runtimePath(vault, "_meta"), "compass", "proposals.jsonl"), "utf8").split("\n")) {
      try { const r = JSON.parse(l) as { title?: string; status?: string }; if (r.title && r.status !== "declined") compassTitles.add(r.title.toLowerCase()); } catch { /* skip */ }
    }
  } catch { /* none */ }
  const tracked = await trackedMetricIds(vault);
  return {
    specialists: p.specialists.filter((x) => specs.has(x.id)).map((x) => x.id),
    compass: p.compass.filter((x) => compassTitles.has(x.title.toLowerCase())).map((x) => x.title),
    metrics: [...p.metrics.track, ...p.metrics.define.map((m) => m.id)].filter((id) => tracked.has(id)),
  };
}

async function trackedMetricIds(vault: string): Promise<Set<string>> {
  try {
    const text = readFileSync(join(buildRoot(vault), "metrics.md"), "utf8");
    return new Set([...text.matchAll(/~id:([a-z0-9_-]+)/gi)].map((m) => m[1]!));
  } catch { return new Set(); }
}

export type PackPart = "specialists" | "compass" | "metrics";

/**
 * Install a pack (or one part of it). Specialists are written only when no
 * file has that id; Compass lines are proposed (the user says yes in the
 * weekly review or on the Compass page); metrics go under ## Tracking.
 */
export async function installPack(vault: string, id: string, o: { only?: PackPart; now?: number } = {}): Promise<{ pack: string; added: { part: PackPart; what: string }[]; skipped: { part: PackPart; what: string; why: string }[] }> {
  const p = getPack(id);
  if (!p) throw new Error(`no pack "${id}"`);
  const now = o.now ?? Date.now();
  const added: { part: PackPart; what: string }[] = [];
  const skipped: { part: PackPart; what: string; why: string }[] = [];
  const want = (x: PackPart) => !o.only || o.only === x;
  if (want("specialists")) {
    const sp = await import("./specialists.ts");
    const have = new Map(sp.loadSpecialists(vault).map((s) => [s.id, s]));
    for (const d of p.specialists) {
      if (have.has(d.id)) { skipped.push({ part: "specialists", what: d.name, why: "already there" }); continue; }
      const base = have.get(d.base);
      if (!base?.builtIn) { skipped.push({ part: "specialists", what: d.name, why: `no ${d.base} to build on` }); continue; }
      const s = sp.clampCustom({ ...base, id: d.id, name: d.name, mandate: d.mandate, doneWhen: [...(d.doneWhen ?? []), ...base.doneWhen].slice(0, 8), builtIn: false, base: d.base, pack: p.id, on: true, source: undefined }, base);
      const file = join(sp.specialistsDir(vault), `${d.id}.md`);
      mkdirSync(sp.specialistsDir(vault), { recursive: true });
      writeFileSync(file, sp.serializeSpecialist(s));
      added.push({ part: "specialists", what: d.name });
    }
  }
  if (want("compass")) {
    const pp = join(runtimePath(vault, "_meta"), "compass", "proposals.jsonl");
    const st = await packState(vault, p);
    for (const c of p.compass) {
      if (st.compass.includes(c.title)) { skipped.push({ part: "compass", what: c.title, why: "already in your Compass or proposed" }); continue; }
      mkdirSync(join(pp, ".."), { recursive: true });
      // The quote names the pack: it is a suggestion, never the user's own words.
      appendFileSync(pp, `${JSON.stringify({ ts: now, src: "pack", pack: p.id, kind: c.kind, title: c.title, text: `From the ${p.name} pack (a suggestion, not your words)`, source: { thread: `pack:${p.id}`, domain: "general" }, confidence: 0.3, status: "candidate" })}\n`);
      added.push({ part: "compass", what: c.title });
    }
  }
  if (want("metrics")) {
    const r = await (await import("./metric-packs.ts")).addPackMetrics(vault, p, now);
    added.push(...r.added.map((what) => ({ part: "metrics" as const, what })));
    skipped.push(...r.skipped.map((what) => ({ part: "metrics" as const, what, why: "already tracked" })));
  }
  packLedger(vault, { action: "install", pack: p.id, only: o.only ?? "all", added: added.map((a) => `${a.part}:${a.what}`) }, now);
  return { pack: p.id, added, skipped };
}

/** Take a pack's specialists out: their files move aside (never deleted). */
export async function uninstallPackSpecialists(vault: string, id: string, now = Date.now()): Promise<string[]> {
  const p = getPack(id);
  if (!p) throw new Error(`no pack "${id}"`);
  const sp = await import("./specialists.ts");
  const moved: string[] = [];
  for (const d of p.specialists) {
    const file = join(sp.specialistsDir(vault), `${d.id}.md`);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (!new RegExp(`^pack:\\s*${p.id}\\s*$`, "m").test(text)) continue; // the user's own file of that name stays
    const dir = join(sp.specialistsDir(vault), ".versions");
    mkdirSync(dir, { recursive: true });
    const to = join(dir, `${d.id}.${new Date(now).toISOString().replace(/[:.]/g, "-")}.md`);
    renameSync(file, to);
    moved.push(d.id);
  }
  packLedger(vault, { action: "uninstall", pack: p.id, moved }, now);
  return moved;
}

// ── CLI: prevail packs list | show <id> | install <id> [--only part] | uninstall <id> ──

export async function packsCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "list";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  if (sub === "list") {
    const rows = [];
    for (const p of PACKS) rows.push({ ...p, installed: await packState(vault, p) });
    if (args.json) out(rows);
    else for (const r of rows) console.log(`${r.id.padEnd(12)} ${r.name}: ${r.specialists.length} specialists, ${r.compass.length} Compass lines, ${r.metrics.track.length + r.metrics.define.length} metrics`);
    return 0;
  }
  if (sub === "show") {
    const p = getPack(args.pos[1] ?? "");
    if (!p) { console.error(`no pack "${args.pos[1] ?? ""}"`); return 1; }
    const v = { ...p, installed: await packState(vault, p) };
    if (args.json) out(v); else console.log(JSON.stringify(v, null, 2));
    return 0;
  }
  if (sub === "install") {
    const only = args.get("only") as PackPart | undefined;
    if (only && !["specialists", "compass", "metrics"].includes(only)) { console.error("--only specialists | compass | metrics"); return 1; }
    try {
      const r = await installPack(vault, args.pos[1] ?? "", { ...(only ? { only } : {}) });
      if (args.json) out(r); else console.log(`Added ${r.added.length}: ${r.added.map((a) => a.what).join(", ") || "nothing new"}.`);
      return 0;
    } catch (e) { if (args.json) out({ error: (e as Error).message }); else console.error((e as Error).message); return 1; }
  }
  if (sub === "uninstall") {
    try {
      const moved = await uninstallPackSpecialists(vault, args.pos[1] ?? "");
      if (args.json) out({ moved }); else console.log(moved.length ? `Moved aside: ${moved.join(", ")}.` : "Nothing to take out.");
      return 0;
    } catch (e) { console.error((e as Error).message); return 1; }
  }
  console.error("usage: prevail packs list | show <id> | install <id> [--only specialists|compass|metrics] | uninstall <id> [--json]");
  return 1;
}
