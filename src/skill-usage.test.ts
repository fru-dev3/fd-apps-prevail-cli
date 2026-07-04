import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { recordSkillUse, skillUsageReport, archiveSkill, unarchiveSkill, DORMANT_AFTER_DAYS } from "./skill-usage.ts";

// Usage intelligence contract: uses tick a vault-wide ledger; the report joins
// the LIVE scan (never-used skills show as unused); archive moves the dir out
// of the scanned set without deleting; unarchive restores it.
const ROOT = join("/tmp", `prevail-skilluse-${process.pid}`);
const VAULT = join(ROOT, "vault");

function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  const dom = join(VAULT, "data", "domains", "career");
  for (const skill of ["resume-review", "network-scan"]) {
    const d = join(dom, "skills", skill);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `# ${skill}\n\ndoes things\n`);
  }
}

describe("skill usage intelligence", () => {
  beforeEach(seed);
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

  test("uses tick the ledger; the report ranks used above never-used", async () => {
    await recordSkillUse(VAULT, "career", "resume-review", "chat");
    await recordSkillUse(VAULT, "career", "resume-review", "council");
    const rep = skillUsageReport(VAULT);
    expect(rep.total).toBe(2);
    expect(rep.rows[0]).toMatchObject({ id: "resume-review", uses: 2, verdict: "active" });
    expect(rep.rows[1]).toMatchObject({ id: "network-scan", uses: 0, verdict: "unused" });
    expect(rep.unused).toBe(1);
  });

  test("a skill unused past the dormancy window reads dormant", async () => {
    await recordSkillUse(VAULT, "career", "resume-review", "chat");
    const future = Date.now() + (DORMANT_AFTER_DAYS + 1) * 86_400_000;
    const rep = skillUsageReport(VAULT, future);
    expect(rep.rows.find((r) => r.id === "resume-review")!.verdict).toBe("dormant");
  });

  test("archive removes from the scan without deleting; unarchive restores", () => {
    const r = archiveSkill(VAULT, "career", "network-scan");
    expect(r.ok).toBe(true);
    expect(existsSync(join(VAULT, "data", "domains", "career", "skills", "_archive", "network-scan", "SKILL.md"))).toBe(true);
    expect(skillUsageReport(VAULT).total).toBe(1);
    const u = unarchiveSkill(VAULT, "career", "network-scan");
    expect(u.ok).toBe(true);
    expect(skillUsageReport(VAULT).total).toBe(2);
  });

  test("archive of a missing skill fails honestly; usage recording never throws", async () => {
    expect(archiveSkill(VAULT, "career", "nope").ok).toBe(false);
    await recordSkillUse("/nonexistent-vault-xyz", "career", "resume-review", "chat"); // must not throw
  });
});
