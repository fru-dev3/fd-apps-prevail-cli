import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { auditAction, readActionAudit } from "./action-audit.ts";

describe("action-audit — append-only ledger of consequential actions (C1/O94)", () => {
  test("appends redacted JSONL records", () => {
    const root = mkdtempSync(`${tmpdir()}/prevail-audit-`);
    auditAction(root, { ts: 1, domain: "career", action: "email the recruiter", outcome: "executed", provider: "claude", report: "sent" });
    auditAction(root, { ts: 2, domain: "wealth", action: "review", outcome: "proposed" });
    const recs = readActionAudit(root);
    expect(recs.length).toBe(2);
    // Sorted by ts; merged across host shards.
    expect(recs[0].domain).toBe("career");
    expect(recs[0].outcome).toBe("executed");
  });

  test("redacts secrets in action + report", () => {
    const root = mkdtempSync(`${tmpdir()}/prevail-audit-`);
    auditAction(root, { ts: 1, domain: "x", action: "use sk-abcdefghijklmnop123456", outcome: "executed", report: "token sk-zzzzzzzzzzzzzzzzzz99" });
    const rec = readActionAudit(root)[0]!;
    expect(rec.action).not.toContain("sk-abcdefghijklmnop");
    expect(rec.report).not.toContain("sk-zzzzzzzzzzzzz");
  });
});

describe("action-audit lands in build/_log whatever root a caller hands in", () => {
  test("the domains or apps container resolves to the vault, never a data/domains/_log", () => {
    const { mkdirSync, existsSync, readdirSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const v = mkdtempSync(`${tmpdir()}/prevail-audit-v4-`);
    mkdirSync(join(v, "build"), { recursive: true });
    mkdirSync(join(v, "data", "domains", "garden"), { recursive: true });
    mkdirSync(join(v, "data", "entities", "products"), { recursive: true });
    auditAction(join(v, "data", "domains"), { ts: 1, domain: "garden", action: "a", outcome: "executed" });
    auditAction(join(v, "data", "entities", "products"), { ts: 2, domain: "garden", action: "b", outcome: "executed" });
    auditAction(v, { ts: 3, domain: "garden", action: "c", outcome: "executed" });
    expect(existsSync(join(v, "data", "domains", "_log"))).toBe(false);
    expect(existsSync(join(v, "data", "entities", "products", "_log"))).toBe(false);
    expect(readdirSync(join(v, "build", "_log")).some((f) => f.startsWith("action-audit"))).toBe(true);
    expect(readActionAudit(join(v, "data", "domains")).map((r) => r.action)).toEqual(["a", "b", "c"]);
  });
});
