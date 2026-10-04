// Invented credentials only.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { kindOf, scrubVault } from "./scrub-secrets.ts";

function fixture() {
  const root = join(homedir(), ".prevail-test-tmp");
  mkdirSync(root, { recursive: true });
  const base = mkdtempSync(join(root, "scrub-"));
  const vault = join(base, "vault");
  const put = (rel: string, body: string) => { mkdirSync(join(vault, rel, ".."), { recursive: true }); writeFileSync(join(vault, rel), body); };
  put("build/_meta/prompts/claude.mbp.jsonl", `${JSON.stringify({ ts: "x", prompt: "Sam login sam@example.com Starter password: Invented-Pass-77" })}\n${JSON.stringify({ ts: "y", prompt: "nothing here" })}\n`);
  put("build/_meta/entities/index.json", JSON.stringify({ entities: [{ id: "person/sam", mentions: [{ snippet: "pin 7710" }] }] }));
  put("data/entities/people/sam/entity.md", "# Sam\n\nYou shared a password: Invented-Pass-77\n");
  put("data/domains/home/memory/threads/t1.md", "user: token sk-abcdefghijklmnop1234567890\n");
  put("data/domains/home/memory/skills/x/SKILL.md", "token: YOUR_TOKEN_HERE\n");
  return { base, vault };
}

describe("scrubVault", () => {
  test("classifies kinds and skips skills", () => {
    expect(kindOf("build/_meta/prompts.claude.jsonl")).toBe("prompt-streams");
    expect(kindOf("data/domains/a/memory/skills/x/SKILL.md")).toBeNull();
    expect(kindOf("data/apps/x/notes.md")).toBeNull();
  });

  test("dry run counts, a real run masks with a backup outside the vault", () => {
    const { base, vault } = fixture();
    const dry = scrubVault(vault, { dryRun: true });
    expect(dry.byKind).toEqual({
      "prompt-streams": { files: 1, masked: 1 }, "entity-caches": { files: 1, masked: 1 },
      "entity-pages": { files: 1, masked: 1 }, threads: { files: 1, masked: 1 },
    });
    expect(readFileSync(join(vault, "build/_meta/prompts/claude.mbp.jsonl"), "utf8")).toContain("Invented-Pass-77");
    expect(() => scrubVault(vault, { backupDir: join(vault, "build") })).toThrow(/outside the vault/);
    const r = scrubVault(vault, { backupDir: join(base, "backups") });
    expect(r.backup && existsSync(r.backup)).toBe(true);
    expect(statSync(r.backup as string).mode & 0o777).toBe(0o600);
    const stream = readFileSync(join(vault, "build/_meta/prompts/claude.mbp.jsonl"), "utf8");
    expect(stream).not.toContain("Invented-Pass-77");
    expect(stream).toContain("sam@example.com");
    expect(stream.trim().split("\n").map((l) => JSON.parse(l))).toHaveLength(2);
    expect(readFileSync(join(vault, "data/domains/home/memory/skills/x/SKILL.md"), "utf8")).toContain("YOUR_TOKEN_HERE");
    expect(Object.keys(scrubVault(vault, { dryRun: true }).byKind)).toHaveLength(0);
    rmSync(base, { recursive: true, force: true });
  });
});
