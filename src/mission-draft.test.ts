// Missions created by talking: the model's proposal is checked field by field
// in code. Every runner here is a stand-in; invented names only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createFromDraft, draftContext, draftMission, moneyOf, oneQuestion, parseModelJson, realYmd, validateFields, type DraftContext, type DraftTurn } from "./mission-draft.ts";

const ROOT = join("/tmp", `prevail-mission-draft-${process.pid}`);
const V = join(ROOT, "vault");
const NOW = Date.parse("2026-10-02T12:00:00Z");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "hobbies", "money", "family", "secrets"]) {
    mkdirSync(join(V, "data", "domains", d, "memory"), { recursive: true });
    writeFileSync(join(V, "data", "domains", d, "manifest.json"), JSON.stringify({ identity: { name: d } }));
  }
  mkdirSync(join(V, "data", "apps", "foo-calendar"), { recursive: true });
  mkdirSync(join(V, "data", "entities", "people", "sam-foo"), { recursive: true });
  writeFileSync(join(V, "data", "entities", "people", "sam-foo", "entity.md"), "---\nname: Sam Foo\nkind: person\naliases: [Sam]\n---\nA foo tutor.\n");
  mkdirSync(join(V, "data", "entities", "people", "bar-baz"), { recursive: true });
  writeFileSync(join(V, "data", "entities", "people", "bar-baz", "entity.md"), "---\nname: Bar Baz\nkind: person\n---\n");
  writeFileSync(join(V, "build", "chief-of-staff.md"), "---\nname: Foo\n---\n## Never pull in\n- secrets\n");
}

const CTX: DraftContext = {
  today: "2026-10-02", domains: ["hobbies", "money", "family", "secrets"], never: ["secrets"], apps: ["foo-calendar"],
  specialists: [{ id: "researcher", name: "Researcher", returns: "findings" }, { id: "coach", name: "Coach", returns: "plan" }],
  people: [{ id: "person/sam-foo", name: "Sam Foo", aliases: ["Sam"] }, { id: "person/bar-baz", name: "Bar Baz", aliases: [] }],
};
const said = "I want to learn the cello with Sam by June, about $1,500.";

describe("the checks", () => {
  test("dates must be real, after today; money is a number", () => {
    expect(realYmd("2027-06-30")).toBe("2027-06-30");
    expect(realYmd("2027-02-31")).toBeNull();
    expect(realYmd("June")).toBeNull();
    expect(moneyOf("$1,500")).toBe(1500);
    expect(moneyOf("a lot")).toBeNull();
    expect(moneyOf(-3)).toBeNull();
  });

  test("every field is checked; what fails is dropped with a reason, never guessed", () => {
    const { fields, dropped } = validateFields({
      name: "Learn the cello", outcome: "Play three pieces for the family", target: "2027-06-31", start: "2026-10-01",
      owner: "hobbies", consult: ["money", "taxes", "secrets"], inform: ["family", "money"],
      apps: ["foo-calendar", "made-up-app"], specialists: ["Researcher", "wizard"],
      people: ["person/sam-foo", "person/bar-baz", "person/nobody"],
      budgetUsd: "$1,500", hoursWk: 400,
      milestones: [{ title: "Instrument at home", due: "2026-10-05" }, { title: "Term one", due: "soon" }, { title: "" }],
      match: { calendar: ["cello lesson", "cello lesson"], merchants: [] },
    }, CTX, said);
    expect(fields).toEqual({
      name: "Learn the cello", outcome: "Play three pieces for the family", start: "2026-10-01",
      owner: "hobbies", consult: ["money"], inform: ["family"], apps: ["foo-calendar"], specialists: ["researcher"],
      people: ["person/sam-foo"], budgetUsd: 1500,
      milestones: [{ title: "Instrument at home", due: "2026-10-05" }, { title: "Term one" }],
      match: { calendar: ["cello lesson"] },
    });
    const why = Object.fromEntries(dropped.map((d) => [`${d.field}:${d.value}`, d.why]));
    expect(why["target:2027-06-31"]).toContain("not a real date");
    expect(why["consult:taxes"]).toBe("no such domain");
    expect(why["consult:secrets"]).toContain("keep out");
    expect(why["apps:made-up-app"]).toBe("not a connected app");
    expect(why["specialists:wizard"]).toContain("no such specialist");
    // Known to the vault but never named by the user: not invented into the mission.
    expect(why["people:person/bar-baz"]).toBe("you did not name them");
    expect(why["people:person/nobody"]).toBe("not someone in your people");
    expect(why["hoursWk:400"]).toContain("hours");
  });

  test("a never-read domain the user names is allowed; a target before today is not", () => {
    const { fields, dropped } = validateFields({ consult: ["secrets"], target: "2026-01-01" }, CTX, "pull in secrets for this");
    expect(fields.consult).toEqual(["secrets"]);
    expect(fields.target).toBeUndefined();
    expect(dropped[0]).toMatchObject({ field: "target", why: "before today" });
  });

  test("the model's JSON survives prose and fences; one question only", () => {
    expect(parseModelJson("Sure!\n```json\n{\"fields\":{\"name\":\"X\"}}\n```")).toEqual({ fields: { name: "X" } });
    expect(parseModelJson("no json here")).toBeNull();
    expect(oneQuestion("By when? And what budget?")).toBe("By when?");
    expect(oneQuestion(null)).toBeNull();
  });
});

describe("a turn of the conversation", () => {
  const stub = (o: unknown) => async () => JSON.stringify(o);
  const turns = (...xs: string[]): DraftTurn[] => xs.map((text, i) => ({ role: i % 2 ? "assistant" : "user", text }));

  test("fills what it can, asks one question, and is not ready without a target", async () => {
    const r = await draftMission(V, { ctx: CTX, turns: turns("I want to learn the cello with Sam"), runner: stub({
      fields: { name: "Learn the cello", outcome: "Play a piece for the family", owner: "hobbies", people: ["person/sam-foo"], specialists: ["coach"] },
      say: "A cello mission, with Sam.", question: "By when would you like to play for them? And the budget?",
    }) });
    expect(r.draft).toMatchObject({ name: "Learn the cello", owner: "hobbies", people: ["person/sam-foo"], specialists: ["coach"] });
    expect(r.filled.sort()).toEqual(["name", "outcome", "owner", "people", "specialists"]);
    expect(r).toMatchObject({ ready: false, missing: ["target"], go: false, question: "By when would you like to play for them?" });
    expect(r.reply).toBe("A cello mission, with Sam. By when would you like to play for them?");
  });

  test("keeps the draft across turns; a go only when ready and explicit", async () => {
    const draft = { name: "Learn the cello", outcome: "Play a piece for the family", owner: "hobbies" };
    const t = turns("I want to learn the cello", "By when?", "By June 30 next year, 1500 dollars");
    const r = await draftMission(V, { ctx: CTX, draft, turns: t, runner: stub({ fields: { target: "2027-06-30", budgetUsd: 1500 }, say: "June 30, $1,500.", question: null }) });
    expect(r.draft).toMatchObject({ ...draft, target: "2027-06-30", budgetUsd: 1500 });
    expect(r).toMatchObject({ ready: true, go: false, question: null });
    expect(r.reply).toContain("Say go");
    const g = await draftMission(V, { ctx: CTX, draft: r.draft, turns: [...t, { role: "assistant", text: r.reply }, { role: "user", text: "go" }], runner: stub({ fields: {}, say: "Starting it." }) });
    expect(g.go).toBe(true);
    // A bare "yes" to some other question is not a go.
    const y = await draftMission(V, { ctx: CTX, draft: r.draft, turns: [...t, { role: "assistant", text: "Should Money read along?" }, { role: "user", text: "yes" }], runner: stub({ fields: { consult: ["money"] } }) });
    expect(y).toMatchObject({ go: false, ready: true });
    expect(y.draft.consult).toEqual(["money"]);
    // Not ready: "go" does nothing.
    const n = await draftMission(V, { ctx: CTX, draft: { name: "X foo" }, turns: turns("go"), runner: stub({ fields: {} }) });
    expect(n).toMatchObject({ go: false, ready: false, question: "What does done look like, in a sentence?" });
  });

  test("a model that fails or rambles leaves the draft as it was and asks again", async () => {
    const draft = { name: "Learn the cello" };
    const r = await draftMission(V, { ctx: CTX, draft, turns: turns("hmm"), runner: async () => { throw new Error("timeout"); } });
    expect(r.draft).toEqual(draft);
    expect(r.reply).toContain("could not read that");
    const p = await draftMission(V, { ctx: CTX, draft, turns: turns("hmm"), runner: stub("not an object") });
    expect(p.draft).toEqual(draft);
  });
});

describe("the vault side", () => {
  beforeEach(seed);
  test("the context lists real domains, apps, specialists and people", () => {
    const c = draftContext(V, NOW);
    expect(c.today).toBe("2026-10-02");
    expect(c.domains.sort()).toEqual(["family", "hobbies", "money", "secrets"]);
    expect(c.never).toEqual(["secrets"]);
    expect(c.apps).toEqual(["foo-calendar"]);
    expect(c.specialists.some((s) => s.id === "researcher")).toBe(true);
    expect(c.people.map((p) => p.id).sort()).toEqual(["person/bar-baz", "person/sam-foo"]);
  });

  test("go creates one mission from the draft, checked again, with its match rules", async () => {
    const r = await createFromDraft(V, {
      name: "Learn the cello", outcome: "Play a piece for the family", target: "2027-06-30", owner: "hobbies", consult: ["money", "nope"],
      people: ["person/sam-foo", "person/ghost"], specialists: ["coach"], budgetUsd: 1500,
      milestones: [{ title: "Instrument at home", due: "2026-10-05" }], match: { calendar: ["cello lesson"] },
    }, NOW);
    expect(r.mission).toMatchObject({ id: "mission/learn-the-cello", target: "2027-06-30", people: ["person/sam-foo"], specialists: ["coach"] });
    expect(r.mission.domains).toEqual([{ slug: "hobbies", role: "owner" }, { slug: "money", role: "consulted" }]);
    expect(r.dropped.map((d) => d.value).sort()).toEqual(["nope", "person/ghost"]);
    const md = readFileSync(join(V, "data", "missions", "learn-the-cello", "mission.md"), "utf8");
    expect(md).toContain("cello lesson");
    expect(readFileSync(join(V, "data", "missions", "learn-the-cello", "milestones.md"), "utf8")).toContain("~due:2026-10-05");
    await expect(createFromDraft(V, { outcome: "no name" }, NOW)).rejects.toThrow("needs a name");
    expect(existsSync(join(V, "data", "missions", "no-name"))).toBe(false);
  });
});
