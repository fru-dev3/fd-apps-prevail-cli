import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyDraft, bootstrapCompass, goalsNeedingWoop, setWoop, compassBlock, compassJson, confirm, drop, fallbackDraft, items, parseCompass,
  quoteSource, readCompass, readLedger, serializeCompass, titleFromUserWords, type Source,
} from "./compass.ts";
import { buildUserContext } from "./cli-bridge.ts";
import { tReadCompass } from "./mcp-server.ts";

const ROOT = join("/tmp", `prevail-compass-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const SAMPLE = `# Compass

Some intro the user wrote.

## Mission
Live a calm foo life.

## Values
- Peace of mind ~id:v-peace ~rank:2 ~tier:1
  words: "Grow foo while preserving peace of mind."
  enough: calm 4 of 5 most weeks
  signal: checkin.calm . cash_months
- Freedom ~id:v-freedom ~rank:1
  words: "So work becomes a choice."
- Faith ~id:v-faith ~rank:3 ~local

## Roles
- Parent ~id:r-parent ~people:person/sam-rivera ~weight:high
  hope: "Present at dinner."

## Goals
- [ ] Bar independence ~id:g-fi ~serves:v-freedom,v-peace ~status:active ~due:2028-12-31 ~domain:wealth
  why: "Work as a choice."
  path: Foo equity ~id:p-equity ~status:chosen ~until:2027-06-30
    expect: offer by 2027-03
    stop: calm under 3 of 5 for 6 weeks
  path: Weekly bar channel ~id:p-weekly ~status:rejected
    because: breaks v-peace
- [ ] Hike the foo trail ~id:g-hike ~status:proposed

## Non-negotiables
- Home for dinner 5 nights a week ~id:nn-dinner ~check:dinners_home_wk>=5
  words: "Home for dinner."

## Negotiables
- Stay near the bay ~id:ng-bay
  trade: "Would move for the right role."

## Capacity
- hours_for_goals_wk: 10

## Something new
A line the app does not know.
`;

function seed(body = SAMPLE) {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  mkdirSync(join(V, "data", "domains", "general", "memory"), { recursive: true });
  mkdirSync(join(V, "data", "domains", "wealth"), { recursive: true });
  if (body) writeFileSync(join(V, "build", "compass.md"), body);
}

describe("grammar", () => {
  test("round trip is byte for byte, unknown lines and sections included", () => {
    expect(serializeCompass(parseCompass(SAMPLE))).toBe(SAMPLE);
  });

  test("items, tokens, fields and paths parse", () => {
    const doc = parseCompass(SAMPLE);
    const values = items(doc, "value");
    expect(values.map((v) => v.id)).toEqual(["v-peace", "v-freedom", "v-faith"]);
    expect(values[0]).toMatchObject({ title: "Peace of mind", tokens: { rank: "2", tier: "1" } });
    expect(values[0]!.fields.find((f) => f.key === "enough")?.value).toBe("calm 4 of 5 most weeks");
    expect(values[2]!.flags).toEqual(["local"]);
    const fi = items(doc, "goal")[0]!;
    expect(fi).toMatchObject({ id: "g-fi", done: false, tokens: { serves: "v-freedom,v-peace", status: "active", due: "2028-12-31", domain: "wealth" } });
    expect(fi.paths.map((p) => [p.id, p.tokens.status, p.fields.length])).toEqual([["p-equity", "chosen", 2], ["p-weekly", "rejected", 1]]);
    expect(fi.fields).toEqual([{ key: "why", value: "\"Work as a choice.\"" }]);
    expect(items(doc, "rule")[0]!.tokens.check).toBe("dinners_home_wk>=5");
  });

  test("a changed item is re-rendered; the rest stays as written", () => {
    const doc = parseCompass(SAMPLE);
    const hike = items(doc, "goal")[1]!;
    hike.tokens.status = "active";
    hike.dirty = true;
    const out = serializeCompass(doc);
    expect(out).toContain("- [ ] Hike the foo trail ~id:g-hike ~status:active\n");
    expect(out.replace("~status:active\n\n## Non", "~status:proposed\n\n## Non")).toBe(SAMPLE);
  });
});

describe("WOOP before a goal goes active", () => {
  test("outcome, obstacle and an if-then plan make a confirmed goal active; a low expectation makes it a small trial", () => {
    seed();
    confirm(V, ["g-hike"], "yes", 1000);
    expect(goalsNeedingWoop(V).map((g) => g.id)).toEqual(["g-hike"]);
    expect(setWoop(V, "g-hike", { outcome: "We stand on the foo summit together" }, 2000)).toMatchObject({ status: "confirmed", complete: false });
    expect(() => setWoop(V, "g-hike", { expect: 9 })).toThrow(/1 to 5/);
    expect(setWoop(V, "g-hike", { obstacle: "I book work on weekends", plan: "If a Saturday is free, then I block it for a training hike" }, 3000)).toMatchObject({ status: "active", complete: true });
    const g = items(readCompass(V), "goal").find((x) => x.id === "g-hike")!;
    expect(g.fields.map((f) => f.key)).toEqual(["outcome", "obstacle", "plan"]);
    expect(readLedger(V).at(-1)).toMatchObject({ id: "g-hike", from: "confirmed", to: "active", reason: "WOOP done" });
    expect(compassBlock(V)).toContain("Hike the foo trail");
    expect(setWoop(V, "g-hike", { expect: 2 }, 4000).status).toBe("prototyping");
    expect(goalsNeedingWoop(V)).toEqual([]);
  });
  test("a goal confirmed without its WOOP is named in the chat block as not started", () => {
    seed();
    confirm(V, ["g-hike"], "yes", 1000);
    expect(compassBlock(V)).toContain("not started (no plan yet, or a small trial): Hike the foo trail");
  });
});

describe("archived lines", () => {
  test("an archived role is out of the chat block and the chain", async () => {
    mkdirSync(join(V, "build"), { recursive: true });
    writeFileSync(join(V, "build", "compass.md"), "# Compass\n~schema:2\n\n## Roles\n- Coach ~id:r-coach ~status:archived\n- Parent ~id:r-parent\n");
    expect(compassBlock(V)).toContain("Roles: Parent");
    expect(compassBlock(V)).not.toContain("Coach");
    const { compassTree } = await import("./compass-chain.ts");
    expect(compassTree(V).nodes.some((n) => n.id === "r-coach")).toBe(false);
  });
});

describe("confirm, drop, versions and the ledger", () => {
  test("confirming a proposed goal makes it the user's (active after its WOOP); dropping removes it but keeps a version and the ledger", () => {
    seed();
    expect(confirm(V, ["g-hike"], "yes", 1000)).toEqual(["g-hike"]);
    expect(readFileSync(join(V, "build", "compass.md"), "utf8")).toContain("Hike the foo trail ~id:g-hike ~status:confirmed");
    expect(readdirSync(join(V, "build", "compass.versions")).length).toBe(1);
    expect(readLedger(V)).toEqual([{ ts: 1000, id: "g-hike", from: "proposed", to: "confirmed", reason: "yes", by: "user" }]);
    // Confirming again changes nothing.
    expect(confirm(V, "all")).toEqual([]);

    seed(SAMPLE.replace("~id:v-faith ~rank:3 ~local", "~id:v-faith ~rank:3 ~status:proposed\n  words: \"Faith matters.\""));
    expect(drop(V, ["v-faith", "v-peace"], "not mine", 2000)).toEqual(["v-faith"]); // a confirmed line is never dropped
    const after = readFileSync(join(V, "build", "compass.md"), "utf8");
    expect(after).not.toContain("Faith");
    expect(after).toContain("Peace of mind");
    expect(readLedger(V).at(-1)).toMatchObject({ id: "v-faith", to: "dropped", evidence: ["Faith", "\"Faith matters.\""] });
    expect(readFileSync(join(V, "build", "compass.versions", readdirSync(join(V, "build", "compass.versions"))[0]!), "utf8")).toContain("Faith");
  });
});

describe("in every chat turn", () => {
  test("only confirmed lines, values ranked, local lines kept off cloud turns", () => {
    seed();
    const b = compassBlock(V);
    expect(b.startsWith("# COMPASS")).toBe(true);
    expect(b).toContain("Purpose: Live a calm foo life.");
    expect(b.indexOf("1. Freedom")).toBeLessThan(b.indexOf("2. Peace of mind (enough: calm 4 of 5 most weeks)"));
    expect(b).not.toContain("Faith");
    expect(compassBlock(V, { local: true })).toContain("Faith");
    expect(b).toContain("- Home for dinner 5 nights a week");
    expect(b).toContain("- Bar independence (serves Freedom, Peace of mind) by 2028-12-31");
    expect(b).not.toContain("Hike the foo trail"); // proposed
    expect(b).toContain("Roles: Parent");
  });

  test("a vault with no Compass adds nothing; a chat turn carries it once", () => {
    seed("");
    expect(compassBlock(V)).toBe("");
    seed();
    const ctx = buildUserContext(V, join(V, "data", "domains", "wealth"), "hi");
    expect(ctx).toContain("# COMPASS");
    expect(buildUserContext(V, join(V, "data", "domains", "wealth"), "# COMPASS: already here")).not.toContain("Live a calm foo life");
  });

  test("MCP read_compass: the confirmed Compass, or what waits for confirmation", async () => {
    seed();
    expect(await tReadCompass({}, V)).toContain("Purpose: Live a calm foo life.");
    expect(JSON.parse(await tReadCompass({ format: "json" }, V)).goals.map((g: { id: string; status: string }) => `${g.id}:${g.status}`)).toEqual(["g-fi:active", "g-hike:proposed"]);
    seed("# Compass\n\n## Values\n- Foo ~id:v-foo ~status:proposed\n");
    expect(await tReadCompass({}, V)).toBe("No confirmed Compass yet: 1 drafted lines are waiting for the user to confirm them.");
  });
});

describe("bootstrap: every line quoted from the user's notes", () => {
  const sources: Source[] = [
    { path: "build/ideal-state.md", text: "# Foo constitution\n\n> **Live a calm foo life.**\n\n## Core principles\n- Grow foo while preserving peace of mind.\n- Protect time and attention.\n" },
    { path: "data/domains/general/memory/memory.md", text: "- Non-negotiables: family, health, constant learning.\n- Wants to be a present father.\n" },
  ];

  test("quotes must be verbatim; titles may only use the user's words", () => {
    expect(quoteSource("grow FOO while preserving **peace of mind**", sources)?.path).toBe("build/ideal-state.md");
    expect(quoteSource("Grow bar fast", sources)).toBeNull();
    expect(titleFromUserWords("Peace of mind", sources)).toBe(true);
    expect(titleFromUserWords("Present father", sources)).toBe(true);
    expect(titleFromUserWords("Serenity", sources)).toBe(false);
  });

  test("a model draft lands as proposed lines; invented lines are rejected", () => {
    seed("");
    const r = applyDraft(V, {
      mission: { text: "Live a calm foo life.", quote: "Live a calm foo life." },
      values: [
        { title: "Peace of mind", quote: "Grow foo while preserving peace of mind." },
        { title: "Serenity", quote: "Grow foo while preserving peace of mind." },
        { title: "Wealth", quote: "Become very rich" },
      ],
      roles: [{ title: "Father", quote: "Wants to be a present father." }],
      rules: [{ title: "Family and health", quote: "Non-negotiables: family, health, constant learning." }],
    }, sources, "model", 5000);
    expect(r.added.map((a) => `${a.kind}:${a.title}`)).toEqual(["mission:Live a calm foo life.", "value:Peace of mind", "role:Father", "rule:Family and health"]);
    expect(r.rejected.map((x) => x.why)).toEqual(["title uses words the user never wrote", "quote not found in the user's notes"]);
    const body = readFileSync(join(V, "build", "compass.md"), "utf8");
    expect(body).toContain("- Peace of mind ~id:");
    expect(body).toMatch(/## Goals\n\n## Roles\n\n- Father/);
    expect(body).toContain("~rank:1 ~status:proposed\n  words: \"Grow foo while preserving peace of mind.\"\n  from: build/ideal-state.md");
    // Nothing is in a chat turn until confirmed.
    expect(compassBlock(V)).toBe("");
    expect(readFileSync(join(V, "build", "_meta", "compass", "proposals.jsonl"), "utf8").trim().split("\n").length).toBe(4);
    expect(confirm(V, "all").length).toBe(4);
    expect(compassBlock(V)).toContain("1. Peace of mind");
    expect(compassJson(V).proposed).toBe(0);
    // A second draft does not double a line.
    expect(applyDraft(V, { values: [{ title: "Peace of mind", quote: "Grow foo while preserving peace of mind." }] }, sources, "model").added).toEqual([]);
    expect(serializeCompass(readCompass(V))).toBe(readFileSync(join(V, "build", "compass.md"), "utf8"));
  });

  test("without a model: the motto and the core principles, still proposed", async () => {
    expect(fallbackDraft(sources)).toEqual({
      mission: { text: "Live a calm foo life.", quote: "Live a calm foo life." },
      values: [{ title: "Grow foo while preserving peace of mind", quote: "Grow foo while preserving peace of mind." }, { title: "Protect time and attention", quote: "Protect time and attention." }],
    });
    seed("");
    writeFileSync(join(V, "build", "ideal-state.md"), sources[0]!.text);
    const r = await bootstrapCompass(V, async () => "not json at all");
    expect(r.method).toBe("fallback");
    expect(r.added.length).toBe(3);
    expect(existsSync(join(V, "build", "compass.md"))).toBe(true);
  });
});
