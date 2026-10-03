// A specialist's part in conversations and jobs: one line per event, per
// machine, read back newest first from every machine. Invented data.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { methodFor, noteInvolvement, readInvolvement } from "./involvement.ts";
import { memberPrompt } from "./members.ts";
import { getSpecialist } from "./specialists.ts";

const V = join("/tmp", `prevail-inv-${process.pid}`);
afterAll(() => rmSync(V, { recursive: true, force: true }));

describe("involvement", () => {
  test("what a step did, in one verb", () => {
    expect([methodFor("findings"), methodFor("plan"), methodFor("draft"), methodFor("verdict"), methodFor("other")]).toEqual(["researched", "planned", "drafted", "checked", "worked"]);
  });
  test("noted per machine, read from every machine newest first, per specialist", () => {
    mkdirSync(join(V, "build", "_meta", "specialists"), { recursive: true });
    noteInvolvement(V, { ts: 1000, specialist: "researcher", name: "Researcher", method: "answered", domain: "general", thread: "t-1", ask: "Find foo  grants" });
    writeFileSync(join(V, "build", "_meta", "specialists", "involvement.other-mac.jsonl"), `${JSON.stringify({ ts: 2000, specialist: "researcher", name: "Researcher", method: "researched", domain: "money", job: "j-1" })}\n`);
    noteInvolvement(V, { ts: 1500, specialist: "planner", name: "Planner", method: "planned", domain: "general" });
    expect(readInvolvement(V, "researcher").map((r) => [r.method, r.thread ?? r.job])).toEqual([["researched", "j-1"], ["answered", "t-1"]]);
    expect(readInvolvement(V, "researcher")[1]!.ask).toBe("Find foo grants");
    expect(readInvolvement(V).length).toBe(3);
  });
  test("a member's own chat carries its notebook and its recent work", () => {
    const s = getSpecialist(V, "researcher")!;
    const p = memberPrompt(s, { chief: null, members: ["Researcher"], earlier: [], explicit: true, notebook: ["Foo grants close in March"], lately: ["2026-10-01 researched: foo grants"] });
    expect(p).toContain("## Your notebook here (what you learned before)\n- Foo grants close in March");
    expect(p).toContain("## Your recent work for the user\n- 2026-10-01 researched: foo grants");
  });
});
