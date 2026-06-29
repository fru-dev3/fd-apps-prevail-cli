import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { traceToSteps, buildReplaySkillMarkdown, writeReplaySkill, type TraceEntry } from "./browser-record.ts";
import { parseSkillFile } from "./connector-skills.ts";
import type { AppSkill } from "./vault.ts";

const TMP = process.platform === "darwin" ? "/tmp" : require("node:os").tmpdir();
const conn = join(TMP, `prevail-rec-${process.pid}`);
mkdirSync(conn, { recursive: true });
afterAll(() => rmSync(conn, { recursive: true, force: true }));

const trace: TraceEntry[] = [
  { action: { action: "navigate", url: "https://www.paypal.com/myaccount/statements" }, urlAfter: "https://www.paypal.com/myaccount/statements" },
  { action: { action: "select", ref: "e9", option: "Last 365 days" }, target: { ref: "e9", role: "combobox", name: "Statement period", testid: "period" } },
  { action: { action: "click", ref: "e10" }, target: { ref: "e10", role: "button", name: "Download" }, downloads: 1 },
  { action: { action: "read", ref: "e1" }, target: { ref: "e1", role: "link", name: "Summary" } }, // dropped
];

describe("traceToSteps", () => {
  test("keeps goal-advancing steps and drops read/etc", () => {
    const steps = traceToSteps(trace);
    expect(steps.map((s) => s.action)).toEqual(["navigate", "select", "click"]);
  });
  test("derives role+name locators with testid fallback", () => {
    const steps = traceToSteps(trace);
    const select = steps[1]!;
    expect(select.locator).toEqual({ role: "combobox", name: "Statement period" });
    expect(select.fallback).toBeUndefined(); // select has no fallback builder path
    const click = steps[2]!;
    expect(click.locator).toEqual({ role: "button", name: "Download" });
    expect(click.expect).toEqual({ download: true });
  });
  test("navigate carries a url_matches expect from the path", () => {
    expect(traceToSteps(trace)[0]!.expect).toEqual({ url_matches: "/myaccount/statements" });
  });
});

describe("buildReplaySkillMarkdown round-trips through parseSkillFile", () => {
  test("recorded skill parses back with steps intact", () => {
    const steps = traceToSteps(trace);
    const md = buildReplaySkillMarkdown(
      { skillId: "download-statements", connector: "paypal", goal: "Download last 12 months of statements", startUrl: "https://www.paypal.com/signin", domainAllow: ["paypal.com"], successGlob: "data/imports/**/*.pdf" },
      steps,
    );
    const app = { id: "paypal", path: conn } as AppSkill;
    const spec = parseSkillFile(md, join(conn, "skills", "download-statements.md"), app);
    expect(spec).not.toBeNull();
    expect(spec!.runner).toBe("browser");
    expect(spec!.id).toBe("download-statements");
    // The nested steps survived the engine's tolerant YAML parser as real objects.
    const parsedSteps = spec!.extra?.steps as Array<Record<string, unknown>>;
    expect(Array.isArray(parsedSteps)).toBe(true);
    expect(parsedSteps.length).toBe(3);
    expect(parsedSteps[2]).toMatchObject({ action: "click", locator: { role: "button", name: "Download" }, expect: { download: true } });
    // domain_allow + success_check parsed as real structures, not strings.
    expect(spec!.extra?.domain_allow).toEqual(["paypal.com"]);
    expect(spec!.extra?.success_check).toMatchObject({ type: "files_match", min: 1 });
  });
});

describe("writeReplaySkill", () => {
  test("writes a file and refuses empty traces", () => {
    const r = writeReplaySkill(conn, { skillId: "stmts", connector: "paypal", goal: "g", startUrl: "https://x.com" }, trace);
    expect(r.ok).toBe(true);
    expect(r.steps).toBe(3);
    expect(readFileSync(r.path!, "utf8")).toContain("runner: browser");
    const empty = writeReplaySkill(conn, { skillId: "z", connector: "paypal", goal: "g", startUrl: "https://x.com" }, [
      { action: { action: "read", ref: "e1" } },
    ]);
    expect(empty.ok).toBe(false);
  });
});
