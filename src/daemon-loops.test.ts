import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseResult, appendTask } from "./daemon-loops.ts";

test("parseResult: rich actions carry task + needs_approval", () => {
  const out = `{"actions":[{"text":"Book a check-up","task":true,"needs_approval":false},{"text":"Pay the $200 fee","task":true,"needs_approval":true}],"done":false,"note":"progressing"}`;
  const r = parseResult(out)!;
  expect(r.actions.length).toBe(2);
  expect(r.actions[0]).toEqual({ text: "Book a check-up", task: true, needsApproval: false });
  expect(r.actions[1].needsApproval).toBe(true);
  expect(r.note).toBe("progressing");
  expect(r.done).toBe(false);
});

test("parseResult: plain-string actions stay back-compatible (trackable, auto-approved)", () => {
  const r = parseResult(`prose... {"actions":["do the thing"],"done":true} trailing`)!;
  expect(r.actions[0]).toEqual({ text: "do the thing", task: true, needsApproval: false });
  expect(r.done).toBe(true);
});

test("parseResult: junk returns null", () => {
  expect(parseResult("no json here")).toBeNull();
});

test("appendTask: writes the ledger line once, dedupes case-insensitively", () => {
  const dir = mkdtempSync(join(tmpdir(), "prevail-loop-task-"));
  try {
    expect(appendTask(dir, "Schedule dentist")).toBe(true);
    expect(appendTask(dir, "schedule DENTIST")).toBe(false); // dup
    const md = readFileSync(join(dir, "_tasks.md"), "utf8");
    expect(md).toContain("# Tasks");
    expect(md).toContain("- [ ] Schedule dentist");
    expect(md).toContain("~loop");
    // exactly one task line
    expect(md.split("\n").filter((l) => l.startsWith("- [ ]")).length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
