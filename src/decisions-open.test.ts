// Today T4: open decisions. Detection in chat (offered, never opened alone),
// from tasks (once, linked), from a Compass conflict; gut first; big ones go
// to the council; every open decision has options, trade-offs, a
// recommendation with confidence and a due date.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decisionFromConflict, decisionOffer, decisionsFromTasks, decisionView, deliberation, isBig, parseRecommendation, recommend } from "./decisions-open.ts";
import { listDecisions, openDecision, readRecord, setGut } from "./decision-records.ts";
import { computeGraph } from "./compass-align.ts";
import { runChatJson } from "./chat-json.ts";

const ROOT = join("/tmp", `prevail-decide-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const D = (d: string) => join(V, "data", "domains", d);
const NOW = new Date(2026, 9, 1, 12).getTime();

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "foo", "bar"]) { mkdirSync(join(D(d), "memory"), { recursive: true }); writeFileSync(join(D(d), "manifest.json"), "{}"); }
}

const ANSWER = "Options:\n- Keep the foo car\n- Sell it and lease\n- Sell it and walk\nTrade-offs:\n- Selling gives up about $200 a month of convenience to free $9,000 now.\n- Keeping costs repairs but keeps weekend trips easy.\nRecommendation:\nKeep the foo car one more year\nConfidence: medium\nWhat would change it:\nA repair quote over $2,000.";

describe("finding decisions", () => {
  beforeEach(seed);
  test("deliberation in chat", () => {
    expect(deliberation("Honestly, should I sell the foo car or keep it? It is old.")).toBe("Should I sell the foo car or keep it?");
    expect(deliberation("I'm torn between the foo school and the bar school for next year")).toBe("The foo school and the bar school for next year?");
    expect(deliberation("trying to decide whether to renew the bar lease")).toBe("To renew the bar lease?");
    expect(deliberation("What should the foo report include?")).toBeNull();
    expect(deliberation("Summarize the foo notes.")).toBeNull();
  });
  test("an offer, not a record, and none when one is already open", () => {
    const o = decisionOffer(V, "Should I sell the foo car or keep it?", "foo", NOW)!;
    expect(o).toEqual({ question: "Should I sell the foo car or keep it?", domain: "foo", due: "2026-10-15" });
    expect(listDecisions(V)).toEqual([]);
    openDecision(V, { question: "Sell the foo car or keep it?", domain: "foo" });
    expect(decisionOffer(V, "Should I sell the foo car or keep it?", "foo", NOW)).toBeNull();
  });
  test("tasks phrased as decisions open one record each, once, with the task's date", () => {
    writeFileSync(join(D("bar"), "memory", "tasks.md"), "- [ ] Decide whether to renew the bar lease @2026-10-20 ~id:t1\n- [ ] [DECIDE] Choose between the foo and bar plans ~id:t2\n- [ ] Call the bar office ~id:t3\n");
    const r = decisionsFromTasks(V, NOW);
    expect(r.map((x) => [x.question, x.due])).toEqual([["Renew the bar lease?", "2026-10-20"], ["The foo or bar plans?", expect.any(String)]]);
    expect(r[0]!.sections.Context).toContain("task:bar:t1");
    expect(decisionsFromTasks(V, NOW)).toEqual([]);
  });
  test("every open decision has a due date", () => {
    expect(openDecision(V, { question: "Repaint the foo shed?", domain: "foo" }).due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  test("a Compass conflict becomes a decision with its trade-off", async () => {
    mkdirSync(join(V, "build", "_meta", "compass"), { recursive: true });
    writeFileSync(join(V, "build", "compass.md"), "# Compass\n\n## Goals\n- [ ] Foo money ~id:g-a ~status:active\n  path: Foo travel ~id:p-a ~status:chosen\n    effects: away-often\n- [ ] Bar family ~id:g-b ~status:active\n  path: Family dinners ~id:p-b ~status:chosen\n    needs: home-evenings\n");
    const g = await computeGraph(V, { vars: [] });
    const r = await decisionFromConflict(V, g.conflicts[0]!.key, NOW);
    expect(r.sections.Options).toContain("Accept the tension for now");
    expect(readRecord(V, "general", r.slug)!.sections["Trade-offs"]).toContain("Foo travel means away often");
  });
});

describe("recommendations, gut first", () => {
  beforeEach(seed);
  test("the Steward's answer fills options, trade-offs and the recommendation; it shows only after the gut call", async () => {
    const r = openDecision(V, { question: "Keep the foo car?", domain: "foo", due: "2026-10-15" });
    let asked = "";
    const out = await recommend(V, "foo", r.slug, { steward: async (_v, _r, brief) => { asked = brief; return { body: ANSWER, job: "j1" }; }, council: async () => { throw new Error("not big"); } });
    expect(out.by).toBe("steward");
    expect(asked).toContain("even-swap");
    const rec = readRecord(V, "foo", r.slug)!;
    expect(rec.recommendation).toBe("Keep the foo car one more year");
    expect(rec.confidence).toBe("medium");
    expect(rec.sections.Options).toContain("- Sell it and lease");
    expect(rec.sections["Trade-offs"]).toContain("gives up about $200 a month");
    expect(rec.sections.Recommendation).toContain("What would change it: A repair quote over $2,000.");
    const hidden = decisionView(rec);
    expect(hidden.recommendation).toBeUndefined();
    expect(hidden.sections.Recommendation).toBeUndefined();
    expect(hidden.recommendationReady).toBe(true);
    expect(hidden.missing).toEqual([]);
    setGut(V, "foo", r.slug, "sell it");
    expect(decisionView(readRecord(V, "foo", r.slug)!).recommendation).toBe("Keep the foo car one more year");
  });
  test("a big decision goes to the council; with no council it falls back to the Steward", async () => {
    const big = openDecision(V, { question: "Sell the foo rental for $400k?", domain: "foo", consulted: ["bar"] });
    expect(isBig(big)).toBe(true);
    expect(isBig(openDecision(V, { question: "Which foo app?", domain: "foo" }))).toBe(false);
    const viaCouncil = await recommend(V, "foo", big.slug, { council: async () => ANSWER, steward: async () => { throw new Error("should not run"); } });
    expect(viaCouncil.by).toBe("council");
    expect(readRecord(V, "foo", big.slug)!.sections.Recommendation).toContain("By the council");
    const big2 = openDecision(V, { question: "Move to the bar city next year?", domain: "foo" });
    const fallback = await recommend(V, "foo", big2.slug, { council: async () => null, steward: async () => ({ body: ANSWER }) });
    expect(fallback.by).toBe("steward");
  });
  test("parsing tolerates bold labels and prose around them", () => {
    const p = parseRecommendation(`Here is my take.\n\n**Options:**\n1. A\n2. B\n\n**Recommendation:** \nGo with B\n\n**Confidence:** high\n\n**What would change it:** a lower quote`, "council");
    expect(p).toMatchObject({ options: ["A", "B"], recommendation: "Go with B", confidence: "high", changeIt: "a lower quote" });
    expect(parseRecommendation("no labels at all", "steward")).toBeNull();
  });
  test("chat offers a decision record when the user deliberates", async () => {
    const lines: string[] = [];
    await runChatJson({ vaultPath: V, domain: "foo", message: "should I sell the foo car or keep it?", write: (l) => lines.push(l), deps: { detectClis: async () => [{ kind: "claude", bin: "/bin/false", label: "claude" }] as never, runChatTurn: (async () => "It depends on repairs.") as never, persistMessage: () => {}, dispatch: async () => ({ kind: "answer", confident: true }) } });
    const ev = lines.map((l) => JSON.parse(l)).find((e) => e.type === "decision_offer");
    expect(ev.decisionOffer).toMatchObject({ question: "Should I sell the foo car or keep it?", domain: "foo" });
    expect(listDecisions(V)).toEqual([]);
  });
});
