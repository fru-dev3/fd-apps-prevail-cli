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

import { mkdirSync as _mkdir, writeFileSync as _write, rmSync as _rm } from "node:fs";
import { tmpdir as _tmp } from "node:os";
import { join as _join } from "node:path";
import { readDomainIntents } from "./daemon-loops.ts";

test("readDomainIntents: only intents touching the domain + not resolved, with recs", () => {
  const root = _join(_tmp(), `prevail-di-${process.pid}-${Math.floor(performance.now())}`);
  _mkdir(_join(root, "_meta"), { recursive: true });
  _write(_join(root, "_meta", "intents_distilled.json"), JSON.stringify({
    intents: [
      { title: "Vehicle purchase", goal: "evaluate transport", domains: ["wealth", "health"], status: "active", recommendations: ["compare TCO", "test drive"] },
      { title: "Done thing", goal: "x", domains: ["wealth"], status: "resolved", recommendations: ["nope"] },
      { title: "Other domain", goal: "y", domains: ["career"], status: "active" },
      { title: "Global", goal: "z", status: "active" }, // no domains → applies everywhere
    ],
  }));
  try {
    const out = readDomainIntents(root, "wealth");
    expect(out).toContain("Vehicle purchase");
    expect(out).toContain("compare TCO");      // recommendations surfaced
    expect(out).toContain("Global");           // no-domain intent applies
    expect(out).not.toContain("Done thing");   // resolved excluded
    expect(out).not.toContain("Other domain"); // wrong domain excluded
    // Health shares the vehicle intent too (cross-domain compounding).
    expect(readDomainIntents(root, "health")).toContain("Vehicle purchase");
    // A domain with only the global intent still gets it.
    expect(readDomainIntents(root, "career")).toContain("Global");
    expect(readDomainIntents(root, "career")).toContain("Other domain");
    // No file → empty, no crash.
    expect(readDomainIntents(_join(_tmp(), "nope-xyz"), "wealth")).toBe("");
  } finally {
    _rm(root, { recursive: true, force: true });
  }
});
