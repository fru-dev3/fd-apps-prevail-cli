import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { buildRecommendations, categoryCounts, firstSentence, rankRecommendations, type Recommendation } from "./recommendations.ts";

// NOTE: use a project-local temp dir, NOT os.tmpdir(). On macOS os.tmpdir() is
// under /var/folders, and scanVault's validateVaultPath refuses to scan system
// paths like /var (a security feature), which would make scanVault return [].
function vault(): { root: string; put: (rel: string, v: unknown) => void; done: () => void } {
  const root = join(process.cwd(), `.rectest-${process.pid}-${Math.floor(performance.now() * 1000)}`);
  const put = (rel: string, v: unknown) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
  };
  for (const d of ["garden", "travel"]) put(`domains/${d}/_state.md`, "# state");
  return { root, put, done: () => rmSync(root, { recursive: true, force: true }) };
}

const NOW = Date.UTC(2031, 4, 20);
// NOW is years after the temp domains are created, so the dormant-domain
// rule would fire on every test; structure has its own tests (structure.test.ts).
const offline = { now: NOW, skip: { context: true, models: true, structure: true } } as const;

test("domain rec for a missing area; resolved and existing areas ignored", () => {
  const v = vault();
  v.put("_meta/intents_distilled.json", {
    intents: [
      { title: "Learn the lute", goal: "music", domains: ["music"], status: "active" },
      { title: "Old", domains: ["pottery"], status: "resolved" },
      { title: "Existing", domains: ["garden"], status: "active" },
    ],
  });
  try {
    const recs = buildRecommendations(v.root, offline);
    const ids = recs.map((r) => r.id);
    expect(ids).toContain("domain:music");
    expect(ids).not.toContain("domain:pottery");
    expect(ids).not.toContain("domain:garden");
    const dom = recs.find((r) => r.id === "domain:music")!;
    expect(dom.action).toEqual({ kind: "create_domain", domain: "music" });
    expect(dom.detail).toContain("Learn the lute");
    expect(dom.category).toBe("context");
  } finally { v.done(); }
});

test("Intent findings become rules, open loops and one drift item; verdicts respected", () => {
  const v = vault();
  v.put("_meta/mirror/findings.json", {
    generated_ts: NOW, letter: null,
    findings: [
      { id: "repeated_rules", kind: "repeated_rules", headline: "2 instructions", detail: "", metric: { value: 2, unit: "rules" }, visual: { type: "list", data: [] }, receipts: [], actions: ["rule"], cadence: "weekly", status: "new",
        items: [
          { id: "r1", label: "Always water before noon", rule_text: "Always water before noon", count: 7, project: "orchard" },
          { id: "r2", label: "Never prune in frost", rule_text: "Never prune in frost", count: 3 },
        ] },
      { id: "open_loops", kind: "open_loops", headline: "1 project went quiet", detail: "", metric: { value: 1, unit: "projects" }, visual: { type: "list", data: [] }, receipts: [], actions: ["resume"], cadence: "weekly", status: "new",
        items: [{ id: "orchard", label: "Orchard plan", count: 40, project: "orchard", domain: "garden" }] },
      { id: "goals_drift", kind: "goals_drift", headline: "2 of 5 parts of your life never came up", detail: "", metric: { value: 2, unit: "domains" }, visual: { type: "list", data: [] }, receipts: [], actions: ["none"], cadence: "quarterly", status: "new",
        items: [{ id: "travel", label: "travel", domain: "travel", count: 0 }, { id: "chess", label: "chess", domain: "chess", count: 0 }] },
    ],
  });
  v.put("_meta/mirror/verdicts.json", { findings: {}, items: { "repeated_rules::r2": { status: "not_really", ts: NOW } } });
  try {
    const recs = buildRecommendations(v.root, offline);
    const rule = recs.find((r) => r.id === "rule:r1")!;
    expect(rule.category).toBe("rules");
    expect(rule.metric.value).toBe(7);
    expect(rule.instruction).toBe("Always water before noon");
    expect(rule.evidence).toEqual({ kind: "finding", ref: "repeated_rules#r1", label: "Intent: instructions you keep restating" });
    expect(recs.map((r) => r.id)).not.toContain("rule:r2");
    const loop = recs.find((r) => r.id === "loop:orchard")!;
    expect(loop.category).toBe("projects");
    expect(loop.evidence?.kind).toBe("project");
    const drift = recs.find((r) => r.id === "intent:goals_drift")!;
    expect(drift.title).toBe("2 of 5 life areas never came up");
    expect(drift.metric.value).toBe(2);
  } finally { v.done(); }
});

test("projects.json recommendations map to categories; stuck projects need a restart", () => {
  const v = vault();
  const prompts = (n: number, bad: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ ts: i, text: i < bad ? "that is wrong again" : "add a row for the pears" })).join("\n");
  v.put("domains/garden/projects/orchard/prompts.jsonl", prompts(60, 20));
  v.put("domains/garden/projects/shed/prompts.jsonl", prompts(60, 2));
  v.put("_meta/projects.json", {
    generated_ts: NOW, model: "m", stats: {}, months: {}, recommendations_model: "m",
    projects: [
      { slug: "orchard", title: "Orchard plan", domain: "garden", status: "active", prompt_count: 60, pack_dir: "domains/garden/projects/orchard" },
      { slug: "shed", title: "Shed build", domain: "garden", status: "active", prompt_count: 60, pack_dir: "domains/garden/projects/shed" },
    ],
    recommendations: [
      { kind: "task", title: "Order the pear saplings", why: "The plan stalls without them.", domain: "garden", project_slug: "orchard" },
      { kind: "skill", title: "Pruning checklist", why: "You explain it every spring." },
      { kind: "app", title: "Weather service", why: "Frost dates drive the plan." },
    ],
  });
  try {
    const recs = buildRecommendations(v.root, offline);
    const task = recs.find((r) => r.title === "Order the pear saplings")!;
    expect(task.id).toMatch(/^proj:[0-9a-f]{12}$/);
    expect(task.category).toBe("projects");
    expect(task.action).toEqual({ kind: "project_rec", index: 0, project: "orchard" });
    expect(task.task).toEqual({ domain: "garden", text: "Order the pear saplings" });
    expect(recs.find((r) => r.title === "Pruning checklist")!.category).toBe("rules");
    expect(recs.find((r) => r.title === "Weather service")!.category).toBe("apps");
    const stuck = recs.find((r) => r.id === "stuck:orchard")!;
    expect(stuck.metric).toEqual({ value: 20, unit: "corrections in 60 prompts" });
    expect(recs.map((r) => r.id)).not.toContain("stuck:shed");
    // Ids are stable across builds.
    expect(buildRecommendations(v.root, offline).map((r) => r.id)).toEqual(recs.map((r) => r.id));
  } finally { v.done(); }
});

test("apps mirror: sign-in only when feeding an active domain, recipes, stale syncs", () => {
  const v = vault();
  const app = (id: string, extra: Record<string, unknown>) => ({ id, name: id.toUpperCase(), runtime: "claude", server: id, signin_hint: `sign in to ${id}`, syncable: true, domains: [], ...extra });
  v.put("_meta/apps/mirror.json", {
    generated_at: NOW, runtimes: [],
    apps: [
      app("rain", { status: "needs_auth", domains: ["garden"] }),
      app("stray", { status: "needs_auth", domains: ["nowhere"] }),
      app("seeds", { status: "connected", tools: [{ name: "list", full_name: "list", kind: "read", sync_allowed: true, chat_default: true }] }),
    ],
  });
  try {
    const recs = buildRecommendations(v.root, offline);
    const ids = recs.map((r) => r.id);
    expect(ids).toContain("signin:rain");
    expect(ids).not.toContain("signin:stray");
    expect(ids).toContain("recipe:seeds");
    const s = recs.find((r) => r.id === "signin:rain")!;
    expect(s.evidence).toEqual({ kind: "app", ref: "rain", label: "App: RAIN" });
    expect(s.category).toBe("apps");
  } finally { v.done(); }
});

test("entities: recurring people and places without a saved page", () => {
  const v = vault();
  const e = (id: string, kind: string, conversations: number, saved = false) => ({ id, name: id.split("/")[1], kind, aliases: [], kinds: [kind], mention_count: conversations, conversations, last_ts: NOW, mentions: [], co_mentions: [], saved });
  v.put("_meta/entities/index.json", { version: 1, generated_ts: NOW, entities: [
    e("person/ada", "person", 6), e("place/lisbon", "place", 4), e("person/bo", "person", 9, true), e("org/acme", "org", 20), e("person/cy", "person", 1),
  ] });
  try {
    const recs = buildRecommendations(v.root, offline).filter((r) => r.category === "people");
    expect(recs.map((r) => r.id)).toEqual(["entity:person/ada", "entity:place/lisbon"]);
    expect(recs[0].metric).toEqual({ value: 6, unit: "conversations" });
    expect(recs[0].action).toEqual({ kind: "save_entity", entity: "person/ada" });
  } finally { v.done(); }
});

test("ranking: by leverage, duplicates dropped, counts per category", () => {
  const r = (id: string, category: Recommendation["category"], leverage: number): Recommendation =>
    ({ id, category, leverage, title: id, detail: "", metric: { value: 1, unit: "" }, source: "intent", action: { kind: "open_finding" } });
  const ranked = rankRecommendations([r("a", "context", 10), r("b", "rules", 80), r("c", "apps", 80), r("b", "rules", 5)]);
  expect(ranked.map((x) => x.id)).toEqual(["b", "c", "a"]);
  expect(categoryCounts(ranked)).toEqual({ rules: 1, projects: 0, apps: 1, people: 0, models: 0, context: 1, structure: 0 });
});

test("an empty vault yields nothing and never throws", () => {
  const v = vault();
  try {
    expect(buildRecommendations(v.root, offline).filter((r) => r.id !== "apps:unfed")).toEqual([]);
  } finally { v.done(); }
});

test("the why is one sentence", () => {
  expect(firstSentence("Frost dates drive the plan. Without them it slips.")).toBe("Frost dates drive the plan.");
  expect(firstSentence("Use v2.1 of the tool. Then stop.")).toBe("Use v2.1 of the tool.");
  expect(firstSentence("No full stop here")).toBe("No full stop here");
});
