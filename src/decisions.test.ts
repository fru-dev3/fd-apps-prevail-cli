import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendDecision,
  decisionsFile,
  domainDir,
  makeDecisionId,
  readDecisions,
  setDecisionFeedback,
} from "./decisions.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "prevail-decisions-"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("domainDir / decisionsFile", () => {
  test("a real domain resolves under the vault; General resolves to the root", () => {
    expect(domainDir(vault, "wealth")).toBe(join(vault, "wealth"));
    expect(domainDir(vault, null)).toBe(vault);
    expect(domainDir(vault, "general")).toBe(vault);
    expect(domainDir(vault, "__general__")).toBe(vault);
  });

  test("traversal-y domain names fall back to the vault root (no escape)", () => {
    expect(domainDir(vault, "..")).toBe(vault);
    expect(domainDir(vault, "a/b")).toBe(vault);
  });

  test("decisionsFile points at _decisions.jsonl in the domain dir", () => {
    expect(decisionsFile(vault, "wealth")).toBe(join(vault, "wealth", "_decisions.jsonl"));
    expect(decisionsFile(vault, null)).toBe(join(vault, "_decisions.jsonl"));
  });
});

describe("append + read", () => {
  test("append creates the file and read returns it", () => {
    const rec = appendDecision(vault, "wealth", { type: "council_verdict", verdict: "buy" });
    expect(rec.id).toMatch(/^d-/);
    expect(existsSync(decisionsFile(vault, "wealth"))).toBe(true);
    const all = readDecisions(vault, "wealth");
    expect(all.length).toBe(1);
    expect(all[0]!.verdict).toBe("buy");
  });

  test("read returns newest-first and honors limit", () => {
    appendDecision(vault, "wealth", { id: "a", verdict: "1" });
    appendDecision(vault, "wealth", { id: "b", verdict: "2" });
    appendDecision(vault, "wealth", { id: "c", verdict: "3" });
    const all = readDecisions(vault, "wealth");
    expect(all.map((r) => r.id)).toEqual(["c", "b", "a"]);
    const top2 = readDecisions(vault, "wealth", 2);
    expect(top2.map((r) => r.id)).toEqual(["c", "b"]);
  });

  test("reading a domain with no log returns []", () => {
    expect(readDecisions(vault, "health")).toEqual([]);
  });

  test("General decisions land at the vault root, separate from domains", () => {
    appendDecision(vault, null, { id: "g1", verdict: "general" });
    appendDecision(vault, "wealth", { id: "w1", verdict: "wealth" });
    expect(readDecisions(vault, null).map((r) => r.id)).toEqual(["g1"]);
    expect(readDecisions(vault, "wealth").map((r) => r.id)).toEqual(["w1"]);
  });

  test("malformed lines are skipped, not fatal", () => {
    const file = decisionsFile(vault, "wealth");
    appendDecision(vault, "wealth", { id: "ok", verdict: "fine" });
    Bun.write(file, `${readFileSync(file, "utf8")}not json\n`);
    const all = readDecisions(vault, "wealth");
    expect(all.length).toBe(1);
    expect(all[0]!.id).toBe("ok");
  });
});

describe("feedback", () => {
  test("set up/down then clear, keyed by id, preserving order", () => {
    appendDecision(vault, "wealth", { id: "a", verdict: "1" });
    appendDecision(vault, "wealth", { id: "b", verdict: "2" });

    expect(setDecisionFeedback(vault, "wealth", "b", "up", "nailed it")).toBe(true);
    let b = readDecisions(vault, "wealth").find((r) => r.id === "b")!;
    expect(b.feedback).toEqual({ rating: "up", note: "nailed it" });

    // order on disk is still a, b
    const onDisk = readFileSync(decisionsFile(vault, "wealth"), "utf8").trim().split("\n");
    expect(JSON.parse(onDisk[0]!).id).toBe("a");
    expect(JSON.parse(onDisk[1]!).id).toBe("b");

    expect(setDecisionFeedback(vault, "wealth", "b", "clear")).toBe(true);
    b = readDecisions(vault, "wealth").find((r) => r.id === "b")!;
    expect(b.feedback).toBeUndefined();
  });

  test("feedback on a missing id returns false", () => {
    appendDecision(vault, "wealth", { id: "a" });
    expect(setDecisionFeedback(vault, "wealth", "nope", "up")).toBe(false);
  });
});

describe("makeDecisionId", () => {
  test("ids are unique and prefixed", () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeDecisionId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id.startsWith("d-")).toBe(true);
  });
});
