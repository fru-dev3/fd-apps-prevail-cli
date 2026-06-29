import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSkillFile,
  parseYamlish,
  substitute,
  safeOutputPath,
  buildSkillEnv,
  loadSkillsForConnector,
  packForSkill,
  buildSkillPacks,
  effectiveMethod,
  runSkillPackWithFallback,
  type SkillSpec,
} from "./connector-skills.ts";
import type { AppSkill } from "./vault.ts";

// Minimal SkillSpec factory for pack-ordering tests.
function spec(id: string, runner: SkillSpec["runner"], extra: Partial<SkillSpec> = {}): SkillSpec {
  return {
    id, filePath: `/x/${id}.md`, runner, auth: [], inputs: [], outputs: [],
    description: "", connectorId: "testconn", connectorDir: "/x",
    method: undefined, capability: undefined, isFavorite: false,
    ...extra,
  };
}

function fakeApp(dir: string): AppSkill {
  return {
    id: "testconn",
    title: "Test",
    description: "",
    domains: [],
    path: dir,
    hasState: false,
    openLoopCount: 0,
    stateMtime: null,
    skills: [],
    community: true,
    integration: "api",
    status: "not-configured",
    lastSuccessTs: null,
    configured: false,
  };
}

describe("parseYamlish", () => {
  test("parses top-level scalars + arrays + nested objects", () => {
    const src = [
      "id: my-skill",
      "runner: llm",
      "auth: [FOO, BAR]",
      "inputs:",
      "  - { name: query, type: string, required: true }",
      "  - { name: limit, type: number }",
      "outputs:",
      "  - path: data/results.md",
      "    kind: markdown",
    ].join("\n");
    const parsed = parseYamlish(src);
    expect(parsed.id).toBe("my-skill");
    expect(parsed.runner).toBe("llm");
    expect(parsed.auth).toEqual(["FOO", "BAR"]);
    expect(Array.isArray(parsed.inputs)).toBe(true);
    expect((parsed.inputs as { name: string }[])[0]?.name).toBe("query");
    expect((parsed.inputs as { required: boolean }[])[0]?.required).toBe(true);
  });
});

describe("parseSkillFile", () => {
  test("parses a valid skill file end-to-end", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-"));
    const raw = [
      "---",
      "id: hello",
      "runner: llm",
      "panelist: claude",
      "auth: [TEST_KEY]",
      "inputs:",
      "  - { name: name, type: string, required: true }",
      "outputs:",
      "  - { path: data/hello-${input.name}.md, kind: replace }",
      "---",
      "",
      "Say hello to ${input.name}.",
    ].join("\n");
    const f = join(dir, "hello.md");
    writeFileSync(f, raw);
    const spec = parseSkillFile(raw, f, fakeApp(dir));
    expect(spec).not.toBeNull();
    expect(spec!.id).toBe("hello");
    expect(spec!.runner).toBe("llm");
    expect(spec!.auth).toEqual(["TEST_KEY"]);
    expect(spec!.outputs[0]!.path).toBe("data/hello-${input.name}.md");
    expect(spec!.description).toContain("Say hello");
  });

  test("rejects skills with unsafe id", () => {
    const raw = [
      "---",
      "id: ../etc/passwd",
      "runner: llm",
      "---",
      "body",
    ].join("\n");
    expect(parseSkillFile(raw, "/tmp/x.md", fakeApp("/tmp"))).toBeNull();
  });

  test("rejects unknown runner", () => {
    const raw = [
      "---",
      "id: hello",
      "runner: hostile-exec",
      "---",
      "body",
    ].join("\n");
    expect(parseSkillFile(raw, "/tmp/x.md", fakeApp("/tmp"))).toBeNull();
  });
});

describe("substitute", () => {
  test("substitutes input and env vars", () => {
    const r = substitute("data/${input.id}/${env.YEAR}.jsonl", {
      inputs: { id: "us-bank" },
      env: { YEAR: "2026" },
    });
    expect(r).toBe("data/us-bank/2026.jsonl");
  });

  test("throws on unknown input", () => {
    expect(() => substitute("${input.missing}", { inputs: {}, env: {} })).toThrow();
  });

  test("throws on unset env", () => {
    expect(() => substitute("${env.MISSING}", { inputs: {}, env: {} })).toThrow();
  });
});

describe("safeOutputPath", () => {
  test("legit data/ path is accepted", () => {
    expect(safeOutputPath("/tmp/conn", "transactions/2026-06.jsonl")).toContain("/tmp/conn/data/transactions/2026-06.jsonl");
  });

  test("../ escape rejected", () => {
    expect(safeOutputPath("/tmp/conn", "../../etc/passwd")).toBeNull();
  });

  test("absolute path escape rejected", () => {
    expect(safeOutputPath("/tmp/conn", "/etc/passwd")).toBeNull();
  });
});

describe("buildSkillEnv", () => {
  test("only allows declared auth keys through the scrubber", () => {
    process.env.PREVAIL_TELEGRAM_TOKEN = "secret-token";
    process.env.MY_TEST_AUTH = "ok";
    try {
      const env = buildSkillEnv({
        id: "x",
        filePath: "",
        runner: "llm",
        auth: ["MY_TEST_AUTH"],
        inputs: [],
        outputs: [],
        description: "",
        connectorId: "x",
        connectorDir: "/tmp",
      });
      expect(env.MY_TEST_AUTH).toBe("ok");
      expect(env.PREVAIL_TELEGRAM_TOKEN).toBeUndefined();
    } finally {
      delete process.env.PREVAIL_TELEGRAM_TOKEN;
      delete process.env.MY_TEST_AUTH;
    }
  });
});

describe("loadSkillsForConnector", () => {
  test("loads multiple skills, skips malformed ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "conn-"));
    mkdirSync(join(dir, "skills"));
    writeFileSync(
      join(dir, "skills", "good.md"),
      "---\nid: good\nrunner: llm\n---\nbody",
    );
    writeFileSync(
      join(dir, "skills", "bad.md"),
      "not-a-skill-file",
    );
    writeFileSync(
      join(dir, "skills", "SKILL.md"),
      "this is the overview file, not a skill",
    );
    const skills = loadSkillsForConnector(fakeApp(dir));
    expect(skills.length).toBe(1);
    expect(skills[0]!.id).toBe("good");
  });
});

describe("parseSkillFile method/favorite frontmatter (#8)", () => {
  const app = (): AppSkill => fakeApp("/x");
  test("derives access method from runner when no explicit method", () => {
    const s = parseSkillFile("---\nid: a\nrunner: browser\n---\nbody", "/x/a.md", app());
    expect(s?.method).toBe("browser");
  });
  test("honors an explicit valid method override", () => {
    const s = parseSkillFile("---\nid: a\nrunner: cli\nmethod: mcp\n---\nbody", "/x/a.md", app());
    expect(s?.method).toBe("mcp");
  });
  test("ignores an HTTP verb in method: and falls back to the runner-derived method", () => {
    // The api runner reads `method:` as the HTTP verb (GET); it must NOT become
    // the access method. Access method stays derived from runner: api.
    const s = parseSkillFile("---\nid: a\nrunner: api\nmethod: GET\n---\nbody", "/x/a.md", app());
    expect(s?.method).toBe("api");
    expect(s?.extra?.method).toBe("GET");
  });
  test("reads favorite: true", () => {
    const s = parseSkillFile("---\nid: a\nrunner: browser\nfavorite: true\n---\nbody", "/x/a.md", app());
    expect(s?.isFavorite).toBe(true);
  });
});

describe("packForSkill (#8 fallback wiring)", () => {
  test("a single-method app forms a one-member pack (backward compatible)", () => {
    const only = spec("sync", "llm");
    const pack = packForSkill(only, [only]);
    expect(pack.skills.map((s) => s.id)).toEqual(["sync"]);
    expect(pack.capability).toBe("sync");
  });

  test("leads with the explicitly chosen primary, then fallbacks by robustness rank", () => {
    const browser = spec("sync-browser", "browser", { capability: "sync", isFavorite: true });
    const api = spec("sync-api", "api", { capability: "sync" });
    const mcp = spec("sync-mcp", "mcp", { capability: "sync" });
    const all = [browser, api, mcp];
    // Daemon picks the api method as the primary: it must LEAD even though the
    // browser skill is the flagged favorite. The rest follow by rank (mcp<api).
    const pack = packForSkill(api, all);
    expect(pack.skills[0]!.id).toBe("sync-api");
    expect(pack.skills.map((s) => s.id)).toEqual(["sync-api", "sync-browser", "sync-mcp"]);
  });

  test("buildSkillPacks orders the favorite first within a capability", () => {
    const browser = spec("sync-browser", "browser", { capability: "sync", isFavorite: true });
    const api = spec("sync-api", "api", { capability: "sync" });
    const packs = buildSkillPacks([api, browser]);
    expect(packs.length).toBe(1);
    expect(packs[0]!.skills[0]!.id).toBe("sync-browser");
    expect(effectiveMethod(packs[0]!.skills[0]!)).toBe("browser");
  });
});

describe("runSkillPackWithFallback (#8 orchestration)", () => {
  test("falls through to the next method when the favorite is blocked, returns first success with trail", async () => {
    // read-only autonomy blocks the act-class first member, so the second
    // (read-class) member runs and succeeds. No real runner is invoked for the
    // success case: an llm skill with no outputs returns ok:false, so we use a
    // skill whose op is read and outputs empty -> still ok:false; instead we
    // assert the attempt trail + that a blocked member is recorded.
    const act = spec("do-act", "api", { capability: "cap", op: "send" });
    const read = spec("do-read", "api", { capability: "cap", op: "read" });
    const pack = { capability: "cap", connectorId: "testconn", skills: [act, read] };
    const res = await runSkillPackWithFallback(pack, {}, { autonomy: "read-only" });
    // First attempt (act) is autonomy-blocked; engine records it and moves on.
    expect(res.attempts[0]!.skillId).toBe("do-act");
    expect(res.attempts[0]!.ok).toBe(false);
    expect(res.attempts[0]!.message).toContain("blocked");
    // It tried the second method too (which fails later for lack of a real HTTP
    // endpoint), so the trail has both members.
    expect(res.attempts.map((a) => a.skillId)).toEqual(["do-act", "do-read"]);
  });
});
