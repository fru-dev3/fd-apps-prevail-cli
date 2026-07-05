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
