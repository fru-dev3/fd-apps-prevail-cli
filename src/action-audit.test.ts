import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { auditAction, actionAuditPath } from "./action-audit.ts";

describe("action-audit — append-only ledger of consequential actions (C1/O94)", () => {
  test("appends redacted JSONL records", () => {
    const root = mkdtempSync(`${tmpdir()}/prevail-audit-`);
    auditAction(root, { ts: 1, domain: "career", action: "email the recruiter", outcome: "executed", provider: "claude", report: "sent" });
    auditAction(root, { ts: 2, domain: "wealth", action: "review", outcome: "proposed" });
    const lines = readFileSync(actionAuditPath(root), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.domain).toBe("career");
    expect(first.outcome).toBe("executed");
  });

  test("redacts secrets in action + report", () => {
    const root = mkdtempSync(`${tmpdir()}/prevail-audit-`);
    auditAction(root, { ts: 1, domain: "x", action: "use sk-abcdefghijklmnop123456", outcome: "executed", report: "token sk-zzzzzzzzzzzzzzzzzz99" });
    const rec = JSON.parse(readFileSync(actionAuditPath(root), "utf8").trim());
    expect(rec.action).not.toContain("sk-abcdefghijklmnop");
    expect(rec.report).not.toContain("sk-zzzzzzzzzzzzz");
  });
});
