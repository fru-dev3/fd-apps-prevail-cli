import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanLegacyGoal, goalsBlock, listVersions, migrateLegacyGoals, migrateProfile, readDomainGoals,
  readProfile, writeVersioned, appendGoals, domainOfCwd,
} from "./goals.ts";
import { buildUserContext } from "./cli-bridge.ts";
import { appendStandingRule } from "./mirror.ts";

const ROOT = join("/tmp", `prevail-goals-${process.pid}`);
const V = join(ROOT, "vault");
const dom = (d: string) => join(V, "data", "domains", d);

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["wealth", "crm", "general", "health"]) mkdirSync(join(dom(d), "memory"), { recursive: true });
  writeFileSync(join(dom("wealth"), "memory", "goals.md"), [
    "# Wealth — Goals", "", "_Set from the setup interview._", "",
    "1. Reach **$2M net worth by 2030** — en route to more",
    "2. Confirm the real foo number",
    "",
  ].join("\n"));
  writeFileSync(join(dom("wealth"), "manifest.json"), JSON.stringify({ identity: { name: "wealth" }, goals: ["Reach two million", "Confirm foo"] }, null, 2));
  writeFileSync(join(dom("crm"), "manifest.json"), JSON.stringify({ identity: { name: "crm" }, goals: ["Call Sam Rivera monthly"] }, null, 2));
  writeFileSync(join(dom("general"), "memory", "goals.md"), "1. Live a calm foo life\n");
  mkdirSync(join(dom("health"), "source"), { recursive: true });
  writeFileSync(join(dom("health"), "source", "goals.md"), "# Health\n\n- [ ] Run a foo race ~id:g-run ~status:active ~due:2026-12-31\n  why: Feel strong.\n- [x] Old bar ~id:g-old ~status:done\n");
}

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("one goal store", () => {
  test("legacy list items lose numbering, bold and em dashes, keep the words", () => {
    expect(cleanLegacyGoal("1. Reach **$2M net worth by 2030** — en route")).toBe("Reach $2M net worth by 2030, en route");
    expect(cleanLegacyGoal("# Heading")).toBe("");
    expect(cleanLegacyGoal("_note_")).toBe("");
  });

  test("groom moves memory/goals.md into source/goals.md and keeps dated backups", () => {
    seed();
    const r = migrateLegacyGoals(V, "wealth", Date.parse("2026-10-02T12:00:00Z"));
    expect(r.added).toBe(2);
    expect(r.from).toEqual(["memory/goals.md"]);
    const goals = readDomainGoals(V, "wealth");
    expect(goals.map((g) => g.title)).toEqual(["Reach $2M net worth by 2030, en route to more", "Confirm the real foo number"]);
    expect(goals.every((g) => g.status === "active" && /^g-[0-9a-f]{6}$/.test(g.id))).toBe(true);
    // The manifest summary of the same list is not copied a second time.
    expect(goals.some((g) => g.title === "Reach two million")).toBe(false);
    expect(existsSync(join(dom("wealth"), "memory", "goals.md"))).toBe(false);
    expect(readFileSync(join(dom("wealth"), "memory", "goals.md.pre-compass-2026-10-02"), "utf8")).toContain("Reach **$2M");
    const man = JSON.parse(readFileSync(join(dom("wealth"), "manifest.json"), "utf8"));
    expect(man.goals).toEqual([]);
    expect(man.identity.name).toBe("wealth");
    expect(JSON.parse(readFileSync(join(dom("wealth"), "manifest.json.pre-compass-2026-10-02"), "utf8")).goals).toHaveLength(2);
    // Idempotent: a second groom changes nothing.
    const again = migrateLegacyGoals(V, "wealth");
    expect(again.added + again.backups.length).toBe(0);
    expect(readDomainGoals(V, "wealth")).toHaveLength(2);
  });

  test("a domain with only manifest goals gets those", () => {
    seed();
    const r = migrateLegacyGoals(V, "crm");
    expect(r.from).toEqual(["manifest"]);
    expect(readDomainGoals(V, "crm").map((g) => g.title)).toEqual(["Call Sam Rivera monthly"]);
  });

  test("existing source/goals.md lines are kept and never duplicated", () => {
    seed();
    expect(appendGoals(V, "health", ["Run a foo race", "Sleep eight hours"])).toBe(1);
    const body = readFileSync(join(dom("health"), "source", "goals.md"), "utf8");
    expect(body).toContain("why: Feel strong.");
    expect(body.match(/Run a foo race/g)).toHaveLength(1);
  });

  test("goals block: this domain's active goals, then the life goals", () => {
    seed();
    migrateLegacyGoals(V, "general");
    const b = goalsBlock(V, "health");
    expect(b).toContain("# GOALS");
    expect(b).toContain("## health goals");
    expect(b).toContain("- Run a foo race (by 2026-12-31)");
    expect(b).toContain("why: Feel strong.");
    expect(b).not.toContain("Old bar");
    expect(b.indexOf("## Life goals")).toBeGreaterThan(b.indexOf("## health goals"));
    expect(b).toContain("Live a calm foo life");
    expect(goalsBlock(V, "general")).not.toContain("## general goals");
    expect(domainOfCwd(dom("health"), V)).toBe("health");
    expect(domainOfCwd(V, V)).toBe("general");
  });

  test("every engine chat turn gets the profile and the goals, never twice", () => {
    seed();
    writeFileSync(join(V, "build", "user.md"), "Name: Sam Rivera\n");
    const ctx = buildUserContext(V, dom("health"), "hello");
    expect(ctx).toContain("# WHO YOU'RE HELPING");
    expect(ctx).toContain("Sam Rivera");
    expect(ctx).toContain("Run a foo race");
    const desktop = buildUserContext(V, dom("health"), "# WHO YOU'RE HELPING - x\n# GOALS: y\nhello");
    expect(desktop).toBe("");
  });
});

describe("versioned constitution writes", () => {
  test("a changed write keeps the prior text as a dated version", () => {
    seed();
    const p = join(V, "build", "ideal-state.md");
    expect(writeVersioned(p, "# One\n", 1)).toBeNull();
    expect(writeVersioned(p, "# One\n", 2)).toBeNull(); // unchanged: no version
    const kept = writeVersioned(p, "# Two\n", Date.parse("2026-10-02T10:00:00Z"));
    expect(kept).toBe(join(V, "build", "ideal-state.versions", "2026-10-02T10-00-00Z.md"));
    expect(readFileSync(kept!, "utf8")).toBe("# One\n");
    writeVersioned(p, "# Three\n", Date.parse("2026-10-02T10:00:00Z"));
    expect(listVersions(p)).toHaveLength(2);
  });

  test("a standing rule added by the CLI is versioned too", () => {
    seed();
    writeFileSync(join(V, "build", "ideal-state.md"), "# Ideal\n\nBe calm.\n");
    appendStandingRule(V, "Never schedule foo on Sundays");
    const text = readFileSync(join(V, "build", "ideal-state.md"), "utf8");
    expect(text).toContain("## Standing rules");
    const vs = readdirSync(join(V, "build", "ideal-state.versions"));
    expect(vs).toHaveLength(1);
    expect(readFileSync(join(V, "build", "ideal-state.versions", vs[0]!), "utf8")).toBe("# Ideal\n\nBe calm.\n");
  });
});

describe("one profile file", () => {
  test("_profile.md becomes user.md, kept as a dated backup", () => {
    seed();
    writeFileSync(join(V, "build", "_profile.md"), "Prefers foo.\n");
    const r = migrateProfile(V, Date.parse("2026-10-02T00:00:00Z"));
    expect(r.merged).toBe(true);
    expect(readFileSync(join(V, "build", "user.md"), "utf8")).toBe("Prefers foo.\n");
    expect(existsSync(join(V, "build", "_profile.md"))).toBe(false);
    expect(existsSync(join(V, "build", "_profile.md.pre-user-2026-10-02"))).toBe(true);
    expect(migrateProfile(V).merged).toBe(false);
  });

  test("when both exist and differ, the old text is appended, never lost", () => {
    seed();
    writeFileSync(join(V, "build", "user.md"), "Name: Sam\n");
    writeFileSync(join(V, "build", "_profile.md"), "Prefers bar.\n");
    migrateProfile(V, Date.parse("2026-10-02T00:00:00Z"));
    const t = readProfile(V);
    expect(t).toContain("Name: Sam");
    expect(t).toContain("## Merged from _profile.md (2026-10-02)");
    expect(t).toContain("Prefers bar.");
  });
});
