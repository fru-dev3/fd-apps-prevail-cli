import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAgentWritten, isInternalPrompt, loadCorpus, projectKeyOf, userTextOf } from "./prompt-corpus.ts";
import { briefIsFresh, buildProjects, displayLine, renameProject, isAmbiguousKey, parseJsonAnswer, periodOf, readProjectsIndex, replayPrompt, splitBrief, timeline, type ModelRunner } from "./prompt-projects.ts";

const HOME = "/Users/someone";

describe("prompt corpus", () => {
  test("keys a prompt to the project folder it was typed in", () => {
    expect(projectKeyOf(`${HOME}/Documents/acme/web-apps/web-apps-shop/src-tauri`, HOME)).toBe("web-apps-shop");
    expect(projectKeyOf(`${HOME}/.workmux/web-shop/feature-x`, HOME)).toBe("web-shop");
    expect(projectKeyOf(`${HOME}/MyVault/data/domains/tax/memory`, HOME)).toBe("domain:tax");
    expect(projectKeyOf(`${HOME}/Documents/acme`, HOME)).toBe("acme");
    expect(projectKeyOf(`${HOME}/MyVault`, HOME)).toBe("vault");
    // A monorepo root the user names in their vault config keys on its child.
    expect(projectKeyOf(`${HOME}/Documents/acme/docs/notes`, HOME, ["acme"])).toBe("docs");
    expect(projectKeyOf(`${HOME}/Documents/acme/docs/notes`, HOME)).toBe("acme");
    expect(projectKeyOf("/", HOME)).toBe("");
    expect(projectKeyOf("/private/tmp/claude-501/x", HOME)).toBe("");
  });

  test("drops Prevail's own traffic and keeps what the user typed", () => {
    expect(isInternalPrompt("You are scoring a model's answer to a benchmark question.")).toBe(true);
    expect(isInternalPrompt("Context:\nAlex and Jordan have family out of state.")).toBe(true);
    expect(isInternalPrompt("fix the header on the fru.dev site", `${HOME}/.prevail/demo-vault/wealth`)).toBe(true);
    expect(isInternalPrompt("/rename fooo1")).toBe(true);
    expect(isInternalPrompt("/goal ship the site")).toBe(false);
    expect(isInternalPrompt("You are right, do it that way")).toBe(false);
    expect(isAgentWritten("Reply with the single word: ready")).toBe(true);
    expect(isAgentWritten("- You are agent 509f7935-0dbb-446f-bec1 working on")).toBe(true);
    expect(isAgentWritten("make the header green, never gold")).toBe(false);
    expect(isAgentWritten('"Evaluate a high-stakes 2027 decision: Alex Rivera, Senior SWE')).toBe(true);
    expect(isAgentWritten('"Current date 2026-07-02. Location Austin, Texas. Senior software engineer')).toBe(true);
    expect(isAgentWritten("Alex from the lender called about the Maple St refinance")).toBe(false);
    expect(isAgentWritten("# FILESYSTEM SCOPE \u2014 VAULT LOCK IS ON. HARD CONSTRAINT.")).toBe(true);
    expect(isAgentWritten("# DOMAIN IDEAL STATE \u2014 your target")).toBe(true);
  });

  test("recovers the user's message from a wrapped desktop prompt", () => {
    const wrapped = "# THE USER'S IDEAL STATE: their constitution.\nbe kind\n\n---\n\n# WHO YOU'RE HELPING - profile\nSam\n\nshould I refinance the Maple St house?";
    expect(userTextOf(wrapped)).toBe("should I refinance the Maple St house?");
    const history = "# THE USER'S IDEAL STATE: x\n\n---\n\nYou are mid-conversation.\n--- PRIOR TURNS ---\nUser: hi\n--- END PRIOR TURNS ---\n\nUser's next message: and the rates?";
    expect(userTextOf(history)).toBe("and the rates?");
    const job = "# THE USER'S IDEAL STATE: x\n\n---\n\nYou are a self-learning assistant that distills";
    expect(userTextOf(job)).toBeNull();
  });
});

describe("briefIsFresh", () => {
  const now = Date.parse("2026-09-25T00:00:00Z");
  const packed = { hash: "h1", model: "m", prompts: 200, ts: now - 864e5 };
  test("rewrites only on real growth, age or a model change", () => {
    expect(briefIsFresh(packed, "h1", 200, "m", true, now)).toBe(true);
    expect(briefIsFresh(packed, "h2", 210, "m", true, now)).toBe(true); // 10 new: under 15% of 200
    expect(briefIsFresh(packed, "h2", 230, "m", true, now)).toBe(false); // 30 new = 15%
    expect(briefIsFresh({ ...packed, ts: now - 8 * 864e5 }, "h2", 201, "m", true, now)).toBe(false); // a week old
    expect(briefIsFresh(packed, "h1", 200, "other", true, now)).toBe(false);
    expect(briefIsFresh(packed, "h1", 200, "m", false, now)).toBe(false);
    expect(briefIsFresh(undefined, "h1", 200, "m", true, now)).toBe(false);
    expect(briefIsFresh({ ...packed, prompts: 20 }, "h2", 34, "m", true, now)).toBe(true); // small projects need 15
  });
});

describe("displayLine", () => {
  test("drops paste wrappers and scratch paths, keeps the words", () => {
    expect(displayLine('<pasted_content id="bd3b">Build more sites</pasted_content> see /private/tmp/claude-501/x/y.md now')).toBe("Build more sites see (a scratch file) now");
    expect(displayLine("a".repeat(300)).length).toBe(240);
  });
});

describe("periods", () => {
  test("day, week, month and year keys and labels", () => {
    const ts = Date.parse("2026-09-24T23:30:00Z"); // a Thursday
    expect(periodOf(ts, "month")).toEqual({ key: "2026-09", label: "September 2026" });
    expect(periodOf(ts, "day").key).toBe("2026-09-24");
    // Minneapolis (UTC-5, offset +300): still the 24th locally, at 18:30.
    expect(periodOf(ts, "day", 300).key).toBe("2026-09-24");
    // Tokyo (UTC+9, offset -540): already the 25th.
    expect(periodOf(ts, "day", -540).key).toBe("2026-09-25");
    expect(periodOf(ts, "week")).toEqual({ key: "2026-09-21w", label: "Sep 21 to 27" });
    expect(periodOf(Date.parse("2026-09-30T12:00:00Z"), "week").label).toBe("Sep 28 to Oct 4");
    expect(periodOf(ts, "year")).toEqual({ key: "2026", label: "2026" });
  });
});

describe("model answers", () => {
  test("parseJsonAnswer finds JSON in fences and prose", () => {
    expect(parseJsonAnswer<number[]>("```json\n[1,2]\n```")).toEqual([1, 2]);
    expect(parseJsonAnswer<{ a: string }>('Sure! {"a":"[x]"} done')).toEqual({ a: "[x]" });
  });
  test("splitBrief separates the brief from its takeaways and strips em dashes", () => {
    const { brief, take } = splitBrief('# Rebuild: X\nA — B\n===TAKEAWAYS===\n{"status":"done","ideas":["i"]}');
    expect(brief).not.toContain("—");
    expect(take.status).toBe("done");
    expect(take.ideas).toEqual(["i"]);
  });
  test("ambiguous folder keys", () => {
    expect(isAmbiguousKey("acme")).toBe(false);
    expect(isAmbiguousKey("acme", ["acme"])).toBe(true);
    expect(isAmbiguousKey("web-apps")).toBe(true);
    expect(isAmbiguousKey("config:claude")).toBe(true);
    expect(isAmbiguousKey("web-apps-shop")).toBe(false);
  });
});

describe("buildProjects end to end (fake model)", () => {
  let vault: string;
  const t0 = Date.parse("2026-06-01T10:00:00Z");
  const rec = (i: number, prompt: string, cwd: string, session: string) =>
    JSON.stringify({ ts: new Date(t0 + i * 3600e3).toISOString(), epoch_ms: t0 + i * 3600e3, tool: "claude", session, cwd, prompt, source: "push", host: "mbp", entry: "cli" });

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "projects-test-"));
    for (const d of ["dev", "general", "insurance"]) mkdirSync(join(vault, "data", "domains", d), { recursive: true });
    mkdirSync(join(vault, "build", "_meta", "prompts"), { recursive: true });
    const site = `${HOME}/Documents/acme/web-apps/web-apps-fru-site`;
    const lines = [
      rec(0, "build the fru.dev site as a desktop metaphor", site, "s1"),
      rec(1, "the brand color is office green #008000, never gold", site, "s1"),
      rec(2, "no em dashes anywhere", site, "s1"),
      rec(3, "add a projects window", site, "s1"),
      rec(4, "deploy it to vercel", site, "s1"),
      rec(5, "You are scoring a model's answer to a benchmark question", "/", "bench"),
      rec(6, "draft the roof claim follow-up email", "/", "s2"),
      rec(7, "what did the adjuster say last time?", "/", "s2"),
    ];
    writeFileSync(join(vault, "build", "_meta", "prompts", "claude.mbp.jsonl"), lines.join("\n") + "\n");
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  test("groups, assigns, writes packs, never touches the raw streams", async () => {
    const rawBefore = readFileSync(join(vault, "build", "_meta", "prompts", "claude.mbp.jsonl"), "utf8");
    const calls: string[] = [];
    const run: ModelRunner = async (prompt) => {
      if (prompt.includes("into PROJECTS")) { calls.push("catalog"); return JSON.stringify([{ slug: "fru-dev-site", title: "fru.dev site", domain: "dev", kind: "site", summary: "Personal site.", keys: ["web-apps-fru-site"] }]); }
      if (prompt.includes("Assign each session")) { calls.push("assign"); return '{"S1":"new:roof-claim|Roof damage claim|insurance"}'; }
      if (prompt.includes("REPLAY BRIEF")) {
        calls.push("brief");
        expect(prompt).not.toContain("You are scoring");
        return "# Rebuild: fru.dev site\nUse office green.\n===TAKEAWAYS===\n{\"status\":\"active\",\"intents\":[{\"title\":\"Ship site\",\"goal\":\"g\",\"status\":\"active\"}],\"takeaways\":[\"green not gold\"],\"ideas\":[],\"open_questions\":[]}";
      }
      if (prompt.includes("Recommend what would")) { calls.push("recommend"); return '[{"kind":"skill","title":"Write a deploy skill","why":"repeated","domain":"dev","project":"fru.dev site"}]'; }
      throw new Error("unexpected prompt");
    };
    const idx = await buildProjects({ vault, home: vault, run, minPrompts: 2, concurrency: 1 });
    expect(calls).toEqual(["catalog", "assign", "brief", "brief", "recommend"]);
    expect(idx.stats.kept).toBe(7);
    const site = idx.projects.find((p) => p.slug === "fru-dev-site")!;
    expect(site.prompt_count).toBe(5);
    expect(site.takeaways).toEqual(["green not gold"]);
    const claim = idx.projects.find((p) => p.slug === "roof-claim")!;
    expect(claim.domain).toBe("insurance");
    expect(claim.prompt_count).toBe(2);
    const dir = join(vault, site.pack_dir);
    expect(site.pack_dir).toBe("data/domains/dev/memory/projects/fru-dev-site");
    expect(readFileSync(join(dir, "prompts.md"), "utf8")).toContain("the brand color is office green #008000, never gold");
    expect(readFileSync(join(dir, "prompts.jsonl"), "utf8").trim().split("\n")).toHaveLength(5);
    expect(readFileSync(join(dir, "brief.md"), "utf8")).toContain("prevail:replay-brief model=claude-fable-5-1");
    expect(replayPrompt(vault, "fru-dev-site")).toStartWith("# Rebuild: fru.dev site");
    expect(replayPrompt(vault, "fru-dev-site", true)).toContain("# Appendix: the original prompts");
    expect(readProjectsIndex(vault)!.recommendations[0].kind).toBe("skill");
    const distilled = JSON.parse(readFileSync(join(vault, "build", "_meta", "intents_distilled.json"), "utf8"));
    expect(distilled.source_count).toBe(7);
    expect(distilled.intents.map((i: { project: string }) => i.project).sort()).toEqual(["fru-dev-site", "roof-claim"]);
    // The raw capture stream is read, never written.
    expect(readFileSync(join(vault, "build", "_meta", "prompts", "claude.mbp.jsonl"), "utf8")).toBe(rawBefore);

    // A second run with nothing new makes no model calls at all (the daemon
    // runs this often), and a rebrief keeps the earlier brief in history/ and
    // refreshes the recommendations.
    calls.length = 0;
    await buildProjects({ vault, home: vault, run, minPrompts: 2, concurrency: 1 });
    expect(calls).toEqual([]);
    calls.length = 0;
    await buildProjects({ vault, home: vault, run, minPrompts: 2, concurrency: 1, rebrief: true, only: ["fru-dev-site"] });
    expect(calls).toEqual(["brief", "recommend"]);
    expect(existsSync(join(dir, "history"))).toBe(true);

    expect(site.weekly).toEqual({ "2026-06-01": 5 });
    // Curation: a rename moves the pack and keeps the brief, and the
    // recommendations that named it by title follow.
    renameProject(vault, "fru-dev-site", "fru-dev-site", "fru.dev site and trackers");
    expect(readProjectsIndex(vault)!.recommendations[0].project).toBe("fru.dev site and trackers");
    const renamed = renameProject(vault, "roof-claim", "roof-hail-claim", "Roof hail claim");
    expect(renamed.slug).toBe("roof-hail-claim");
    const moved = readProjectsIndex(vault)!.projects.find((p) => p.slug === "roof-hail-claim")!;
    expect(moved.title).toBe("Roof hail claim");
    expect(existsSync(join(vault, moved.pack_dir, "brief.md"))).toBe(true);
    expect(existsSync(join(vault, "data/domains/insurance/memory/projects/roof-claim"))).toBe(false);
    calls.length = 0;
    await buildProjects({ vault, home: vault, run, minPrompts: 2, concurrency: 1 });
    expect(calls).toEqual([]); // the renamed project is still fresh

    // Retrospect reads the same assignments, with no model call.
    const tl = timeline(vault, "month", 0, vault);
    expect(tl.built).toBe(true);
    expect(tl.periods).toHaveLength(1);
    expect(tl.periods[0].total).toBe(7);
    expect(tl.periods[0].byProject.map((x) => [x.slug, x.count])).toEqual([["fru-dev-site", 5], ["roof-hail-claim", 2]]);
    expect(tl.periods[0].byDomain[0]).toEqual({ domain: "dev", count: 5 });
  });
});
