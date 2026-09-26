import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendStandingRule, applyVerdicts, findRepeatedCandidates, loadContext, mirrorHistory, readFindings, refreshMirror, setVerdict,
  standingRules, type Finding,
} from "./mirror.ts";
import { folderSnapshot, parseBrief, projectDiff, projectRestart, restartText } from "./project-restart.ts";
import type { PromptRec } from "./prompt-corpus.ts";
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
