import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendStandingRule, applyVerdicts, findRepeatedCandidates, generatePeriod, loadContext, mirrorHistory, periodFindings, periodsList,
  periodWindow, readFindings, refreshMirror, setVerdict, standingRules, type Finding,
} from "./mirror.ts";
import {
  folderSnapshot, imperative, parseBrief, projectDiff, projectRestart, recommendationId, recommendationInstruction, restartText,
} from "./project-restart.ts";
import { loadCorpus, type PromptRec } from "./prompt-corpus.ts";
import type { ModelRunner } from "./prompt-projects.ts";

const HOME = "/Users/someone";
const NOW = Date.parse("2026-09-23T12:00:00Z"); // a Wednesday
const H = 3600e3;
const D = 24 * H;

const SHOP = `${HOME}/Documents/acme/web-apps/web-apps-shop`;
const KIT = `${HOME}/Documents/agent-kit`;
const MAPLE = `${HOME}/Documents/maple-st`;

const BRIEF = `<!-- prevail:replay-brief model=test-model generated=2026-09-20T00:00:00.000Z prompts=9 from=2026-08-01 to=2026-09-22 -->
# Rebuild: Acme Shop

A small web shop for Sam's pottery, with a cart and checkout. Done means Sam can sell a mug.

## Requirements

### A. Catalog
1. Products list with photos and prices.
2. Brand color is "office green #008000, never gold".

### B. Checkout
3. Checkout takes cards and
   sends a receipt email.

## Rules the person has already had to state (do not make them say these again)
(every correction)
- Never use gold anywhere.
- "No em dashes in any copy."

## Decisions already made
- Stripe for payments, because Sam already has an account.

## Pitfalls
- The first cart lost items on reload; persist it.

## Acceptance checks
- Buy a mug end to end.

## Open questions
- Should shipping be flat rate?
`;

let vault: string;
let calls: string[];

const run: ModelRunner = async (prompt) => {
  if (prompt.startsWith("Classify each project")) { calls.push("kinds"); return JSON.stringify({ "agent-kit": "tooling", "acme-shop": "outcome", "maple-st": "outcome" }); }
  if (prompt.includes("Find the RULES")) { calls.push("rules"); return '```json\n[{"rule":"Never use gold; the brand color is office green #008000.","groups":["G1"]}]\n```'; }
  if (prompt.includes("For EACH week write")) {
    calls.push("weeks");
    const weeks = [...prompt.matchAll(/^### (\d{4}-\d{2}-\d{2}) /gm)].map((m) => m[1]);
    return JSON.stringify(Object.fromEntries(weeks.map((w) => [w, `You mostly worked on the shop in the week of ${w}.`])));
  }
  if (prompt.includes("For EACH day write")) {
    calls.push("days");
    const days = [...prompt.matchAll(/^### (\d{4}-\d{2}-\d{2}) /gm)].map((m) => m[1]);
    return JSON.stringify(Object.fromEntries(days.map((d) => [d, `You mostly chased the shop on ${d}.`])));
  }
  if (prompt.includes("weekly letter")) { calls.push("letter"); return "You mostly worked on Acme Shop this week.\n\nOne rule kept coming back."; }
  if (prompt.includes("checking an existing codebase")) { calls.push("diff"); return JSON.stringify({ met: ["Products list with photos and prices."], missed: ["Never use gold anywhere."], unclear: [] }); }
  throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
};

function rec(ts: number, prompt: string, cwd: string, session: string) {
  return JSON.stringify({ ts: new Date(ts).toISOString(), epoch_ms: ts, tool: "claude", session, cwd, prompt, host: "mbp", entry: "cli" });
}

beforeEach(() => {
  calls = [];
  vault = mkdtempSync(join(tmpdir(), "mirror-test-"));
  for (const d of ["dev", "health", "travel", "money"]) mkdirSync(join(vault, "data", "domains", d), { recursive: true });
  writeFileSync(join(vault, "data", "domains", "dev", "ideal-state.md"), "# Dev\nShip small things often.\n");
  writeFileSync(join(vault, "data", "domains", "health", "ideal-state.md"), "# Health\n\nSleep eight hours and walk daily.\n");
  writeFileSync(join(vault, "data", "domains", "travel", "ideal-state.md"), "One trip a quarter.\n");
  mkdirSync(join(vault, "build", "_meta", "prompts"), { recursive: true });
  mkdirSync(join(vault, "build", "_meta", "projects"), { recursive: true });
  writeFileSync(join(vault, "build", "ideal-state.md"), "# My constitution\n\nBe kind.\n\n## Principles\n- Live intentionally.\n");

  const day = (n: number, h: number) => NOW - n * D + (h - 12) * H;
  const lines = [
    // the same rule, three sessions, three days
    rec(day(20, 10), "never use gold anywhere, the brand color is office green #008000", SHOP, "r1"),
    rec(day(10, 10), "again: never use gold, the brand color is office green #008000", SHOP, "r2"),
    rec(day(9, 10), "the brand color is office green #008000, never use gold anywhere", SHOP, "r3"),
    // said twice in one session: not a repeat across sessions
    rec(day(15, 10), "always run the linter before committing the change please", SHOP, "r4"),
    rec(day(15, 11), "always run the linter before committing the change", SHOP, "r4"),
    // last 7 days: 3 tooling sittings, 1 outcome sitting
    rec(day(3, 14), "add a tool to the agent kit that lists open tabs", KIT, "k1"),
    rec(day(3, 15), "now make it return JSON", KIT, "k1"),
    rec(day(2, 14), "wire the agent kit into the MCP config", KIT, "k2"),
    rec(day(1, 14), "add a checkout page to the shop", SHOP, "s1"),
    rec(day(1, 15), "show the cart total", SHOP, "s1"),
    // late sittings (UTC, tz 0)
    rec(day(4, 23) + 30 * 60e3, "the agent kit still fails, it didn't work again", KIT, "n1"),
    rec(day(3, 24) + 30 * 60e3, "wrong file, not what I asked", KIT, "n2"),
    rec(day(2, 25), "the export button is still broken", KIT, "n3"),
    // a burst that went quiet: one week, 100 days ago
    rec(day(100, 10), "compare refinance offers for the Maple St house", MAPLE, "m1"),
    rec(day(99, 10), "what closing costs should I expect", MAPLE, "m2"),
    rec(day(98, 10), "draft questions for the lender", MAPLE, "m3"),
    rec(day(98, 11), "list the documents they need", MAPLE, "m3"),
  ];
  writeFileSync(join(vault, "build", "_meta", "prompts", "claude.mbp.jsonl"), lines.join("\n") + "\n");

  const catalog = [
    { slug: "acme-shop", title: "Acme Shop", domain: "dev", kind: "site", summary: "A pottery web shop.", keys: ["web-apps-shop"] },
    { slug: "agent-kit", title: "Agent Kit", domain: "dev", kind: "library", summary: "Tools for my own agents.", keys: ["agent-kit"] },
    { slug: "maple-st", title: "Maple St refinance", domain: "money", kind: "life", summary: "Refinancing a house.", keys: ["maple-st"] },
  ];
  writeFileSync(join(vault, "build", "_meta", "projects", "state.json"), JSON.stringify({ version: 1, catalog, catalog_model: "m", sessions: {}, packs: {} }));
  const entry = (c: (typeof catalog)[number], status: string) => ({
    ...c, status, prompt_count: 1, first_ts: 0, last_ts: 0, monthly: {}, weekly: {}, tools: {}, pack_dir: `data/domains/${c.domain}/memory/projects/${c.slug}`,
    brief_model: "test-model", brief_ts: 0, intents: [], takeaways: [], ideas: [], open_questions: ["Open from the index"],
  });
  writeFileSync(join(vault, "build", "_meta", "projects.json"), JSON.stringify({
    generated_ts: NOW, model: "m", stats: {}, months: {}, recommendations: [], recommendations_model: "",
    projects: [entry(catalog[0], "active"), entry(catalog[1], "active"), entry(catalog[2], "active")],
  }));
  const pack = join(vault, "data", "domains", "dev", "memory", "projects", "acme-shop");
  mkdirSync(pack, { recursive: true });
  writeFileSync(join(pack, "brief.md"), BRIEF);
  writeFileSync(join(pack, "prompts.md"), "# Acme Shop: every prompt\n\n### 2026-09-22 10:00 · claude\n\nadd a checkout page to the shop\n");
});

afterEach(() => rmSync(vault, { recursive: true, force: true }));

const refresh = () => refreshMirror({ vault, run, now: NOW, tz: 0, home: vault });
const byKind = (fs: Finding[], k: string) => fs.find((f) => f.kind === k);

describe("mirror refresh", () => {
  test("computes the five findings from the corpus", async () => {
    const doc = await refresh();
    const kinds = doc.findings.map((f) => f.kind);
    expect(kinds).toEqual(["repeated_rules", "tooling_share", "open_loops", "late_night", "goals_drift"]);

    const rules = byKind(doc.findings, "repeated_rules")!;
    expect(rules.actions).toEqual(["rule"]);
    expect(rules.items).toHaveLength(1);
    expect(rules.items[0].rule_text).toBe("Never use gold; the brand color is office green #008000.");
    expect(rules.items[0].count).toBe(3);
    expect(rules.items[0].project).toBe("acme-shop");
    expect(rules.receipts.length).toBeGreaterThan(0);
    expect(rules.receipts[0].text.length).toBeLessThanOrEqual(240);

    const tooling = byKind(doc.findings, "tooling_share")!;
    // k1, k2, n1, n2, n3 are Agent Kit; s1 is the shop
    expect(tooling.metric).toEqual({ value: 83, unit: "%" });
    expect(tooling.visual.type).toBe("split");
    expect(tooling.headline).toContain("83%");

    const loops = byKind(doc.findings, "open_loops")!;
    expect(loops.items.map((i) => i.id)).toEqual(["maple-st"]);
    expect(loops.actions).toEqual(["resume", "let_go", "replay"]);

    const late = byKind(doc.findings, "late_night")!;
    expect(late.metric.value).toBe(100);
    expect(late.visual.type).toBe("bar");

    const drift = byKind(doc.findings, "goals_drift")!;
    expect(drift.headline).toMatch(/^2 of 3 parts of your life never came up in \d+ months?$/);
    expect(drift.items.map((i) => i.domain)).toEqual(["health", "travel"]);
    expect(drift.items[0].detail).toBe("Sleep eight hours and walk daily.");
    expect(drift.cadence).toBe("quarterly");

    for (const f of doc.findings) {
      expect(`${f.headline} ${f.detail}`).not.toContain(String.fromCharCode(0x2014));
      expect(f.status).toBe("new");
      expect(f.receipts.length).toBeLessThanOrEqual(5);
    }
    expect(doc.letter?.week).toBe("2026-09-14");
    expect(doc.letter?.markdown).toContain("Acme Shop");
    expect(existsSync(join(vault, "build", "_meta", "mirror", "letters", "2026-09-14.md"))).toBe(true);
    expect(calls.sort()).toEqual(["kinds", "letter", "rules", "weeks"]);
  });

  test("an unchanged corpus costs no model calls on the next refresh", async () => {
    await refresh();
    calls = [];
    const doc = await refresh();
    expect(calls).toEqual([]);
    expect(byKind(doc.findings, "repeated_rules")!.items[0].rule_text).toContain("office green");
    expect(readFindings(vault, NOW).findings).toHaveLength(5);
  });

  test("tags new sittings with entities once, through the injected entity runner", async () => {
    const tagCalls: string[] = [];
    const entityRun: ModelRunner = async (prompt) => {
      tagCalls.push(prompt);
      const ids = [...prompt.matchAll(/## Sitting (\S+)/g)].map((m) => m[1]);
      return JSON.stringify(Object.fromEntries(ids.map((id) => [id, [{ name: "Sam", kind: "person" }]])));
    };
    await refreshMirror({ vault, run: null, entityRun, now: NOW, tz: 0, home: vault });
    const tagged = tagCalls.length;
    expect(tagged).toBeGreaterThan(0);
    expect(tagCalls[0]).toContain("Extract the specific named entities");
    await refreshMirror({ vault, run: null, entityRun, now: NOW, tz: 0, home: vault });
    expect(tagCalls.length).toBe(tagged);
    const idx = JSON.parse(readFileSync(join(vault, "build", "_meta", "entities", "index.json"), "utf8"));
    expect(idx.entities.map((e: { id: string }) => e.id)).toContain("person/sam");
  });

  test("works with no model at all", async () => {
    const doc = await refreshMirror({ vault, run: null, now: NOW, tz: 0, home: vault });
    expect(byKind(doc.findings, "repeated_rules")!.items[0].count).toBe(3);
    expect(byKind(doc.findings, "tooling_share")).toBeUndefined();
    expect(doc.letter).toBeNull();
  });
});

describe("verdicts", () => {
  test("a confirmed rule lands under Standing rules once, and stops being proposed", async () => {
    const doc = await refresh();
    const item = byKind(doc.findings, "repeated_rules")!.items[0];
    const before = readFileSync(join(vault, "build", "ideal-state.md"), "utf8");
    const r = setVerdict(vault, "repeated_rules", "true", { item: item.id, now: NOW });
    expect(r.rule_added).toBe(true);
    expect(r.rule_path).toBe(join(vault, "build", "ideal-state.md"));
    const after = readFileSync(join(vault, "build", "ideal-state.md"), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("## Standing rules\n\n- Never use gold; the brand color is office green #008000.\n");
    expect(setVerdict(vault, "repeated_rules", "true", { item: item.id, now: NOW }).rule_added).toBe(false);
    expect(standingRules(vault)).toHaveLength(1);
    const again = await refresh();
    expect(byKind(again.findings, "repeated_rules")).toBeUndefined();
  });

  test("not really hides a finding; later snoozes it for a week", async () => {
    await refresh();
    setVerdict(vault, "late_night", "not_really", { now: NOW });
    setVerdict(vault, "tooling_share", "later", { now: NOW });
    const doc = readFindings(vault, NOW);
    expect(byKind(doc.findings, "late_night")).toBeUndefined();
    const t = byKind(doc.findings, "tooling_share")!;
    expect(t.status).toBe("later");
    expect(t.snoozed_until).toBe(NOW + 7 * D);
    expect(byKind(readFindings(vault, NOW + 8 * D).findings, "tooling_share")!.status).toBe("new");
  });

  test("an item can be dismissed on its own", () => {
    const f: Finding = {
      id: "goals_drift", kind: "goals_drift", headline: "h", detail: "d", metric: { value: 2, unit: "domains" }, visual: { type: "dots", data: [] },
      receipts: [], items: [{ id: "health", label: "health" }, { id: "travel", label: "travel" }], actions: ["none"], cadence: "quarterly", status: "new",
    };
    const out = applyVerdicts([f], { findings: {}, items: { "goals_drift::travel": { status: "not_really", ts: 0 } } });
    expect(out[0].items.map((i) => i.id)).toEqual(["health"]);
  });

  test("let go marks the project done and drops the loop", async () => {
    await refresh();
    const r = setVerdict(vault, "open_loops", "let_go", { item: "maple-st", now: NOW });
    expect(r.project_status).toBe("done");
    const idx = JSON.parse(readFileSync(join(vault, "build", "_meta", "projects.json"), "utf8"));
    expect(idx.projects.find((p: { slug: string }) => p.slug === "maple-st").status).toBe("done");
    const doc = await refresh();
    expect(byKind(doc.findings, "open_loops")).toBeUndefined();
  });

  test("appending a rule creates the section when missing and keeps the file", () => {
    writeFileSync(join(vault, "build", "ideal-state.md"), "# Me\nBe kind.");
    appendStandingRule(vault, "Keep replies short.");
    expect(readFileSync(join(vault, "build", "ideal-state.md"), "utf8")).toBe("# Me\nBe kind.\n\n## Standing rules\n\n- Keep replies short.\n");
    writeFileSync(join(vault, "build", "ideal-state.md"), "# Me\n\n## Standing rules\n- One.\n\n## Later\nx\n");
    appendStandingRule(vault, "Two.");
    expect(readFileSync(join(vault, "build", "ideal-state.md"), "utf8")).toBe("# Me\n\n## Standing rules\n- One.\n- Two.\n\n## Later\nx\n");
  });
});

describe("repeated candidates", () => {
  test("needs separate sessions on separate days", () => {
    const p = (ts: number, text: string, session: string): PromptRec => ({ ts, tool: "claude", host: "", session, cwd: "", domain: "", text, src: "", project: "" });
    const same = [p(NOW, "always run the linter before committing the change", "a"), p(NOW + 2 * D, "always run the linter before committing the change", "a")];
    expect(findRepeatedCandidates(same)).toHaveLength(0);
    const sameDay = [p(NOW, "always run the linter before committing the change", "a"), p(NOW + H, "always run the linter before committing the change", "b")];
    expect(findRepeatedCandidates(sameDay)).toHaveLength(0);
    const real = [p(NOW, "always run the linter before committing the change", "a"), p(NOW + 2 * D, "please always run the linter before committing", "b")];
    expect(findRepeatedCandidates(real)).toHaveLength(1);
  });
});

describe("history", () => {
  test("sittings by week, newest first, with intent lines and filters", async () => {
    await refresh();
    const ctx = loadContext(vault, { now: NOW, tz: 0, home: vault });
    const h = mirrorHistory(ctx);
    expect(h.total).toBe(ctx.sittings.length);
    expect(h.tools).toEqual(["claude"]);
    expect(h.weeks[0].week).toBe("2026-09-21");
    expect(h.weeks[0].intent_line).toContain("2026-09-21");
    const starts = h.weeks.flatMap((w) => w.sittings.map((s) => s.start_ts));
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
    const k1 = h.weeks.flatMap((w) => w.sittings).find((s) => s.prompts[0].text.startsWith("add a tool"))!;
    expect(k1.prompts).toHaveLength(2);
    expect(k1.project).toBe("agent-kit");
    expect(k1.project_title).toBe("Agent Kit");
    expect(mirrorHistory(ctx, { q: "closing costs" }).total).toBe(1);
    expect(mirrorHistory(ctx, { project: "maple-st" }).total).toBe(3);
    expect(mirrorHistory(ctx, { tool: "codex" }).total).toBe(0);
    expect(mirrorHistory(ctx, { before: NOW - 50 * D }).total).toBe(3);
    const page = mirrorHistory(ctx, { limit: 2 });
    expect(page.weeks.flatMap((w) => w.sittings)).toHaveLength(2);
    expect(page.total).toBe(ctx.sittings.length);
  });
});

describe("restart", () => {
  test("parses the brief into parts", () => {
    const b = parseBrief(BRIEF);
    expect(b.title).toBe("Acme Shop");
    expect(b.model).toBe("test-model");
    expect(b.goal).toStartWith("A small web shop");
    expect(b.requirements).toEqual([
      { text: "Products list with photos and prices.", source: "inferred" },
      { text: 'Brand color is "office green #008000, never gold".', source: "you" },
      { text: "Checkout takes cards and sends a receipt email.", source: "inferred" },
    ]);
    expect(b.rules).toEqual(["Never use gold anywhere.", '"No em dashes in any copy."']);
    expect(b.decisions).toHaveLength(1);
    expect(b.dead_ends).toEqual(["The first cart lost items on reload; persist it."]);
    expect(b.open_questions).toEqual(["Should shipping be flat rate?"]);
  });

  test("json, handoff, intent and raw", () => {
    const r = projectRestart(vault, "acme-shop", ["Never use gold anywhere."]);
    expect(r.slug).toBe("acme-shop");
    expect(r.brief_model).toBe("test-model");
    expect(r.rules).toEqual(['"No em dashes in any copy."']);
    const h = restartText(vault, "acme-shop", "handoff", { withPrompts: true });
    expect(h).toContain("## Rules I already had to give\n- Never use gold anywhere.");
    expect(h).toContain("## Dead ends (do not repeat these)");
    expect(h).toContain("# Appendix: my original prompts");
    expect(restartText(vault, "acme-shop", "intent")).toStartWith("# Acme Shop\n\nA small web shop");
    expect(restartText(vault, "acme-shop", "raw")).toContain("add a checkout page");
    expect(() => projectRestart(vault, "nope")).toThrow('no project "nope"');
  });

  test("diff reads the folder, never writes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mirror-diff-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
      writeFileSync(join(dir, "README.md"), "# Acme shop\n");
      writeFileSync(join(dir, "src", "cart.ts"), "export const cart = [];\n");
      writeFileSync(join(dir, "node_modules", "x", "index.js"), "junk");
      const snap = folderSnapshot(dir);
      expect(snap.tree).toEqual(["README.md", "src/", "src/cart.ts"]);
      expect(snap.files.map((f) => f.path)).toEqual(["README.md", "src/cart.ts"]);
      const res = await projectDiff(vault, "acme-shop", dir, { run });
      expect(res).toEqual({ met: ["Products list with photos and prices."], missed: ["Never use gold anywhere."], unclear: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("periods", () => {
  const noModel: ModelRunner = async () => { throw new Error("no model call expected"); };
  const ctxAt = () => loadContext(vault, { now: NOW, tz: 0, home: vault });

  test("weeks newest first, each with its days, counts, letter and line", async () => {
    await refresh();
    const doc = periodsList(ctxAt());
    const weeks = doc.weeks.map((w) => w.week);
    expect(weeks[0]).toBe("2026-09-21");
    expect([...weeks].sort().reverse()).toEqual(weeks);
    const cur = doc.weeks[0];
    expect(cur.current).toBe(true);
    expect(cur.label).toBe("Sep 21 to 27");
    expect(cur.has_letter).toBe(false);
    const last = doc.weeks.find((w) => w.week === "2026-09-14")!;
    expect(last.current).toBe(false);
    expect(last.has_letter).toBe(true);
    expect(last.intent_line).toContain("2026-09-14");
    expect(last.days.map((d) => d.day)).toEqual(["2026-09-20", "2026-09-19", "2026-09-14"]);
    expect(last.days[0].label).toBe("Sun, Sep 20");
    expect(last.days.reduce((a, d) => a + d.prompts, 0)).toBe(last.prompts);
    expect(doc.weeks.reduce((a, w) => a + w.prompts, 0)).toBe(ctxAt().prompts.length);
  });

  test("a date inside a week opens that week", () => {
    expect(periodWindow("week", "2026-09-17", 0).key).toBe("2026-09-14");
    expect(periodWindow("day", "2026-09-17", 0).week).toBe("2026-09-14");
    expect(() => periodWindow("day", "Sep 17", 0)).toThrow();
  });

  test("a past week's findings come from that week only, cached per period", async () => {
    await refresh();
    const doc = await periodFindings(ctxAt(), "week", "2026-09-14", { run: noModel });
    expect(doc.period).toEqual({ kind: "week", key: "2026-09-14", week: "2026-09-14", label: "Sep 14 to 20" });
    expect(doc.current).toBe(false);
    expect(doc.letter_status).toBe("ready");
    expect(doc.letter?.markdown).toContain("Acme Shop");
    expect(doc.totals).toEqual({ prompts: 4, sittings: 3 });
    expect(doc.projects.map((p) => [p.slug, p.sittings])).toEqual([["agent-kit", 2], ["acme-shop", 1]]);
    const kinds = doc.findings.map((f) => f.kind);
    expect(kinds).toEqual(["repeated_rules", "tooling_share", "goals_drift"]);
    for (const f of doc.findings) expect(f.id).toBe(`${f.kind}@week-2026-09-14`);
    const rules = doc.findings[0];
    expect(rules.items[0].rule_text).toBe("Never use gold; the brand color is office green #008000.");
    expect(rules.receipts[0].text).toContain("never use gold");
    expect(doc.findings[1].metric).toEqual({ value: 67, unit: "%" });
    expect(doc.findings[1].headline).toBe("67% of that week's sittings went into tools and setup");
    expect(doc.findings[2].headline).toBe("2 of 3 parts of your life did not come up that week");
    expect(existsSync(join(vault, "build", "_meta", "mirror", "periods", "week-2026-09-14.json"))).toBe(true);
    // A second open reads the cache: same answer, nothing recomputed.
    const again = await periodFindings(ctxAt(), "week", "2026-09-14", { run: noModel });
    expect(again.generated_ts).toBe(doc.generated_ts);
    expect(again.findings.map((f) => f.id)).toEqual(doc.findings.map((f) => f.id));
  });

  test("a day shows its line, its projects and the findings that apply", async () => {
    await refresh();
    await generatePeriod(ctxAt(), "2026-09-14", { run });
    const doc = await periodFindings(ctxAt(), "day", "2026-09-14", { run: noModel });
    expect(doc.period.label).toBe("Mon, Sep 14");
    expect(doc.period.week).toBe("2026-09-14");
    expect(doc.letter_status).toBe("none");
    expect(doc.intent_line).toBe("You mostly chased the shop on 2026-09-14.");
    expect(doc.projects).toEqual([{ slug: "acme-shop", title: "Acme Shop", domain: "dev", sittings: 1, prompts: 1, minutes: 1 }]);
    expect(doc.findings.map((f) => f.id)).toEqual(["repeated_rules@day-2026-09-14"]);
    expect(doc.findings[0].headline).toBe("1 standing instruction you restated that day");
    const quiet = await periodFindings(ctxAt(), "day", "2026-09-16", { run: noModel });
    expect(quiet.totals).toEqual({ prompts: 0, sittings: 0 });
    expect(quiet.findings).toEqual([]);
  });

  test("the week still going shows the standing findings", async () => {
    await refresh();
    const doc = await periodFindings(ctxAt(), "week", "2026-09-21", { run: noModel });
    expect(doc.current).toBe(true);
    expect(doc.letter_status).toBe("not_yet");
    expect(doc.findings.map((f) => f.id)).toEqual(readFindings(vault, NOW).findings.map((f) => f.id));
  });

  test("verdicts: not really on one week leaves the others; a kept rule leaves every period", async () => {
    await refresh();
    setVerdict(vault, "tooling_share@week-2026-09-14", "not_really", { now: NOW });
    const wk = await periodFindings(ctxAt(), "week", "2026-09-14", { run: noModel });
    expect(wk.findings.map((f) => f.kind)).not.toContain("tooling_share");
    expect(readFindings(vault, NOW).findings.map((f) => f.kind)).toContain("tooling_share");
    const item = wk.findings.find((f) => f.kind === "repeated_rules")!.items[0];
    const r = setVerdict(vault, "repeated_rules@week-2026-09-14", "true", { item: item.id, now: NOW });
    expect(r.rule_added).toBe(true);
    const day = await periodFindings(ctxAt(), "day", "2026-09-14", { run: noModel });
    expect(day.findings.map((f) => f.kind)).not.toContain("repeated_rules");
  });

  test("a past week's letter and day lines are written once, when it is first opened", async () => {
    await refreshMirror({ vault, run: null, now: NOW, tz: 0, home: vault });
    calls = [];
    const before = await periodFindings(ctxAt(), "week", "2026-09-07", { run: noModel });
    expect(before.letter_status).toBe("missing");
    const res = await generatePeriod(ctxAt(), "2026-09-07", { run });
    expect(calls.sort()).toEqual(["days", "letter", "weeks"]);
    expect(res.letter?.week).toBe("2026-09-07");
    expect(Object.keys(res.day_lines).sort()).toEqual(["2026-09-08", "2026-09-13"]);
    expect(existsSync(join(vault, "build", "_meta", "mirror", "letters", "2026-09-07.md"))).toBe(true);
    calls = [];
    await generatePeriod(ctxAt(), "2026-09-07", { run });
    expect(calls).toEqual([]);
    const after = await periodFindings(ctxAt(), "week", "2026-09-07", { run: noModel });
    expect(after.letter_status).toBe("ready");
    expect(after.intent_line).toContain("2026-09-07");
    // The week still going gets day lines but never a letter.
    const cur = await generatePeriod(ctxAt(), "2026-09-21", { run });
    expect(cur.letter).toBeNull();
    expect(existsSync(join(vault, "build", "_meta", "mirror", "letters", "2026-09-21.md"))).toBe(false);
  });
});

describe("history, exactly as typed", () => {
  test("a period's sittings, with the captured text untouched", () => {
    const typed = "  first line\n\n    indented **not bold**\n- a dash list\ttab\n\n";
    const long = `${"x".repeat(9000)}\nend`;
    const extra = [
      rec(NOW - 4 * H, typed, SHOP, "v1"),
      rec(NOW - 3 * H, long, SHOP, "v1"),
    ];
    writeFileSync(join(vault, "build", "_meta", "prompts", "claude.mbp.jsonl"), `${readFileSync(join(vault, "build", "_meta", "prompts", "claude.mbp.jsonl"), "utf8")}${extra.join("\n")}\n`);
    const ctx = loadContext(vault, { now: NOW, tz: 0, home: vault });
    const day = mirrorHistory(ctx, { win: periodWindow("day", "2026-09-23", 0).win });
    const texts = day.weeks.flatMap((w) => w.sittings.flatMap((s) => s.prompts.map((p) => p.text)));
    expect(texts).toEqual([typed, long]);
    const week = mirrorHistory(ctx, { win: periodWindow("week", "2026-09-14", 0).win });
    expect(week.weeks.map((w) => w.week)).toEqual(["2026-09-14"]);
    expect(week.total).toBe(3);
  });

  test("a desktop chat shows only what the person typed, not its context wrapper", () => {
    const wrapped = "# THE USER'S IDEAL STATE: their constitution.\nBe kind.\n---\n--- PRIOR TURNS ---\nold\n--- END PRIOR TURNS ---\n\nUser's next message: plan the  garden\n  beds";
    writeFileSync(join(vault, "build", "_meta", "prompts", "prevail.mbp.jsonl"), `${JSON.stringify({ ts: new Date(NOW - H).toISOString(), epoch_ms: NOW - H, tool: "prevail", session: "p1", cwd: "", prompt: wrapped })}\n`);
    const ctx = loadContext(vault, { now: NOW, tz: 0, home: vault });
    const h = mirrorHistory(ctx, { tool: "prevail" });
    expect(h.weeks[0].sittings[0].prompts[0].text).toBe("plan the  garden\n  beds");
  });

  test("prompts a harness or another agent wrote never appear", () => {
    const home = mkdtempSync(join(tmpdir(), "mirror-home-"));
    const brief = "Investigate the flaky checkout test in the acme shop and report back with the cause.";
    const sub = join(home, ".claude", "projects", "-work-acme", "s9", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-a1.jsonl"), `${JSON.stringify({ isSidechain: true, sessionId: "s9", type: "user", message: { role: "user", content: brief } })}\n`);
    const agentBrief = `You are researching pottery suppliers for a small shop. ${"Check each one carefully. ".repeat(20)}`;
    const lines = [
      rec(NOW - 5 * H, "[Image: original 1440x2400, displayed at 1200x2000. Multiply coordinates by 1.20 to map to original image.]", SHOP, "s8"),
      rec(NOW - 5 * H + 1, agentBrief, SHOP, "s8"),
      rec(NOW - 5 * H + 2, "You are deploying these on the new host, right?", SHOP, "s8"),
      rec(NOW - 5 * H + 3, brief, SHOP, "s9"),
      JSON.stringify({ ts: new Date(NOW - H).toISOString(), epoch_ms: NOW - H, tool: "claude", session: "s10", cwd: SHOP, prompt: "Summarize the open pull requests for the shop repository", entry: "sidechain" }),
      rec(NOW - H, "Extract the specific named entities a person mentions in their own prompts to AI tools.\n\nKinds: ...", SHOP, "s11"),
      rec(NOW - H, "# Pantry Agent\n\n## Role\nYou are the Pantry Domain Director.", SHOP, "s12"),
    ];
    writeFileSync(join(vault, "build", "_meta", "prompts", "claude.work.jsonl"), `${lines.join("\n")}\n`);
    const { prompts } = loadCorpus(vault, home);
    const texts = prompts.map((p) => p.text);
    expect(texts).toContain("You are deploying these on the new host, right?");
    for (const bad of [brief, agentBrief, "Summarize the open pull requests for the shop repository"]) expect(texts).not.toContain(bad);
    expect(texts.some((t) => t.startsWith("[Image: original") || t.startsWith("Extract the specific") || t.startsWith("# Pantry Agent"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("recommendation instruction", () => {
  const withRecs = () => {
    const path = join(vault, "build", "_meta", "projects.json");
    const idx = JSON.parse(readFileSync(path, "utf8"));
    idx.recommendations = [
      { kind: "task", title: "Add a shipping rate table to the shop", why: "Two sittings asked how shipping is priced.", domain: "dev", project: "Acme Shop", project_slug: "acme-shop" },
      { kind: "skill", title: "Pottery photo checklist", why: "Photos were redone three times.", domain: "dev" },
    ];
    writeFileSync(path, JSON.stringify(idx));
  };

  test("the recommendation, why, the project and its brief's goal and rules", () => {
    withRecs();
    const ins = recommendationInstruction(vault, "0");
    expect(ins.index).toBe(0);
    expect(ins.project).toBe("Acme Shop");
    expect(ins.text).toBe([
      "Add a shipping rate table to the shop.",
      "",
      "Why: Two sittings asked how shipping is priced.",
      "",
      "Project: Acme Shop (dev)",
      "Project goal: A small web shop for Sam's pottery, with a cart and checkout. Done means Sam can sell a mug.",
      "",
      "Rules already given for this project (follow them; do not make me repeat them):",
      "- Never use gold anywhere.",
      "- \"No em dashes in any copy.\"",
      "",
      "When it is done, say what changed and how you checked it.",
      "",
    ].join("\n"));
    // Same text every time, found by index or by id.
    expect(recommendationInstruction(vault, ins.id).text).toBe(ins.text);
    expect(ins.id).toBe(recommendationId({ kind: "task", title: "Add a shipping rate table to the shop" }));
  });

  test("no project: the area stands in; bad refs fail plainly", () => {
    withRecs();
    const ins = recommendationInstruction(vault, "1");
    expect(ins.text.split("\n")[0]).toBe("Write a reusable skill for Pottery photo checklist.");
    expect(ins.text).toContain("Area: dev");
    expect(ins.text).not.toContain("Project:");
    expect(() => recommendationInstruction(vault, "7")).toThrow(/no recommendation "7"/);
    expect(imperative("app", "Connect the pottery supplier API")).toBe("Connect the pottery supplier API.");
    expect(imperative("habit", "Weekly photo review")).toBe("Set up a habit: Weekly photo review.");
  });
});
