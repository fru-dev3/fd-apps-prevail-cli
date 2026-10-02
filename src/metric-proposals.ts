// Metrics that learn: proposals, answers, lifecycle and insights.
//
// Ben proposes metrics from five places (metrics-plan "How metrics are
// learned"):
//   1. ideal   the "Metrics you track" section of each domain's ideal state
//   2. goal    Compass goals with nothing measuring them
//   3. pattern a built-in metric that moves most weeks but is not pinned, and
//              anything said in chat three or more times ("ran 5k")
//   4. chat    numbers said in chat become stated events (said.ts); a
//              recurring one is a pattern proposal
//   5. source  a non-negotiable whose check needs a source not connected yet
// Each proposal carries 12 weeks of history when it can be computed, and is
// ranked by relevance x reliability x coverage x what the user accepted
// before. Two "not useful" answers on a kind stop that kind. Answers and
// corrections are lines in build/_meta/metrics/proposals.jsonl and
// rules.jsonl; nothing is ever deleted.
//
// Lifecycle lives in build/metrics.md: Tracking (silent), Pinned (shown),
// Paused (a season), Retired (with a because: line). Caps in code: a pinned
// metric must name what it serves (or be documentary), at most three pinned
// per value, goal or domain, at most five pinned in all (the glance).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { allDefs, baseline, metricsDir, metricsMdPath, readRegistry, seedMetricsMd, series, weekOf, dayOf, type Computed, type Lifecycle, type MetricDef } from "./metrics.ts";
import { items, readCompass } from "./compass.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { resolveDomainDir } from "./path-safety.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";

export type ProposalKind = "ideal" | "goal" | "pattern" | "source";
export interface MetricProposal {
  key: string;
  kind: ProposalKind;
  title: string;
  why: string;
  /** A computable metric: a built-in id, or a learned definition to add. */
  metric?: string;
  learn?: { src: string; kind: string; per: "week" | "month"; unit: string; tier: string; value?: string };
  serves?: string;
  servesTitle?: string;
  domain?: string;
  quote?: string;
  from: string;
  tier: string;
  spark: number[];
  now?: number;
  computable: boolean;
  score: number;
}

const readText = (p: string) => { try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } } };
const keyOf = (...parts: string[]) => `mp-${createHash("sha1").update(parts.join("\n").toLowerCase()).digest("hex").slice(0, 8)}`;
const proposalsPath = (vault: string) => join(metricsDir(vault), "proposals.jsonl");
const rulesPath = (vault: string) => join(metricsDir(vault), "rules.jsonl");
const insightsPath = (vault: string) => join(metricsDir(vault), "insights.jsonl");

function readJsonl<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as T] : []; } catch { return []; } });
}
function append(p: string, row: unknown): void {
  mkdirSync(join(p, ".."), { recursive: true });
  appendFileSync(p, `${JSON.stringify(row)}\n`);
}

// Words that map a stated metric or a goal to a metric Prevail can compute today.
const MAP: [RegExp, string][] = [
  [/\b(ai|token|llm|model) (spend|cost)|\bspend on ai\b/i, "m-ai-spend"],
  [/\btokens?\b/i, "m-ai-tokens"],
  [/\bcommits?\b|\bcode\b|\bcoding\b/i, "m-commits"],
  [/\bship(ped|ping)?\b|\brelease|\blaunch/i, "m-shipped"],
  [/\btasks?\b|\bto-?dos?\b|\bclosed\b/i, "m-tasks-done"],
  [/\bdecisions?\b/i, "m-decisions"],
  [/\b(spend|spending|expenses?|budget)\b/i, "m-spend"],
  [/\btrips?\b|\btravel|\bplaces\b/i, "m-trips"],
  [/\bwatch(ing)?\b|\byoutube\b/i, "m-watch-minutes"],
  [/\bcalm\b|\bpeace of mind\b|\bstress\b/i, "m-calm"],
];
// What a goal or a rule would need that is not connected yet.
const NEEDS: [RegExp, string][] = [
  [/\b(job|role|career|hire|interview|recruit)/i, "Gmail headers and the calendar (job applications a week, interviews scheduled)"],
  [/\b(health|fit|weight|run|workout|exercise|sleep)/i, "Apple Health or a wearable (workouts, sleep)"],
  [/\b(cash|debt|net worth|savings|financial|money|income)/i, "Plaid (cash months, savings rate, new debt)"],
  [/\b(dinner|family|home|kids?|son|daughter|partner)/i, "the calendar (evenings home, weekends without work)"],
  [/\b(video|channel|youtube|post|blog|publish|content)/i, "YouTube analytics or the site repos (videos and posts published)"],
];

export function metricFor(text: string): string | undefined {
  return MAP.find(([re]) => re.test(text))?.[1];
}

/** Each domain's "Metrics you track" section, split into the user's own lines. */
export function idealMetricLines(vault: string): { domain: string; line: string; file: string }[] {
  const out: { domain: string; line: string; file: string }[] = [];
  for (const d of listDomainDirs(vault)) {
    if (d.startsWith("_")) continue;
    const f = join(resolveDomainDir(vault, d), "ideal-state.md");
    const t = readText(f);
    const m = /^##\s+Metrics you track\s*$/im.exec(t);
    if (!m) continue;
    const rest = t.slice(m.index + m[0].length);
    const end = /^##\s/m.exec(rest);
    const body = (end ? rest.slice(0, end.index) : rest).replace(/^\s*[-*]\s+/gm, "").replace(/\s+/g, " ").trim();
    for (const part of body.split(/;\s*|\.\s+(?=[A-Z])/)) {
      const line = part.replace(/[.;]\s*$/, "").replace(/^and\s+/i, "").trim();
      if (line.length >= 6 && line.length <= 200) out.push({ domain: d, line, file: relative(vault, f) });
    }
  }
  return out;
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const shortTitle = (s: string) => cap(s.split(/\s+/).slice(0, 8).join(" ").replace(/[,:]$/, ""));

/** Every candidate, before answers and ranking. */
export function candidates(vault: string, c: Computed): MetricProposal[] {
  const out: MetricProposal[] = [];
  const reg = readRegistry(vault);
  const defs = c.defs;
  const spark = (id: string) => series(c, id, "week", 12).map((p) => p.value);
  const def = (id: string) => defs.find((m) => m.id === id);
  const push = (p: Omit<MetricProposal, "score" | "spark" | "computable" | "tier"> & { tier?: string }) => {
    const d = p.metric ? def(p.metric) : undefined;
    out.push({ ...p, tier: p.tier ?? d?.tier ?? "needs a source", spark: p.metric ? spark(p.metric) : [], computable: !!d || !!p.learn, score: 0 });
  };
  // 1. The user's stated metrics.
  for (const { domain, line, file } of idealMetricLines(vault)) {
    const metric = metricFor(line);
    push({ key: keyOf("ideal", domain, line), kind: "ideal", title: metric ? `${def(metric)?.title} for ${domain}` : shortTitle(line), why: metric ? `You listed "${line}" in what you track for ${domain}; this is the part Prevail can count today.` : `You listed "${line}" in what you track for ${domain}. Nothing measures it yet.`, ...(metric ? { metric } : {}), domain, quote: line, from: file });
  }
  // 2. Compass goals with nothing measuring them.
  const doc = readCompass(vault);
  const served = new Set([...reg.values()].map((r) => r.tokens.serves).filter(Boolean).flatMap((s) => s!.split(",")));
  for (const g of items(doc, "goal")) {
    const st = g.tokens.status ?? "active";
    if (!["active", "confirmed", "prototyping"].includes(st) || served.has(g.id) || g.fields.some((f) => f.key === "signal")) continue;
    const metric = metricFor(g.title);
    const need = NEEDS.find(([re]) => re.test(g.title))?.[1];
    push({ key: keyOf("goal", g.id), kind: metric ? "goal" : "source", title: metric ? `${def(metric)?.title}, for "${g.title}"` : `Measure "${g.title}"`, why: metric ? `"${g.title}" has no metric. ${def(metric)?.title} is the closest thing Prevail already counts.` : `"${g.title}" has no metric${need ? `; it needs ${need}` : ""}.`, ...(metric ? { metric } : {}), serves: g.id, servesTitle: g.title, from: "build/compass.md" });
  }
  // 5. Non-negotiables whose check has no source.
  for (const r of items(doc, "rule")) {
    if (r.tokens.status === "proposed") continue;
    const need = NEEDS.find(([re]) => re.test(r.title))?.[1];
    if (!need || served.has(r.id)) continue;
    push({ key: keyOf("source", r.id), kind: "source", title: `Check "${r.title}"`, why: `To check your rule "${r.title}" without asking you, Prevail needs ${need}.`, serves: r.id, servesTitle: r.title, from: "build/compass.md" });
  }
  // 3. Built-in metrics that move most weeks but are not pinned.
  for (const m of defs) {
    if (m.documentary || reg.get(m.id)?.status === "pinned" || reg.get(m.id)?.status === "retired") continue;
    const s = spark(m.id).slice(-8);
    const active = s.filter((v) => v > 0).length;
    if (active >= 6) push({ key: keyOf("pattern", m.id), kind: "pattern", title: m.title, why: `${m.title} moved in ${active} of the last 8 weeks. Pin it to see it in your weekly review?`, metric: m.id, from: m.from });
  }
  // 3/4. Numbers said in chat, three or more times.
  const said = new Map<string, number>();
  for (const e of c.events) if (e.src === "stated") said.set(e.kind, (said.get(e.kind) ?? 0) + 1);
  for (const [kind, n] of said) {
    if (n < 3 || defs.some((m) => m.kinds.includes(kind))) continue;
    const what = kind.replace(/^stated\./, "");
    const unit = c.events.find((e) => e.kind === kind)?.attrs.unit;
    push({ key: keyOf("chat", kind), kind: "pattern", title: `${cap(what.replace(/-/g, " "))}, as you say it`, why: `You mentioned this ${n} times in chat. Track it from what you say, no entry needed?`, learn: { src: "stated", kind, per: "week", unit: unit === "usd" ? "usd" : unit === "km" || unit === "mi" ? String(unit) : unit === "hours" ? "hours" : "count", tier: "asked", ...(unit && unit !== "count" ? { value: "value" } : {}) }, from: "what you said in chat (counts only)", tier: "asked" });
  }
  return out;
}

interface Answer { ts: number; key: string; kind: ProposalKind; answer: "track" | "dismiss" | "edit"; title?: string; metric?: string }

export function readAnswers(vault: string): Answer[] { return readJsonl<Answer>(proposalsPath(vault)); }
export function readRules(vault: string): { ts: number; match: string; action: "never-propose" }[] { return readJsonl(rulesPath(vault)); }

/** Open proposals, ranked, with what the user answered before taken into account. */
export function proposals(vault: string, c: Computed, limit = 8): MetricProposal[] {
  const answers = readAnswers(vault);
  const answered = new Set(answers.map((a) => a.key));
  const rules = readRules(vault);
  const dismissedKinds = new Map<string, number>();
  for (const a of answers) if (a.answer === "dismiss") dismissedKinds.set(a.kind, (dismissedKinds.get(a.kind) ?? 0) + 1);
  const accepted = (k: string) => { const all = answers.filter((a) => a.kind === k); return (all.filter((a) => a.answer !== "dismiss").length + 1) / (all.length + 2); };
  const reg = readRegistry(vault);
  const tracked = new Set([...reg.entries()].filter(([, r]) => r.status === "pinned").map(([id]) => id));
  return candidates(vault, c)
    .filter((p) => !answered.has(p.key))
    // Two "not useful" on a kind stop that kind.
    .filter((p) => (dismissedKinds.get(p.kind) ?? 0) < 2)
    .filter((p) => !rules.some((r) => r.action === "never-propose" && (p.title.toLowerCase().includes(r.match.toLowerCase()) || (p.quote ?? "").toLowerCase().includes(r.match.toLowerCase()))))
    .filter((p) => !(p.metric && tracked.has(p.metric) && p.kind !== "goal"))
    .map((p) => {
      const relevance = p.serves ? 1 : p.domain ? 0.6 : 0.5;
      const reliability = !p.computable ? 0.3 : p.tier === "measured" ? 1 : p.tier === "derived" ? 0.8 : 0.7;
      const weeks = p.spark.filter((v) => v > 0).length;
      const coverage = p.computable ? Math.max(0.2, weeks / 12) : 0.3;
      const moves = p.spark.length && new Set(p.spark).size > 1 ? 1 : 0.6;
      return { ...p, score: Math.round(relevance * reliability * coverage * moves * accepted(p.kind) * 1000) / 1000 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Acceptance this month: what the user saw and what they kept. */
export function acceptance(vault: string, now = Date.now()): { month: string; answered: number; accepted: number; rate: number | null } {
  const month = dayOf(now).slice(0, 7);
  const a = readAnswers(vault).filter((x) => dayOf(x.ts).slice(0, 7) === month);
  const kept = a.filter((x) => x.answer !== "dismiss").length;
  return { month, answered: a.length, accepted: kept, rate: a.length ? Math.round((kept / a.length) * 100) / 100 : null };
}

// ── metrics.md lifecycle ────────────────────────────────────────────────────

const HEAD: Record<Lifecycle, string> = { pinned: "## Pinned", tracking: "## Tracking", paused: "## Paused", retired: "## Retired" };

/** Move a metric's line (with its indented lines) to a section, adding tokens. Unknown lines are kept. */
export function moveMetric(vault: string, id: string, to: Lifecycle, opts: { serves?: string; because?: string; line?: string } = {}): void {
  const p = metricsMdPath(vault);
  const lines = (existsSync(p) ? readText(p) : seedMetricsMd()).replace(/\s*$/, "").split("\n");
  // Split into the head and sections; take the metric's block out.
  const head: string[] = [];
  const secs: { heading: string; body: string[] }[] = [];
  let block: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^##\s/.test(l)) { secs.push({ heading: l, body: [] }); continue; }
    if (/^- \S/.test(l) && new RegExp(`~id:${id}(\\s|$)`).test(l) && !block.length) {
      block.push(l);
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!);
      continue;
    }
    (secs.length ? secs[secs.length - 1]!.body : head).push(l);
  }
  if (!block.length) {
    if (!opts.line) throw new Error(`no metric ${id} in metrics.md`);
    block = [opts.line];
  }
  if (opts.serves) block[0] = /~serves:\S+/.test(block[0]!) ? block[0]!.replace(/~serves:\S+/, `~serves:${opts.serves}`) : `${block[0]} ~serves:${opts.serves}`;
  block = block.filter((l) => !/^\s+because:/.test(l));
  if (to === "retired") block.push(`  because: ${opts.because!.replace(/\s+/g, " ").trim()}`);
  let sec = secs.find((x) => x.heading.trim() === HEAD[to]);
  if (!sec) { sec = { heading: HEAD[to], body: [] }; secs.push(sec); }
  const trimmed = (b: string[]) => { const x = [...b]; while (x.length && !x[0]!.trim()) x.shift(); while (x.length && !x[x.length - 1]!.trim()) x.pop(); return x; };
  sec.body = [...trimmed(sec.body), ...block];
  const out = [...trimmed(head)];
  for (const x of secs) { out.push("", x.heading); const b = trimmed(x.body); if (b.length) out.push("", ...b); }
  vwriteFile(p, `${out.join("\n")}\n`);
}

export const PIN_CAP_PER_TARGET = 3;
export const PIN_CAP_TOTAL = 5;

/** Change a metric's lifecycle, with the caps and rules in code. */
export function setLifecycle(vault: string, id: string, to: Lifecycle, opts: { serves?: string; because?: string; documentary?: boolean } = {}): void {
  const reg = readRegistry(vault);
  const r = reg.get(id);
  const def = allDefs(vault).find((m) => m.id === id);
  if (!r && !def) throw new Error(`unknown metric ${id}`);
  if (to === "retired" && !opts.because?.trim()) throw new Error("retiring a metric needs a because (goal met, never changed a decision, never moved)");
  if (to === "pinned") {
    const serves = opts.serves ?? r?.tokens.serves;
    const documentary = r?.tokens.mode === "documentary" || def?.documentary;
    if (!serves && !documentary) throw new Error("a pinned metric names what it serves (a value or goal id), or is documentary");
    const pinned = [...reg.entries()].filter(([x, l]) => l.status === "pinned" && x !== id);
    if (pinned.length >= PIN_CAP_TOTAL) throw new Error(`at most ${PIN_CAP_TOTAL} pinned metrics; unpin one first`);
    if (serves) for (const t of serves.split(",")) if (pinned.filter(([, l]) => (l.tokens.serves ?? "").split(",").includes(t)).length >= PIN_CAP_PER_TARGET) throw new Error(`at most ${PIN_CAP_PER_TARGET} pinned metrics per value or goal (${t})`);
    if (serves && !items(readCompass(vault)).some((i) => serves.split(",").includes(i.id))) throw new Error(`no Compass line ${serves}`);
  }
  const line = def ? `- ${def.title} ~id:${def.id} ~per:${def.per} ~unit:${def.unit} ~tier:${def.tier}` : undefined;
  moveMetric(vault, id, to, { serves: opts.serves, because: opts.because, line });
}

/** Track (or pin) a proposal; a learned one gets its definition line. */
export function answerProposal(vault: string, c: Computed, key: string, answer: "track" | "dismiss" | "edit", opts: { title?: string; serves?: string; never?: string } = {}, now = Date.now()): { id?: string } {
  const p = candidates(vault, c).find((x) => x.key === key);
  if (!p) throw new Error(`no open proposal ${key}`);
  append(proposalsPath(vault), { ts: now, key, kind: p.kind, answer, ...(opts.title ? { title: opts.title } : {}), ...(p.metric ? { metric: p.metric } : {}) } satisfies Answer);
  if (answer === "dismiss") {
    // A correction that sticks: "never propose X".
    if (opts.never?.trim()) append(rulesPath(vault), { ts: now, match: opts.never.trim().slice(0, 80), action: "never-propose" });
    return {};
  }
  const serves = opts.serves ?? p.serves;
  if (p.metric) {
    // A pattern ("moves most weeks; pin it?") is pinned when the user says what it serves.
    if (p.kind === "pattern" && serves) setLifecycle(vault, p.metric, "pinned", { serves });
    else if (serves) moveMetric(vault, p.metric, readRegistry(vault).get(p.metric)?.status ?? "tracking", { serves, line: lineFor(allDefs(vault).find((m) => m.id === p.metric)!) });
    return { id: p.metric };
  }
  if (p.learn) {
    const id = `m-${(opts.title ?? p.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30)}`;
    const L = p.learn;
    const line = `- ${opts.title ?? p.title} ~id:${id} ~per:${L.per} ~unit:${L.unit} ~tier:${L.tier} ~src:${L.src} ~kind:${L.kind}${L.value ? ` ~value:${L.value}` : ""}${serves ? ` ~serves:${serves}` : ""}`;
    moveMetric(vault, id, "tracking", { line });
    return { id };
  }
  // Not computable yet: kept as a wish in metrics.md, so it shows up when a source arrives.
  const id = `m-${p.key.slice(3)}`;
  moveMetric(vault, id, "paused", { line: `- ${opts.title ?? p.title} ~id:${id} ~tier:needs-source${serves ? ` ~serves:${serves}` : ""}${p.domain ? ` ~domain:${p.domain}` : ""}` });
  return { id };
}

const lineFor = (m: MetricDef) => `- ${m.title} ~id:${m.id} ~per:${m.per} ~unit:${m.unit} ~tier:${m.tier}`;

// ── Insights: change points against your own normal, with citations ─────────

export interface Insight { key: string; week: string; metric: string; title: string; text: string; direction: "up" | "down"; weeks: number[]; normal: { lo: number; hi: number }; files: string[] }

/**
 * A change point: the last three complete weeks all sit outside the normal
 * band of the eight weeks before them, on the same side. A simple, honest
 * rule (no model); labeled "a change", never a cause.
 */
export function changePoints(c: Computed): Insight[] {
  const out: Insight[] = [];
  const thisWeek = weekOf(dayOf(c.ts));
  const lastFull = weekOf(dayOf(new Date(`${thisWeek}T12:00:00`).getTime() - 86_400_000));
  for (const m of c.defs) {
    if (m.documentary) continue;
    const s = series(c, m.id, "week", 14).filter((p) => p.date <= lastFull);
    if (s.length < 11) continue;
    const recent = s.slice(-3);
    const byWeek = new Map(s.map((p) => [p.date, p.value]));
    const b = baseline(byWeek, recent[0]!.date);
    if (b.learning || b.hi === b.lo && b.hi === 0) continue;
    const up = recent.every((p) => p.value > b.hi);
    const down = recent.every((p) => p.value < b.lo);
    if (!up && !down) continue;
    const files = [...new Set(c.events.filter((e) => e.file && m.kinds.includes(e.kind) && e.ts >= recent[0]!.date).map((e) => e.file!))].slice(0, 6);
    const fmtv = (v: number) => (m.unit === "usd" ? `$${Math.round(v)}` : String(Math.round(v * 10) / 10));
    out.push({
      key: `${m.id}:${recent[2]!.date}`, week: recent[2]!.date, metric: m.id, title: m.title, direction: up ? "up" : "down",
      weeks: recent.map((p) => p.value), normal: { lo: b.lo, hi: b.hi }, files,
      text: `${m.title} has run ${up ? "above" : "below"} your normal for three weeks (${recent.map((p) => fmtv(p.value)).join(", ")}; normal ${fmtv(b.lo)} to ${fmtv(b.hi)}). A change, not a cause.`,
    });
  }
  return out;
}

/** Record new change points (once per metric and week) and return the open ones. */
export function insights(vault: string, c: Computed, now = Date.now()): Insight[] {
  const have = new Set(readJsonl<{ key: string }>(insightsPath(vault)).map((r) => r.key));
  const found = changePoints(c);
  for (const i of found) if (!have.has(i.key)) append(insightsPath(vault), { ts: now, ...i });
  return found;
}

export function insightFeedback(vault: string, key: string, useful: boolean, now = Date.now()): void {
  append(insightsPath(vault), { ts: now, key, feedback: useful ? "up" : "down" });
}

