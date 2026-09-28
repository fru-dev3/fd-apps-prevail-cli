// Recommendations: the one "what to do next" feed. Prevail already notices a
// lot on its own (Intent findings, project recommendations, stuck projects,
// connectors, recurring people and places, context gaps, benchmark results);
// this module gathers all of it into a single ranked list. Everything is
// read from files already in the vault, deterministically: no model call, so
// it is fast, explainable and testable.
//
// Every recommendation carries:
//   - a stable id (dismiss/save state in the app is keyed on it),
//   - a checkable number (metric) and one sentence of why,
//   - evidence: where it came from, so the app can open that place in-flow,
//   - a leverage score used for ranking ("Start here" is the top five).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimePath } from "./path-safety.ts";
import { scanVault, scanCommunityApps } from "./vault.ts";
import { buildPublicResults } from "./canonical-bench.ts";
import { computeContextScore } from "./score.ts";
import { readFindings, CORRECTION, type Finding } from "./mirror.ts";
import { readProjectsIndex, type ProjectsIndex } from "./prompt-projects.ts";
import { recommendationId, imperative } from "./project-restart.ts";
import { readMirrorCache, mergeApp, type MirrorApp } from "./apps-mirror.ts";
import { readIndex as readEntityIndex, type EntityRec } from "./entities.ts";
import { catchUpCount } from "./linking.ts";

export type RecCategory = "rules" | "projects" | "apps" | "people" | "models" | "context";

export type RecActionKind =
  | "create_domain" | "set_domain_model" | "set_domain_models" | "connect_app" | "improve_context"
  | "make_rule" | "open_finding" | "open_project" | "restart_project" | "project_rec"
  | "signin_app" | "draft_recipe" | "sync_app" | "save_entity" | "open_domain";

export interface RecEvidence {
  kind: "finding" | "project" | "entity" | "app" | "domain" | "benchmark";
  ref: string; // finding id, project slug, entity id, app id or domain name
  label: string; // what the link says ("Intent: repeated instructions")
}

// One row of an aggregated item (model defaults, domains with no app).
export interface RecRow {
  id: string; // stable; the app may dismiss a single row by this id
  domain: string;
  current?: string; // filled by the app when it knows the current default
  suggested?: string;
  suggested_label?: string;
  cli?: string;
  score?: number; // benchmark judge average, 0 to 10
  models_tested?: number;
}

export interface Recommendation {
  id: string;
  category: RecCategory;
  title: string;
  detail: string; // the one sentence of why
  metric: { value: number; unit: string };
  leverage: number; // 0 to 100, higher first
  evidence?: RecEvidence;
  source: "intent" | "projects" | "stuck" | "apps" | "entities" | "context" | "models" | "domains" | "updates";
  instruction?: string; // copyable text for an agent
  task?: { domain: string; text: string }; // what "add task" puts on a board
  rows?: RecRow[];
  action: {
    kind: RecActionKind;
    domain?: string; model?: string; cli?: string;
    rule?: string; finding?: string; item?: string; project?: string;
    app?: string; entity?: string; index?: number;
  };
}

export interface BuildOptions {
  now?: number;
  // Stuck-project detection reads each project's prompt pack; tests can turn
  // off the sources they do not exercise.
  skip?: Partial<Record<Recommendation["source"], boolean>>;
}

export function titleCase(s: string): string {
  return s.replace(/[-_]+/g, " ").split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : "")).join(" ");
}

const DAY = 86_400_000;
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));
const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
const oneLine = (s: string, n = 160) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}...` : t;
};
// The "why" is one sentence: the first one the model wrote.
export function firstSentence(s: string, n = 200): string {
  const t = s.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s+[A-Z(]|$)/.exec(t);
  return oneLine(m ? m[1] : t, n);
}
// Engine copy never carries em dashes.
const clean = (s: string) => s.replace(/\s*\u2014\s*/g, ", ").replace(/\u2013/g, "-");

// Turn a raw model id or benchmark label into a clean, executive-friendly name.
// "claude-opus-4-6" or "2026-06-04_claude-claude-opus-4-6" -> "Claude Opus 4.6".
export function humanizeModel(model: string, fallback: string): string {
  let s = (model || "").trim() || (fallback || "").trim();
  if (!s) return "the top model";
  s = s.replace(/^\d{4}-\d{2}-\d{2}_/, "");
  const VENDOR: Record<string, string> = {
    claude: "Claude", gpt: "GPT", gemini: "Gemini", llama: "Llama",
    opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", mistral: "Mistral",
    deepseek: "DeepSeek", qwen: "Qwen", grok: "Grok", kimi: "Kimi",
  };
  const out: string[] = [];
  for (const p of s.split(/[-_/]/).filter(Boolean)) {
    if (/^\d+$/.test(p) && out.length && /\d$/.test(out[out.length - 1])) {
      out[out.length - 1] += `.${p}`;
      continue;
    }
    const low = p.toLowerCase();
    out.push(VENDOR[low] ?? (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)));
  }
  const dedup = out.filter((w, i) => i === 0 || w !== out[i - 1]);
  return dedup.join(" ") || (fallback || "the top model");
}

// ---------------------------------------------------------------------------
// sources

const findingLabel: Record<string, string> = {
  repeated_rules: "Intent: instructions you keep restating",
  open_loops: "Intent: projects that went quiet",
  goals_drift: "Intent: parts of life that never came up",
  tooling_share: "Intent: time on tools and setup",
  late_night: "Intent: late-night corrections",
};

function fromFindings(findings: Finding[]): Recommendation[] {
  const out: Recommendation[] = [];
  for (const f of findings) {
    const ev = (item?: string): RecEvidence => ({ kind: "finding", ref: item ? `${f.id}#${item}` : f.id, label: findingLabel[f.kind] ?? "Intent" });
    if (f.kind === "repeated_rules") {
      for (const it of f.items) {
        const rule = it.rule_text ?? it.label;
        const n = it.count ?? 0;
        out.push({
          id: `rule:${it.id}`, category: "rules", source: "intent",
          title: `Make it a rule: ${oneLine(rule, 120)}`,
          detail: `You typed this in ${plural(n, "separate session")}; saved as a standing rule, every tool follows it without being told.`,
          metric: { value: n, unit: "times restated" },
          leverage: clamp(45 + n * 3, 0, 90),
          evidence: ev(it.id), instruction: rule,
          task: { domain: it.domain || "general", text: `Make a standing rule: ${rule}` },
          action: { kind: "make_rule", rule, finding: f.id, item: it.id },
        });
      }
    } else if (f.kind === "open_loops") {
      for (const it of f.items) {
        const n = it.count ?? 0;
        out.push({
          id: `loop:${it.id}`, category: "projects", source: "intent",
          title: `Resume or let go: ${it.label}`,
          detail: `${plural(n, "prompt")} went into it and then it stopped; decide so it stops taking up attention.`,
          metric: { value: n, unit: "prompts, then quiet" },
          leverage: clamp(35 + Math.min(25, n / 3)),
          evidence: { kind: "project", ref: it.project ?? it.id, label: `Project: ${it.label}` },
          task: { domain: it.domain || "general", text: `Resume or let go of ${it.label}` },
          action: { kind: "open_project", project: it.project ?? it.id, finding: f.id, item: it.id },
        });
      }
    } else if (f.kind === "goals_drift") {
      const silent = f.items.length;
      if (!silent) continue;
      const total = Number(/of (\d+)/.exec(f.headline)?.[1] ?? 0);
      out.push({
        id: "intent:goals_drift", category: "context", source: "intent",
        title: `${silent}${total ? ` of ${total}` : ""} life areas never came up`,
        detail: `None of your prompts touched ${f.items.slice(0, 3).map((i) => titleCase(i.domain ?? i.label)).join(", ")}${silent > 3 ? " and others" : ""}; check whether they still matter to you.`,
        metric: { value: silent, unit: "silent areas" },
        leverage: clamp(25 + silent),
        evidence: ev(), action: { kind: "open_finding", finding: f.id },
      });
    } else if (f.kind === "tooling_share") {
      const pct = f.metric?.value ?? 0;
      if (pct < 40) continue;
      out.push({
        id: "intent:tooling_share", category: "projects", source: "intent",
        title: `${pct}% of this week went into tools and setup`,
        detail: "Most of your sittings were on tooling rather than the work it serves; pick one outcome project for next week.",
        metric: { value: pct, unit: "% on tooling" },
        leverage: clamp(20 + pct / 3),
        evidence: ev(), action: { kind: "open_finding", finding: f.id },
      });
    }
  }
  return out;
}

const PROJECT_REC: Record<string, { cat: RecCategory; base: number; unit: string }> = {
  task: { cat: "projects", base: 55, unit: "task" },
  automation: { cat: "projects", base: 50, unit: "automation" },
  project: { cat: "projects", base: 40, unit: "project" },
  skill: { cat: "rules", base: 50, unit: "skill" },
  habit: { cat: "rules", base: 35, unit: "habit" },
  app: { cat: "apps", base: 45, unit: "app" },
};

function fromProjects(idx: ProjectsIndex | null): Recommendation[] {
  if (!idx) return [];
  const titles = new Map(idx.projects.map((p) => [p.slug, p]));
  // A recommendation tied to a busy project moves more than one tied to a
  // project touched twice.
  return (idx.recommendations ?? []).map((r, index) => {
    const meta = PROJECT_REC[r.kind] ?? PROJECT_REC.task;
    const proj = r.project_slug ? titles.get(r.project_slug) : undefined;
    const n = proj?.prompt_count ?? 0;
    return {
      id: `proj:${recommendationId(r)}`, category: meta.cat, source: "projects",
      title: clean(r.title),
      detail: clean(firstSentence(r.why)),
      metric: { value: n, unit: n ? `prompts on ${proj!.title}` : meta.unit },
      leverage: clamp(meta.base + Math.min(20, n / 20) + (proj?.status === "active" ? 5 : 0)),
      evidence: proj ? { kind: "project", ref: proj.slug, label: `Project: ${proj.title}` } : undefined,
      instruction: imperative(r.kind, clean(r.title)),
      task: { domain: r.domain || proj?.domain || "general", text: clean(r.title) },
      action: { kind: "project_rec", index, project: r.project_slug },
    } satisfies Recommendation;
  });
}

// A project where a large share of prompts were corrections ("again", "still
// wrong", "not what I asked") is stuck on the model that built it. Its replay
// brief carries every requirement, so a restart on a newer model is cheap.
export function correctionCounts(vault: string, idx: ProjectsIndex | null): Map<string, { corrections: number; prompts: number }> {
  const out = new Map<string, { corrections: number; prompts: number }>();
  for (const p of idx?.projects ?? []) {
    if (!p.pack_dir) continue;
    let raw = "";
    try { raw = readFileSync(join(vault, p.pack_dir, "prompts.jsonl"), "utf8"); } catch { continue; }
    let c = 0; let n = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = String((JSON.parse(line) as { text?: string }).text ?? "");
        n += 1;
        if (CORRECTION.test(t)) c += 1;
      } catch { /* partial line */ }
    }
    out.set(p.slug, { corrections: c, prompts: n });
  }
  return out;
}

function fromStuck(vault: string, idx: ProjectsIndex | null): Recommendation[] {
  const counts = correctionCounts(vault, idx);
  const out: Recommendation[] = [];
  for (const p of idx?.projects ?? []) {
    const c = counts.get(p.slug);
    if (!c || p.status === "done") continue;
    const ratio = c.prompts ? c.corrections / c.prompts : 0;
    if (c.corrections < 10 || ratio < 0.12) continue;
    out.push({
      id: `stuck:${p.slug}`, category: "projects", source: "stuck",
      title: `Restart ${p.title} with a newer model`,
      detail: `${Math.round(ratio * 100)}% of its prompts were corrections; its replay brief already holds every requirement, so a fresh start skips the back-and-forth.`,
      metric: { value: c.corrections, unit: `corrections in ${c.prompts} prompts` },
      leverage: clamp(40 + ratio * 60 + Math.min(10, c.corrections / 10)),
      evidence: { kind: "project", ref: p.slug, label: `Project: ${p.title}` },
      task: { domain: p.domain || "general", text: `Restart ${p.title} from its replay brief with a newer model` },
      action: { kind: "restart_project", project: p.slug },
    });
  }
  return out;
}

function fromApps(vault: string, active: Set<string>, now: number): Recommendation[] {
  const doc = readMirrorCache(vault);
  if (!doc) return [];
  const out: Recommendation[] = [];
  for (const base of doc.apps) {
    let a: MirrorApp;
    try { a = mergeApp(vault, base); } catch { a = base; }
    const feeds = (a.domains ?? []).map((d) => d.toLowerCase()).filter((d) => active.has(d));
    const ev: RecEvidence = { kind: "app", ref: a.id, label: `App: ${a.name}` };
    if (a.status === "needs_auth" && feeds.length) {
      out.push({
        id: `signin:${a.id}`, category: "apps", source: "apps",
        title: `Sign in to ${a.name}`,
        detail: `It feeds ${feeds.map(titleCase).join(", ")}, but it is signed out, so those domains run on old data.`,
        metric: { value: feeds.length, unit: feeds.length === 1 ? "domain waiting" : "domains waiting" },
        leverage: clamp(50 + feeds.length * 5),
        evidence: ev, instruction: a.signin_hint || undefined,
        action: { kind: "signin_app", app: a.id },
      });
    } else if (a.status === "connected" && a.recipe && a.recipe.schedule !== "manual") {
      const limit = (a.recipe.schedule === "daily" ? 3 : 14) * DAY;
      const age = a.last_sync ? now - a.last_sync : Infinity;
      if (age > limit) {
        const days = Number.isFinite(age) ? Math.floor(age / DAY) : 0;
        out.push({
          id: `stale:${a.id}`, category: "apps", source: "apps",
          title: days ? `${a.name} last synced ${days} days ago` : `${a.name} has never synced`,
          detail: `Its ${a.recipe.schedule} sync is overdue${a.last_error ? ` (last error: ${oneLine(a.last_error, 80)})` : ""}; run it so ${feeds.length ? feeds.map(titleCase).join(", ") : "its domains"} stay current.`,
          metric: { value: days, unit: "days since sync" },
          leverage: clamp(40 + Math.min(20, days)),
          evidence: ev, action: { kind: "sync_app", app: a.id },
        });
      }
    } else if (a.status === "connected" && a.syncable && !a.recipe && (a.tools ?? []).some((t) => t.sync_allowed)) {
      out.push({
        id: `recipe:${a.id}`, category: "apps", source: "apps",
        title: `Draft a sync recipe for ${a.name}`,
        detail: "It is connected with read tools but never copies anything into your vault; a recipe turns it into a data source.",
        metric: { value: (a.tools ?? []).filter((t) => t.sync_allowed).length, unit: "read tools unused" },
        leverage: 30, evidence: ev, action: { kind: "draft_recipe", app: a.id },
      });
    }
  }
  return out;
}

function fromUnfed(domains: string[]): Recommendation[] {
  let apps: ReturnType<typeof scanCommunityApps> = [];
  try { apps = scanCommunityApps(); } catch { return []; }
  const fed = new Set<string>();
  for (const a of apps) for (const d of a.domains ?? []) fed.add(String(d).toLowerCase());
  const rows = domains.filter((d) => !fed.has(d.toLowerCase())).map((d) => ({ id: `app:${d.toLowerCase()}`, domain: d }));
  if (!rows.length) return [];
  return [{
    id: "apps:unfed", category: "apps", source: "apps",
    title: `${plural(rows.length, "domain")} have no app feeding them`,
    detail: "No connector syncs real data into these domains, so their context comes only from what you type.",
    metric: { value: rows.length, unit: "domains unfed" },
    leverage: clamp(15 + rows.length / 2),
    rows, action: { kind: "connect_app" },
  }];
}

function fromEntities(vault: string): Recommendation[] {
  const idx = readEntityIndex(vault);
  const cands = idx.entities
    .filter((e: EntityRec) => (e.kind === "person" || e.kind === "place") && !e.saved && e.conversations >= 3 && e.relation !== "reference")
    .sort((a, b) => b.conversations - a.conversations || b.mention_count - a.mention_count || a.id.localeCompare(b.id))
    .slice(0, 8);
  return cands.map((e) => ({
    id: `entity:${e.id}`, category: "people" as const, source: "entities" as const,
    title: `Save a page for ${e.name}`,
    detail: `${e.kind === "person" ? "This person" : "This place"} came up in ${plural(e.conversations, "conversation")}; saving keeps a running page every tool can read.`,
    metric: { value: e.conversations, unit: "conversations" },
    leverage: clamp(20 + e.conversations * 2, 0, 50),
    evidence: { kind: "entity" as const, ref: e.id, label: `${e.kind === "person" ? "Person" : "Place"}: ${e.name}` },
    action: { kind: "save_entity" as const, entity: e.id },
  }));
}

function fromContext(vault: string, domains: string[]): Recommendation[] {
  const out: Recommendation[] = [];
  for (const d of domains) {
    try {
      const sc = computeContextScore(vault, d);
      const serious = (sc.missing ?? []).filter((m) => m.severity === "critical" || m.severity === "warn");
      if (sc.score < 60 && serious.length > 0) {
        const s = Math.round(sc.score);
        out.push({
          id: `context:${d.toLowerCase()}`, category: "context", source: "context",
          title: `Strengthen ${titleCase(d)} context`,
          detail: `${clean(serious[0].label)}; richer context makes every answer and loop in ${titleCase(d)} sharper.`,
          metric: { value: s, unit: "/100 context" },
          leverage: clamp(20 + (60 - s) / 2),
          evidence: { kind: "domain", ref: d, label: `Domain: ${titleCase(d)}` },
          task: { domain: d, text: `Add context to ${titleCase(d)}: ${clean(serious[0].label)}` },
          action: { kind: "improve_context", domain: d },
        });
      }
    } catch { /* scoring unavailable for this domain */ }
  }
  return out;
}

// A domain other conversations have been noting things into since its state
// was last written (linking.ts catchUpCount).
export function fromUpdates(vault: string, domains: string[], now: number): Recommendation[] {
  const out: Recommendation[] = [];
  for (const d of domains) {
    const n = catchUpCount(vault, d, now);
    if (!n) continue;
    out.push({
      id: `updates:${d.toLowerCase()}`, category: "context", source: "updates",
      title: `Catch ${titleCase(d)} up: ${plural(n, "update")} from other domains`,
      detail: `Conversations elsewhere noted ${plural(n, "thing")} for ${titleCase(d)} since its state was last written.`,
      metric: { value: n, unit: "updates" },
      leverage: clamp(25 + n * 3, 0, 60),
      evidence: { kind: "domain", ref: d, label: `Domain: ${titleCase(d)}` },
      action: { kind: "open_domain", domain: d },
    });
  }
  return out;
}

function fromDomains(vault: string, have: Set<string>): Recommendation[] {
  let doc: { intents?: Array<{ title?: string; goal?: string; domains?: string[]; status?: string }> };
  try { doc = JSON.parse(readFileSync(join(runtimePath(vault, "_meta"), "intents_distilled.json"), "utf8")); } catch { return []; }
  const missing = new Map<string, { n: number; ex: string }>();
  for (const it of doc.intents ?? []) {
    if (it.status === "resolved") continue;
    for (const d of it.domains ?? []) {
      const dl = String(d).toLowerCase().trim();
      if (!dl || dl.startsWith("_") || have.has(dl)) continue;
      const c = missing.get(dl) ?? { n: 0, ex: "" };
      c.n += 1;
      if (!c.ex) c.ex = it.title || it.goal || "";
      missing.set(dl, c);
    }
  }
  // Domains are meant to be few and broad: only the strongest three.
  return [...missing.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, 3).map(([d, c]) => ({
    id: `domain:${d}`, category: "context" as const, source: "domains" as const,
    title: `Create a "${titleCase(d)}" domain`,
    detail: `${plural(c.n, "open intent")} touch ${titleCase(d)}${c.ex ? ` (e.g. "${oneLine(c.ex, 60)}")` : ""}; add it only if it is a broad area, not a facet of one you have.`,
    metric: { value: c.n, unit: "open intents" },
    leverage: clamp(30 + c.n * 3, 0, 55),
    action: { kind: "create_domain" as const, domain: d },
  }));
}

// All benchmark wins collapse into ONE item with a row per domain.
function fromModels(vault: string, active: Set<string>): Recommendation[] {
  let pr: ReturnType<typeof buildPublicResults>;
  try { pr = buildPublicResults(vault, ""); } catch { return []; }
  const rows: RecRow[] = [];
  for (const domain of pr.domains) {
    if (domain.startsWith("_") || (active.size && !active.has(domain.toLowerCase()))) continue;
    let best: { key: string; label: string; score: number } | null = null;
    let scored = 0;
    for (const m of pr.models) {
      const cell = pr.matrix[m.key]?.[domain];
      if (cell?.judge_avg != null && cell.n > 0) {
        scored += 1;
        if (!best || cell.judge_avg > best.score) best = { key: m.key, label: m.label, score: cell.judge_avg };
      }
    }
    if (!best || scored < 2) continue;
    const m = pr.models.find((x) => x.key === best!.key);
    rows.push({
      id: `model:${domain}`, domain,
      suggested: m?.model ?? "", suggested_label: humanizeModel(m?.model ?? "", best.label), cli: m?.cli ?? "",
      score: Math.round(best.score * 10) / 10, models_tested: scored,
    });
  }
  if (!rows.length) return [];
  rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.domain.localeCompare(b.domain));
  return [{
    id: "models:defaults", category: "models", source: "models",
    title: `Better model defaults for ${plural(rows.length, "domain")}`,
    detail: "Benchmarks on your own questions found a clear winner in each; set them once and every chat in that domain routes there.",
    metric: { value: rows.length, unit: "domains" },
    leverage: clamp(30 + rows.length),
    evidence: { kind: "benchmark", ref: "benchmark", label: "Benchmark results" },
    rows, action: { kind: "set_domain_models" },
  }];
}

// ---------------------------------------------------------------------------

export const CATEGORY_ORDER: RecCategory[] = ["rules", "projects", "apps", "people", "models", "context"];

export function rankRecommendations(recs: Recommendation[]): Recommendation[] {
  const seen = new Set<string>();
  return recs
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort((a, b) => b.leverage - a.leverage || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.id.localeCompare(b.id));
}

export function buildRecommendations(vaultRoot: string, opts: BuildOptions = {}): Recommendation[] {
  const now = opts.now ?? Date.now();
  const skip = opts.skip ?? {};
  let domains: string[] = [];
  try { domains = scanVault(vaultRoot).map((d) => d.name).filter((n) => n && !n.startsWith("_")); } catch { /* no vault */ }
  const active = new Set(domains.map((d) => d.toLowerCase()));
  const idx = readProjectsIndex(vaultRoot);
  const recs: Recommendation[] = [];
  const add = (src: Recommendation["source"], f: () => Recommendation[]) => {
    if (skip[src]) return;
    try { recs.push(...f()); } catch { /* a missing source never blocks the rest */ }
  };
  add("intent", () => fromFindings(readFindings(vaultRoot, now).findings));
  add("projects", () => fromProjects(idx));
  add("stuck", () => fromStuck(vaultRoot, idx));
  add("apps", () => [...fromApps(vaultRoot, active, now), ...fromUnfed(domains)]);
  add("entities", () => fromEntities(vaultRoot));
  add("context", () => fromContext(vaultRoot, domains));
  add("updates", () => fromUpdates(vaultRoot, domains, now));
  add("domains", () => fromDomains(vaultRoot, active));
  add("models", () => fromModels(vaultRoot, active));
  return rankRecommendations(recs);
}

export function categoryCounts(recs: Recommendation[]): Record<RecCategory, number> {
  const out = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0])) as Record<RecCategory, number>;
  for (const r of recs) out[r.category] += 1;
  return out;
}

// Stable JSON for the CLI command. `existsSync` guards a missing vault.
export function recommendationsJson(vaultRoot: string): string {
  if (!existsSync(vaultRoot)) return JSON.stringify({ ok: false, error: "vault not found", recommendations: [] });
  const recs = buildRecommendations(vaultRoot);
  return JSON.stringify({ ok: true, generated_ts: Date.now(), counts: categoryCounts(recs), recommendations: recs });
}
