import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chiefOfStaffBlock, cleanName, parseChiefOfStaff, readChiefOfStaff, setChiefOfStaffName } from "./chief-of-staff.ts";
import { buildUserContext } from "./cli-bridge.ts";
import { expandOutput, jobsDir, listPlaybooks, loadPlaybook } from "./orchestrator.ts";

const ROOT = join("/tmp", `prevail-cos-${process.pid}`);
const V = join(ROOT, "vault");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  mkdirSync(join(V, "data", "domains", "general"), { recursive: true });
  mkdirSync(join(V, "data", "domains", "wealth"), { recursive: true });
}

describe("chief of staff", () => {
  test("names are short labels", () => {
    expect(cleanName("  Foo  Bar ")).toBe("Foo Bar");
    expect(cleanName("")).toBeNull();
    expect(cleanName("x".repeat(41))).toBeNull();
    expect(cleanName("<script>")).toBeNull();
  });

  test("an unnamed vault has defaults and no persona block", () => {
    seed();
    const c = readChiefOfStaff(V);
    expect(c).toMatchObject({ name: null, exists: false, limits: { usd: 1, minutes: 10 } });
    expect(chiefOfStaffBlock(V)).toBe("");
  });

  test("set-name writes the file, keeps unknown lines and versions the prior text", () => {
    seed();
    setChiefOfStaffName(V, "Foo");
    const p = join(V, "build", "chief-of-staff.md");
    writeFileSync(p, readFileSync(p, "utf8").replace("## Never pull in\n", "## Never pull in\n- Dreams\n").replace("## What I've learned", "A note the user wrote.\n\n## What I've learned\n- Rentals: insurance owns coverage"));
    const c = setChiefOfStaffName(V, "Bar");
    expect(c.name).toBe("Bar");
    expect(c.neverRead).toEqual(["dreams"]);
    expect(c.learned).toEqual(["Rentals: insurance owns coverage"]);
    expect(readFileSync(p, "utf8")).toContain("A note the user wrote.");
    expect(readdirSync(join(V, "build", "chief-of-staff.versions")).length).toBe(1);
    expect(() => setChiefOfStaffName(V, "")).toThrow();
  });

  test("limits parse from the file", () => {
    expect(parseChiefOfStaff("---\nname: Foo\n---\n## Limits\n- usd: 2.5\n- minutes: 20\n").limits).toEqual({ usd: 2.5, minutes: 20 });
  });

  test("a General turn carries the persona; another domain does not", () => {
    seed();
    setChiefOfStaffName(V, "Foo");
    const g = buildUserContext(V, join(V, "data", "domains", "general"), "hello");
    expect(g).toContain("you are Foo, the user's chief of staff");
    expect(buildUserContext(V, join(V, "data", "domains", "wealth"), "hello")).not.toContain("chief of staff");
    // Never doubled when the prompt already has it.
    expect(buildUserContext(V, join(V, "data", "domains", "general"), "# YOUR CHIEF OF STAFF: x")).not.toContain("you are Foo");
  });
});

describe("playbooks live under build/", () => {
  test("user playbooks load from build/playbooks, then the older _playbooks", () => {
    seed();
    mkdirSync(join(V, "build", "playbooks"), { recursive: true });
    writeFileSync(join(V, "build", "playbooks", "foo-brief.json"), JSON.stringify({ id: "foo-brief", name: "Foo brief", goal: "a brief", steps: [] }));
    expect(loadPlaybook(V, "foo-brief")?.name).toBe("Foo brief");
    expect(listPlaybooks(V).some((p) => p.id === "foo-brief")).toBe(true);
    expect(loadPlaybook(V, "../../etc/passwd")).toBeNull();
  });

  test("runs are kept under build/_meta/jobs, and outputs may carry the date", () => {
    expect(jobsDir(V, "r1")).toBe(join(V, "build", "_meta", "jobs", "r1"));
    expect(expandOutput("memory/briefs/intel-{date}.md", new Date(2026, 9, 2))).toBe("memory/briefs/intel-2026-10-02.md");
    expect(existsSync(join(V, "_runs"))).toBe(false);
  });
});
