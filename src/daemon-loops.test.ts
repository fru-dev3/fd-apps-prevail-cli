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
import { readDomainIntents, discoverLoopTargets } from "./daemon-loops.ts";

// #32 app-scoped loops: the loop runner discovers connected apps as loop targets
// the SAME way it discovers domains, and a DISABLED app is fully inert (never a
// target, so its loops never run).
test("discoverLoopTargets: includes an enabled app with loops, excludes a disabled one", () => {
  // scanVault refuses paths under /var (forbidden prefix), and macOS tmpdir()
  // lives there — use /tmp (symlinked to /private/tmp, which is allowed).
  const TMP_BASE = process.platform === "darwin" ? "/tmp" : _tmp();
  const root = _join(TMP_BASE, `prevail-looptargets-${process.pid}-${Math.floor(performance.now())}`);
  // v4 layout: vault root must hold only data/ + build/. Domains + apps live in data/.
  const domain = _join(root, "data", "domains", "health");
  const onApp = _join(root, "data", "apps", "myapp");
  const offApp = _join(root, "data", "apps", "offapp");
  _mkdir(domain, { recursive: true });
  _mkdir(onApp, { recursive: true });
  _mkdir(offApp, { recursive: true });
  // A domain (detected by state.md) with a loop.
  _write(_join(domain, "state.md"), "# Health\n");
  _write(_join(domain, "_loops.json"), JSON.stringify({ schema: 1, desiredState: "", loops: [] }));
  // An enabled app (manifest with no enabled field => on) carrying its own loops.
  _write(_join(onApp, "SKILL.md"), "# My App\n");
  _write(_join(onApp, "manifest.json"), JSON.stringify({ id: "myapp", name: "My App", integration: "manual" }));
  _write(_join(onApp, "_loops.json"), JSON.stringify({ schema: 1, desiredState: "", loops: [] }));
  // A disabled app: enabled:false in the manifest => never a loop target.
  _write(_join(offApp, "SKILL.md"), "# Off App\n");
  _write(_join(offApp, "manifest.json"), JSON.stringify({ id: "offapp", name: "Off App", integration: "manual", enabled: false }));
  _write(_join(offApp, "_loops.json"), JSON.stringify({ schema: 1, desiredState: "", loops: [] }));
  try {
    const names = discoverLoopTargets(root).map((t) => t.name);
    expect(names).toContain("health");  // domain discovered
    expect(names).toContain("general"); // general always present
    expect(names).toContain("myapp");   // enabled app is a loop target
    expect(names).not.toContain("offapp"); // disabled app is inert
  } finally {
    _rm(root, { recursive: true, force: true });
  }
});

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
