// Goals G5, over a lifetime: fresh starts, the yearly review with three
// odyssey lives, how values and roles changed over the years, and the
// Compass exported as a constitution any AI can read.
//
//   Fresh starts (temporal landmarks; goals-research: the fresh start effect)
//     new year (Jan 1 to 7), the user's birthday week (build/user.md
//     frontmatter `birthday: MM-DD`), a new quarter's first week, and a move
//     or a new job the user said in chat in the last 14 days (stated events
//     life.move / life.job, written by said.ts, content free). Each one may
//     interrupt once (kind fresh-start, inside the three-a-week budget) with
//     an offer of the yearly review; nothing else happens on its own.
//   Yearly review  general/memory/reviews/year-<YYYY>.md, written by code:
//     values and roles now and how they moved this year, the purpose, then the
//     three odyssey lives (the current path, if it vanished, if money did not
//     matter). With --draft a model sketches each life from the user's own
//     notes, and code keeps a sketch only when its quote is found verbatim in
//     them. Nothing here writes the Compass: the page asks, the user answers.
//   History  every value and role across compass.versions/ and the ledger:
//     when it appeared, each rank change, when it was dropped, and why.
//   Export  build/exports/compass-constitution-<date>.md: confirmed lines
//     only, never ~local ones, as plain prose and lists.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRoot, resolveDomainDir, runtimePath } from "./path-safety.ts";
import { compassVersions, isProposed, items, mission, parseCompass, readCompass, readLedger, type CompassDoc, type CompassItem } from "./compass.ts";
import { parseModArgs } from "./cli-args.ts";

const DAY = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const readText = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

// ── Fresh starts ────────────────────────────────────────────────────────────

export type FreshKind = "new-year" | "birthday" | "new-quarter" | "move" | "new-job";
export interface FreshStart { kind: FreshKind; key: string; date: string; text: string }

/** The birthday from build/user.md frontmatter (`birthday: MM-DD` or `born: YYYY-MM-DD`), as MM-DD. */
export function birthdayOf(vault: string): string | null {
  const t = readText(join(buildRoot(vault), "user.md"));
  const fm = /^---\n([\s\S]*?)\n---/.exec(t)?.[1] ?? "";
  const b = /^birthday:\s*["']?(\d{2})-(\d{2})/m.exec(fm) ?? /^born:\s*["']?\d{4}-(\d{2})-(\d{2})/m.exec(fm);
  return b ? `${b[1]}-${b[2]}` : null;
}

/** Moves and new jobs the user said in chat (stated events), newest first. */
function saidLifeEvents(vault: string, now: number): { kind: "move" | "new-job"; day: string }[] {
  const dir = join(runtimePath(vault, "_meta"), "events", "stated");
  const out: { kind: "move" | "new-job"; day: string }[] = [];
  const months = [ymd(now).slice(0, 7), ymd(now - 20 * DAY).slice(0, 7)];
  try {
    for (const f of readdirSync(dir)) {
      if (!months.some((m) => f.startsWith(m))) continue;
      for (const l of readText(join(dir, f)).split("\n")) {
        try {
          const e = JSON.parse(l) as { ts: string; kind: string };
          if (e.kind === "stated.life.move" || e.kind === "stated.life.job") out.push({ kind: e.kind.endsWith("move") ? "move" : "new-job", day: e.ts });
        } catch { /* skip */ }
      }
    }
  } catch { /* none */ }
  return out.sort((a, b) => b.day.localeCompare(a.day));
}

/** The fresh starts that are on today (each is offered once, by its key). */
export function freshStarts(vault: string, now = Date.now()): FreshStart[] {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const out: FreshStart[] = [];
  if (m === 1 && day <= 7) out.push({ kind: "new-year", key: `fresh:new-year:${y}`, date: `${y}-01-01`, text: `A new year, ${y}. A good week for the yearly review: values, roles, purpose, and three possible lives.` });
  const b = birthdayOf(vault);
  if (b) {
    const bd = Date.UTC(y, Number(b.slice(0, 2)) - 1, Number(b.slice(3)));
    const since = Math.floor((Date.UTC(y, m - 1, day) - bd) / DAY);
    if (since >= 0 && since < 7) out.push({ kind: "birthday", key: `fresh:birthday:${y}`, date: ymd(bd), text: "Your birthday week: a natural point to look at the year ahead." });
  }
  if ([4, 7, 10].includes(m) && day <= 7) out.push({ kind: "new-quarter", key: `fresh:quarter:${y}-${m}`, date: `${y}-${String(m).padStart(2, "0")}-01`, text: "A new quarter: keep, switch or drop each initiative." });
  for (const e of saidLifeEvents(vault, now)) {
    if (now - Date.parse(`${e.day}T12:00:00Z`) > 14 * DAY) continue;
    out.push({ kind: e.kind, key: `fresh:${e.kind}:${e.day}`, date: e.day, text: e.kind === "move" ? "You moved. A fresh start: worth a look at routines, roles and what matters now." : "A new job. A fresh start: worth a look at roles, capacity and goals." });
    break;
  }
  return out;
}

/** The daily pass (hub): offer each fresh start once, inside the interruption budget. */
export async function freshStartPass(vault: string, now = Date.now()): Promise<{ offered: string[]; queued: string[] }> {
  const { tryInterrupt, readInterruptions } = await import("./interruptions.ts");
  const seen = new Set(readInterruptions(vault).map((r) => r.key));
  const offered: string[] = [];
  const queued: string[] = [];
  for (const f of freshStarts(vault, now)) {
    if (seen.has(f.key)) continue;
    const r = tryInterrupt(vault, { kind: "fresh-start", text: f.text, key: f.key }, now);
    (r.ok ? offered : queued).push(f.key);
  }
  return { offered, queued };
}

// ── History of values and roles ─────────────────────────────────────────────

export interface HistoryEvent { date: string; what: "added" | "rank" | "renamed" | "dropped" | "status"; from?: string; to?: string; reason?: string }
export interface HistoryLine { id: string; kind: "value" | "role"; title: string; now: boolean; rank?: number; first: string | null; events: HistoryEvent[] }

/** Every value and role, with when it appeared, each rank change, and when it was dropped. */
export function compassHistory(vault: string): HistoryLine[] {
  const versions = compassVersions(vault).slice().reverse(); // oldest first; each holds the text in effect until its stamp
  const stampMs = (name: string) => Date.parse(name.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})Z.*$/, "$1:$2:$3Z"));
  const states: { at: number | null; doc: CompassDoc }[] = [];
  let since: number | null = null;
  for (const v of versions) { states.push({ at: since, doc: parseCompass(readText(v.path)) }); since = stampMs(v.name); }
  states.push({ at: since, doc: readCompass(vault) });
  const ledger = readLedger(vault);
  const lines = new Map<string, HistoryLine>();
  const conf = (x: CompassItem) => !isProposed(x);
  let prev = new Map<string, CompassItem>();
  for (const s of states) {
    const cur = new Map(items(s.doc).filter((x) => (x.kind === "value" || x.kind === "role") && conf(x)).map((x) => [x.id, x]));
    const date = s.at ? ymd(s.at) : null;
    for (const [id, x] of cur) {
      let h = lines.get(id);
      if (!h) { h = { id, kind: x.kind as "value" | "role", title: x.title, now: false, first: date, events: [] }; lines.set(id, h); if (date) h.events.push({ date, what: "added" }); }
      const p = prev.get(id);
      if (p && p.tokens.rank !== x.tokens.rank && date) h.events.push({ date, what: "rank", from: p.tokens.rank ?? "", to: x.tokens.rank ?? "" });
      if (p && p.title !== x.title && date) h.events.push({ date, what: "renamed", from: p.title, to: x.title });
      if (!p && prev.size && h.events.length && h.events[h.events.length - 1]!.what === "dropped" && date) h.events.push({ date, what: "added" });
      h.title = x.title;
      if (x.tokens.rank) h.rank = Number(x.tokens.rank);
    }
    for (const [id] of prev) if (!cur.has(id) && date) lines.get(id)!.events.push({ date, what: "dropped" });
    prev = cur;
  }
  for (const [id, h] of lines) {
    h.now = prev.has(id);
    // The ledger says why: confirmed, dropped, released (newest reason per change).
    for (const l of ledger.filter((x) => x.id === id)) h.events.push({ date: ymd(l.ts), what: "status", from: l.from, to: l.to, reason: l.reason });
    h.events.sort((a, b) => a.date.localeCompare(b.date));
  }
  return [...lines.values()].sort((a, b) => (a.kind === b.kind ? (a.rank ?? 99) - (b.rank ?? 99) : a.kind === "value" ? -1 : 1));
}

// ── The yearly review ───────────────────────────────────────────────────────

export const ODYSSEY = [
  { key: "current", title: "Life one: the current path", ask: "Five years on this road. What does a good year look like, and what does it cost?" },
  { key: "vanished", title: "Life two: if that path vanished", ask: "Your current work or plan is gone tomorrow. What would you do instead?" },
  { key: "free", title: "Life three: if money did not matter", ask: "Money and what people think do not matter. What would you do with these years?" },
] as const;
export interface OdysseySketch { key: string; sketch: string; quote: string; from: string }

export function odysseyPrompt(sources: { path: string; text: string }[]): string {
  return [
    "You help a person prepare their yearly review. Sketch three possible lives for the next five years, in two or three sentences each, from their own notes:",
    ...ODYSSEY.map((o) => `- ${o.key}: ${o.ask}`),
    "Every sketch must rest on something the person actually wrote: copy one short exact quote from the notes that it builds on. Do not invent facts about them. Plain words, no em dashes.",
    'Reply with JSON only: {"sketches": [{"key": "current|vanished|free", "sketch": "...", "quote": "<exact words from the notes>"}]}',
    "",
    ...sources.map((s) => `## ${s.path}\n${s.text.slice(0, 4000)}`),
  ].join("\n");
}

/** Keep a sketch only when its quote is in the user's notes (code, not trust). */
export async function checkSketches(raw: string, sources: { path: string; text: string }[]): Promise<OdysseySketch[]> {
  const { quoteSource } = await import("./compass.ts");
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let j: { sketches?: { key?: string; sketch?: string; quote?: string }[] };
  try { j = JSON.parse(m[0]); } catch { return []; }
  const out: OdysseySketch[] = [];
  for (const s of j.sketches ?? []) {
    if (!s || !ODYSSEY.some((o) => o.key === s.key) || typeof s.sketch !== "string" || typeof s.quote !== "string") continue;
    const src = quoteSource(s.quote, sources);
    if (!src) continue;
    if (out.some((x) => x.key === s.key)) continue;
    out.push({ key: s.key!, sketch: s.sketch.replace(/[–—]/g, ",").replace(/\s+/g, " ").trim().slice(0, 600), quote: s.quote.slice(0, 300), from: src.path });
  }
  return out;
}

export interface YearlyReview { year: number; file: string; values: HistoryLine[]; roles: HistoryLine[]; purpose: string | null; sketches: OdysseySketch[]; text: string }

/** The yearly review page (code). With run, the model sketches the three lives from the notes. */
export async function yearlyReview(vault: string, o: { year?: number; now?: number; run?: (prompt: string) => Promise<string>; write?: boolean } = {}): Promise<YearlyReview> {
  const now = o.now ?? Date.now();
  const year = o.year ?? new Date(now).getUTCFullYear();
  const hist = compassHistory(vault);
  const inYear = (e: HistoryEvent) => e.date.startsWith(String(year));
  const values = hist.filter((h) => h.kind === "value");
  const roles = hist.filter((h) => h.kind === "role");
  const m = mission(readCompass(vault));
  const purpose = m && m.text && !isProposed(m) ? m.text.replace(/^>\s*/gm, "").replace(/\s+/g, " ").trim() : null;
  let sketches: OdysseySketch[] = [];
  if (o.run) {
    const { bootstrapSources } = await import("./compass.ts");
    const sources = bootstrapSources(vault);
    if (sources.length) { try { sketches = await checkSketches(await o.run(odysseyPrompt(sources)), sources); } catch { sketches = []; } }
  }
  const moved = (h: HistoryLine) => h.events.filter(inYear).map((e) => e.what === "rank" ? `rank ${e.from || "?"} to ${e.to}` : e.what === "status" ? `${e.to}${e.reason ? ` (${e.reason})` : ""}` : e.what === "renamed" ? `renamed from ${e.from}` : e.what).join("; ");
  const line = (h: HistoryLine) => `- ${h.title}${h.now ? (h.rank ? ` (rank ${h.rank})` : "") : " (no longer in your Compass)"}${moved(h) ? `: ${moved(h)} in ${year}` : ""}`;
  const text = [
    `# Your yearly review, ${year}`,
    "",
    "Written by Prevail from your Compass and its history; nothing here changes the Compass. Answer in your own words under each question, or say it to your chief of staff.",
    "",
    "## Purpose",
    purpose ? `> ${purpose}` : "Not written yet.",
    "Does it still hold?",
    "",
    "## Values",
    ...(values.length ? values.map(line) : ["None confirmed yet."]),
    "Still the right ones, in the right order?",
    "",
    "## Roles",
    ...(roles.length ? roles.map(line) : ["None confirmed yet."]),
    "Which role needs more of you next year, and which less?",
    "",
    "## Three odyssey lives",
    ...ODYSSEY.flatMap((x) => {
      const s = sketches.find((k) => k.key === x.key);
      return ["", `### ${x.title}`, x.ask, ...(s ? [`A sketch from your notes: ${s.sketch}`, `  From: "${s.quote}" (${s.from})`] : []), "Your answer:", ""];
    }),
    "## One small prototype",
    "Pick one cheap way to try a piece of life two or three this year (a weekend, a conversation, a short course).",
    "",
  ].join("\n");
  const file = join(resolveDomainDir(vault, "general"), "memory", "reviews", `year-${year}.md`);
  if (o.write) {
    mkdirSync(join(file, ".."), { recursive: true });
    // The user's answers are theirs: an existing page is never overwritten.
    if (!existsSync(file)) writeFileSync(file, text);
  }
  return { year, file, values, roles, purpose, sketches, text };
}

// ── Export as a constitution ────────────────────────────────────────────────

/** The confirmed Compass as plain text any AI can read (never ~local lines). */
export function constitutionText(vault: string, now = Date.now()): string {
  const doc = readCompass(vault);
  const ok = (x: { tokens: Record<string, string>; flags?: string[] }) => !isProposed(x) && !x.flags?.includes("local");
  const words = (x: CompassItem) => x.fields.find((f) => f.key === "words")?.value.replace(/^"(.*)"$/, "$1");
  const list = (kind: Parameters<typeof items>[1], fmt: (x: CompassItem, i: number) => string) => items(doc, kind).filter(ok).map(fmt);
  const m = mission(doc);
  const values = items(doc, "value").filter(ok).sort((a, b) => Number(a.tokens.rank ?? 99) - Number(b.tokens.rank ?? 99));
  const sec = (title: string, lines: string[]) => (lines.length ? [`## ${title}`, ...lines, ""] : []);
  return [
    "# My constitution",
    "",
    `Exported from my Compass on ${ymd(now)}. These are my own words and choices. Please keep your help consistent with them, rank values in the order given, and tell me plainly when something I ask works against one of them. Never trade away a non-negotiable.`,
    "",
    ...sec("Purpose", m && m.text && ok(m) ? [m.text.replace(/^>\s*/gm, "").trim()] : []),
    ...sec("Values, most important first", values.map((v, i) => `${i + 1}. ${v.title}${words(v) ? `: "${words(v)}"` : ""}${v.fields.find((f) => f.key === "enough") ? ` (enough: ${v.fields.find((f) => f.key === "enough")!.value})` : ""}`)),
    ...sec("Mission statement", list("statement", (x) => `- ${x.title}`)),
    ...sec("Vision", list("vision", (x) => `- ${x.title}`)),
    ...sec("Objectives", list("objective", (x) => `- ${x.title}${x.tokens.target ? ` (target ${x.tokens.target})` : ""}${x.tokens.due ? ` by ${x.tokens.due}` : ""}`)),
    ...sec("Goals", items(doc, "goal").filter((g) => ok(g) && !["released", "done", "dropped"].includes(g.tokens.status ?? "")).map((g) => `- ${g.title}${g.tokens.due ? ` by ${g.tokens.due}` : ""}`)),
    ...sec("Roles", list("role", (x) => `- ${x.title}`)),
    ...sec("Non-negotiables", list("rule", (x) => `- ${x.title}`)),
    ...sec("Negotiables (I am flexible here)", list("negotiable", (x) => `- ${x.title}`)),
    ...sec("Capacity", list("capacity", (x) => `- ${x.title}`)),
  ].join("\n").replace(/[–—]/g, ",").trimEnd() + "\n";
}

export function exportConstitution(vault: string, now = Date.now()): { file: string; text: string } {
  const text = constitutionText(vault, now);
  const dir = join(buildRoot(vault), "exports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `compass-constitution-${ymd(now)}.md`);
  writeFileSync(file, text);
  return { file, text };
}

// ── CLI: prevail compass yearly | fresh | history | export ─────────────────

export async function lifetimeCommand(sub: string, argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  if (sub === "history") { const h = compassHistory(vault); if (args.json) out(h); else for (const x of h) console.log(`${x.kind.padEnd(5)} ${x.title}${x.now ? "" : " (dropped)"}: ${x.events.map((e) => `${e.date} ${e.what}${e.to ? ` ${e.to}` : ""}`).join(", ") || "no changes"}`); return 0; }
  if (sub === "fresh") {
    const r = args.has("pass") ? await freshStartPass(vault) : { starts: freshStarts(vault) };
    if (args.json) out(r); else console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  if (sub === "export") { const r = exportConstitution(vault); if (args.json) out(r); else { process.stdout.write(r.text); console.error(`saved ${r.file}`); } return 0; }
  if (sub === "yearly") {
    let run: ((p: string) => Promise<string>) | undefined;
    if (args.has("draft")) {
      const { detectClis, runChatTurn, defaultModelFor } = await import("./cli-bridge.ts");
      let clis = await detectClis();
      if (process.env.PREVAIL_BUNKER === "1") clis = clis.filter((c) => ["ollama", "lmstudio", "mlx"].includes(c.kind));
      const cli = clis.find((c) => c.kind === "claude") ?? clis[0];
      if (cli) run = (prompt) => runChatTurn({ prompt, cwd: resolveDomainDir(vault, "general"), cli, model: defaultModelFor(cli.kind), isFirst: true, bare: true });
    }
    const y = args.get("year");
    const r = await yearlyReview(vault, { ...(y ? { year: Number(y) } : {}), run, write: args.has("write") });
    if (args.json) out(r); else process.stdout.write(r.text);
    return 0;
  }
  console.error("usage: prevail compass yearly [--year Y] [--draft] [--write] | fresh [--pass] | history | export [--json]");
  return 1;
}

export const LIFETIME_SUBCOMMANDS = ["yearly", "fresh", "history", "export"];
