// Domains routed as you chat: code first (a domain's name and routing
// keywords), the model only for a tie and inside a daily ceiling; each touch
// is a dated line in the domain's memory.md with its thread; Undo takes back
// exactly that turn's lines. The after-turn command does the same for a turn
// the desktop ran itself, plus a decision the user stated. Invented data.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NOTED_HEADING, noteInMemory, notedLine, scoreDomains, spendModelCall, unnote } from "./domain-touch.ts";
import { afterTurn } from "./chat-json.ts";
import { listDecisions } from "./decision-records.ts";

const ROOT = join("/tmp", `prevail-dtouch-${process.pid}`);
const V = join(ROOT, "vault");
const D = (d: string) => join(V, "data", "domains", d);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  const kw: Record<string, string[]> = { general: [], content: ["youtube", "video", "thumbnail"], "real-estate": ["tenant", "lease", "rent"], health: ["sleep"] };
  for (const [d, k] of Object.entries(kw)) {
    mkdirSync(join(D(d), "memory"), { recursive: true });
    writeFileSync(join(D(d), "manifest.json"), JSON.stringify({ identity: { name: d }, routing: { keywords: k } }));
    writeFileSync(join(D(d), ".prevail-layout-v4"), "");
  }
});

describe("code first", () => {
  test("a domain's name or two of its words decide; one word is a tie; the sentence is the line", () => {
    const h = scoreDomains(V, "Editing the YouTube video tonight. Also the tenant wants to renew the lease.", ["content", "real-estate", "health"]);
    expect(h.map((x) => [x.slug, x.score])).toEqual([["content", 2], ["real-estate", 2]]);
    expect(h[0]!.fact).toBe("Editing the YouTube video tonight.");
    expect(scoreDomains(V, "Slept badly, sleep is off.", ["health"])[0]!.score).toBe(1);
    expect(scoreDomains(V, "My health is fine", ["health"])[0]!.score).toBe(2);
    expect(scoreDomains(V, "nothing relevant here", ["content"])).toEqual([]);
  });
  test("the model tie-break has a daily ceiling per machine", () => {
    const now = Date.parse("2026-10-02T10:00:00Z");
    for (let i = 0; i < 3; i++) expect(spendModelCall(V, now, 3)).toBe(true);
    expect(spendModelCall(V, now, 3)).toBe(false);
    expect(spendModelCall(V, now + 86_400_000, 3)).toBe(true);
  });
});

describe("noted in memory, with Undo", () => {
  test("one dated line per touch under its heading, the thread named; Undo removes exactly it", () => {
    writeFileSync(join(D("content"), "memory", "memory.md"), "# Content memory\n\nMy own notes.\n");
    const ts = Date.parse("2026-10-02T10:00:00Z");
    const line = noteInMemory(V, "content", { ts, from: "general", thread: "t-1", fact: "Editing the foo video." });
    noteInMemory(V, "content", { ts: ts + 1, from: "general", thread: "t-2", fact: "Thumbnail done." });
    const md = readFileSync(join(D("content"), "memory", "memory.md"), "utf8");
    expect(md).toBe(`# Content memory\n\nMy own notes.\n\n${NOTED_HEADING}\n- 2026-10-02: Editing the foo video. (from General, thread t-1)\n- 2026-10-02: Thumbnail done. (from General, thread t-2)\n`);
    expect(line).toBe(notedLine({ ts, from: "general", thread: "t-1", fact: "Editing the foo video." }));
    expect(unnote(V, "content", { ts, thread: "t-1", line })).toBe(true);
    expect(readFileSync(join(D("content"), "memory", "memory.md"), "utf8")).not.toContain("Editing the foo video.");
    expect(readFileSync(join(D("content"), "memory", "memory.md"), "utf8")).toContain("My own notes.");
  });
});

describe("after a turn the desktop ran itself", () => {
  test("a stated decision is saved and the domains its words concern are noted, by code, no model", async () => {
    const out: string[] = [];
    let asked = 0;
    await afterTurn({
      vaultPath: V, domain: "general", thread: "t-9", localOnly: false, incognito: false, write: (l) => out.push(l),
      message: "I've decided to start a YouTube series about foo cooking.", reply: "Good plan.",
      classify: async () => { asked++; return { domains: [], entity_facts: {}, source: "model" }; },
    });
    const ev = out.map((l) => JSON.parse(l));
    expect(ev.map((e) => e.type)).toEqual(["decision_saved", "touched"]);
    expect(ev[0].decisionSaved).toMatchObject({ domain: "general", what: "Start a YouTube series about foo cooking" });
    expect(ev[1]).toMatchObject({ by: "code", domains: [{ slug: "content" }] });
    expect(asked).toBe(0);
    expect(readFileSync(join(D("content"), "memory", "memory.md"), "utf8")).toContain("(from General, thread t-9)");
    expect(listDecisions(V, { all: true })[0]!.thread).toBe("t-9");
    const quiet: string[] = [];
    await afterTurn({ vaultPath: V, domain: "general", thread: "t-10", localOnly: false, incognito: true, write: (l) => quiet.push(l), message: "I've decided to sell the foo duplex lease.", reply: "ok" });
    expect(quiet).toEqual([]);
  });
});
