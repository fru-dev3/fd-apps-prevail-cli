import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSkillFile,
  parseYamlish,
  substitute,
  safeOutputPath,
  buildSkillEnv,
  loadSkillsForConnector,
} from "./connector-skills.ts";
import type { AppSkill } from "./vault.ts";

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
