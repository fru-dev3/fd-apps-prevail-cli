// Goals G5: fresh starts offered once inside the budget, the yearly review
// with odyssey sketches kept only when quoted, value and role history across
// versions, the Compass exported as a constitution (never proposed or local
// lines), and a household whose members' data is read only with their own
// yes. Invented people and data only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compassHistory, constitutionText, exportConstitution, freshStartPass, freshStarts, yearlyReview } from "./lifetime.ts";
import { addMember, addShared, householdView, memberCompass, peopleConflicts, removeMember, setConsent, setMemberCompass } from "./household.ts";
import { confirm, readCompass, saveCompass, items } from "./compass.ts";
import { noteSaid, topCandidates, answerCandidate } from "./said.ts";
import { installPack } from "./packs.ts";

const ROOT = join("/tmp", `prevail-g5-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const C = (body: string) => writeFileSync(join(V, "build", "compass.md"), body);
const T = (s: string) => Date.parse(`${s}T10:00:00Z`);

const COMPASS = `# Compass
~schema:2

## Purpose
Live a calm foo life.

## Values
- Peace of mind ~id:v-peace ~rank:1
  words: "Calm first."
- Freedom ~id:v-freedom ~rank:2
- Faith ~id:v-faith ~rank:3 ~local
- Craft ~id:v-craft ~status:proposed

## Roles
- Parent ~id:r-parent
- Builder ~id:r-builder

## Non-negotiables
- Never move abroad ~id:nn-abroad

## Capacity
- 6 hours a week for shared plans ~id:c-hours ~hours:6
`;

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general"]) { mkdirSync(join(V, "data", "domains", d, "memory"), { recursive: true }); writeFileSync(join(V, "data", "domains", d, "manifest.json"), "{}"); }
  C(COMPASS);
}

describe("fresh starts", () => {
  beforeEach(seed);
  test("new year, the birthday week, a new quarter and a move said in chat; each offered once, inside the budget", async () => {
    expect(freshStarts(V, T("2027-01-03")).map((f) => f.kind)).toEqual(["new-year"]);
    writeFileSync(join(V, "build", "user.md"), "---\nname: Foo\nbirthday: 05-20\n---\n");
    expect(freshStarts(V, T("2027-05-22")).map((f) => f.kind)).toEqual(["birthday"]);
    expect(freshStarts(V, T("2027-05-28")).map((f) => f.kind)).toEqual([]);
    expect(freshStarts(V, T("2027-04-02")).map((f) => f.kind)).toEqual(["new-quarter"]);
    noteSaid(V, { text: "Big week: I just moved to a new flat across town.", now: T("2027-03-10") });
    expect(freshStarts(V, T("2027-03-12")).map((f) => f.kind)).toEqual(["move"]);
    expect(freshStarts(V, T("2027-04-20")).map((f) => f.kind)).toEqual([]);
    const a = await freshStartPass(V, T("2027-01-03"));
    expect(a.offered).toEqual(["fresh:new-year:2027"]);
    expect((await freshStartPass(V, T("2027-01-04"))).offered).toEqual([]);
  });
});

describe("history, the yearly review and the export", () => {
  beforeEach(seed);
  test("values and roles over time: added, rank changes, dropped, with the ledger's reasons", () => {
    // Freedom moves to first, Builder is dropped: two saves, two versions.
    const d = readCompass(V);
    items(d, "value").find((x) => x.id === "v-freedom")!.tokens.rank = "1";
    items(d, "value").find((x) => x.id === "v-peace")!.tokens.rank = "2";
    for (const x of items(d)) if (x.tokens.rank) x.dirty = true;
    saveCompass(V, d, [{ id: "v-freedom", from: "rank 2", to: "rank 1", reason: "the yearly review", by: "user" }], T("2026-03-01"));
    C(readFileSync(join(V, "build", "compass.md"), "utf8").replace(/- Builder ~id:r-builder\n/, ""));
    saveCompass(V, readCompass(V), [{ id: "r-builder", from: "confirmed", to: "dropped", reason: "no longer me", by: "user" }], T("2026-09-01"));
    const h = compassHistory(V);
    const freedom = h.find((x) => x.id === "v-freedom")!;
    expect(freedom.events.some((e) => e.what === "rank" && e.from === "2" && e.to === "1")).toBe(true);
    expect(freedom.rank).toBe(1);
    expect(h.find((x) => x.id === "r-builder")).toMatchObject({ now: false });
    expect(h.find((x) => x.id === "v-craft")).toBeUndefined(); // proposed lines are not history
  });

  test("the yearly review keeps an odyssey sketch only when its quote is in the user's notes, and never overwrites the page", async () => {
    writeFileSync(join(V, "build", "ideal-state.md"), "# Constitution\nI want to build calm tools and spend summers by the foo lake.\n");
    const run = async () => JSON.stringify({ sketches: [
      { key: "current", sketch: "Keep building calm tools, a little slower.", quote: "build calm tools" },
      { key: "free", sketch: "Summers at the lake, writing.", quote: "spend summers by the foo lake" },
      { key: "vanished", sketch: "Become a pilot.", quote: "I always wanted to fly" },
    ] });
    const r = await yearlyReview(V, { year: 2026, run, write: true });
    expect(r.sketches.map((s) => s.key).sort()).toEqual(["current", "free"]);
    expect(r.text).toContain("### Life two: if that path vanished");
    expect(r.text).not.toContain("pilot");
    expect(r.text).toContain("Peace of mind (rank 1)");
    writeFileSync(r.file, `${readFileSync(r.file, "utf8")}\nMy answer: more lake.\n`);
    await yearlyReview(V, { year: 2026, write: true });
    expect(readFileSync(r.file, "utf8")).toContain("My answer: more lake.");
  });

  test("the constitution export has confirmed lines only, never local or proposed ones", () => {
    const t = constitutionText(V, T("2026-10-02"));
    expect(t).toContain("1. Peace of mind: \"Calm first.\"");
    expect(t).toContain("- Never move abroad");
    expect(t).not.toContain("Faith");
    expect(t).not.toContain("Craft");
    expect(t).not.toMatch(/—/);
    const e = exportConstitution(V, T("2026-10-02"));
    expect(e.file.endsWith("build/exports/compass-constitution-2026-10-02.md")).toBe(true);
  });

  test("a pack's Compass lines are suggestions: shown after the user's own, and a yes says where it came from", async () => {
    noteSaid(V, { text: "What matters to me is quiet mornings." });
    await installPack(V, "investors", { only: "compass" });
    const top = topCandidates(V, 10);
    expect(top[0]!.title).toBe("Quiet mornings");
    const fi = top.find((x) => x.title === "Financial independence")!;
    expect(fi.pack).toBe("investors");
    answerCandidate(V, fi.key, "yes");
    expect(readFileSync(join(V, "build", "compass.md"), "utf8")).toContain("from: the investors pack, chosen by you");
  });
});

describe("a household, with consent per person", () => {
  beforeEach(seed);
  test("nothing of a member is read without their own yes; only they can give it", () => {
    addMember(V, { name: "Ada Foo", relation: "partner" });
    expect(() => setConsent(V, "ada-foo", "compass", true)).toThrow(/only Ada Foo can say yes/);
    expect(() => setMemberCompass(V, "ada-foo", "# Compass\n")).toThrow(/their yes/);
    expect(memberCompass(V, "ada-foo")).toBeNull();
    setConsent(V, "ada-foo", "compass", true, { confirm: "ada foo" });
    setMemberCompass(V, "ada-foo", "# Compass\n\n## Non-negotiables\n- Never work on Sunday mornings ~id:nn-sunday\n\n## Capacity\n- 3 hours a week ~id:c-h ~hours:3\n");
    expect(memberCompass(V, "ada-foo")).not.toBeNull();
    expect(readFileSync(join(V, "build", "_meta", "household", "consent.jsonl"), "utf8")).toContain('"by":"member"');
  });

  test("conflicts between people come with evidence, and vanish when consent is taken back", () => {
    addMember(V, { name: "Ada Foo" });
    setConsent(V, "ada-foo", "compass", true, { confirm: "Ada Foo" });
    setMemberCompass(V, "ada-foo", "# Compass\n\n## Non-negotiables\n- Never work on Sunday mornings ~id:nn-sunday\n\n## Capacity\n- 3 hours a week ~id:c-h ~hours:3\n");
    addShared(V, { title: "Move abroad for a year", members: ["ada-foo"], hours: 2 });
    addShared(V, { title: "Sunday morning foo market stall", members: ["ada-foo"], hours: 4 });
    const c = peopleConflicts(V);
    expect(c.find((x) => x.who === "You" && x.kind === "rule")!.evidence).toContain("rule: Never move abroad");
    expect(c.some((x) => x.who === "Ada Foo" && x.kind === "rule" && x.goal.startsWith("Sunday morning"))).toBe(true);
    expect(c.find((x) => x.who === "Ada Foo" && x.kind === "capacity")!.question).toContain("6 hours a week of Ada Foo");
    setConsent(V, "ada-foo", "compass", false);
    expect(peopleConflicts(V).some((x) => x.who === "Ada Foo")).toBe(false);
    expect(householdView(V).shared[0]!.names).toEqual(["You", "Ada Foo"]);
  });

  test("removing a member moves their folder aside and turns every scope off", () => {
    addMember(V, { name: "Bo Bar" });
    setConsent(V, "bo-bar", "compass", true, { confirm: "Bo Bar" });
    setMemberCompass(V, "bo-bar", "# Compass\n");
    const r = removeMember(V, "bo-bar", T("2026-10-02"));
    expect(r.moved).toContain("_archive/bo-bar-2026-10-02");
    expect(existsSync(join(r.moved!, "compass.md"))).toBe(true);
    expect(householdView(V).members).toEqual([]);
    expect(() => addShared(V, { title: "Foo", members: ["bo-bar"] })).toThrow(/not in the household/);
  });
});
