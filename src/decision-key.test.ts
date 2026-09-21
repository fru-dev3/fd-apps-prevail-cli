// The key belongs to whoever runs Prevail, never to the repository.
//
// These tests exist because the failure they guard against is silent and
// permanent: a key committed once is in the history forever, and a bundled
// fallback key means every user is quietly spending someone else's budget.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decisionApiKey, resetDecisionKeyCache, KEY_SOURCES } from "./decision-config.ts";

const ENV_KEYS = ["PREVAIL_TYPESAFE_KEY", "TYPESAFE_API_KEY"];

describe("bring your own key", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetDecisionKeyCache();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetDecisionKeyCache();
  });

  test("there is no bundled default key", () => {
    // If this ever fails, someone shipped a key. That is the whole point.
    expect(decisionApiKey()).toBeNull();
  });

  test("the preferred variable is used", () => {
    process.env.PREVAIL_TYPESAFE_KEY = "user-supplied";
    expect(decisionApiKey()).toBe("user-supplied");
  });

  test("the vendor SDK's own variable works as a fallback", () => {
    process.env.TYPESAFE_API_KEY = "from-sdk-var";
    expect(decisionApiKey()).toBe("from-sdk-var");
  });

  test("the Prevail-prefixed variable wins when both are set", () => {
    process.env.PREVAIL_TYPESAFE_KEY = "preferred";
    process.env.TYPESAFE_API_KEY = "fallback";
    expect(decisionApiKey()).toBe("preferred");
  });

  test("surrounding whitespace is not part of the key", () => {
    process.env.PREVAIL_TYPESAFE_KEY = "  padded  ";
    expect(decisionApiKey()).toBe("padded");
  });

  test("an empty variable is the same as not setting one", () => {
    process.env.PREVAIL_TYPESAFE_KEY = "   ";
    expect(decisionApiKey()).toBeNull();
  });

  test("a 1Password reference is never returned as though it were the key", () => {
    // Whether `op` is installed and unlocked here is not the point. The point
    // is that the reference itself must never be sent as a bearer token.
    process.env.PREVAIL_TYPESAFE_KEY = "op://Dev/Nonexistent Item/api_key";
    const k = decisionApiKey();
    if (k !== null) expect(k.startsWith("op://")).toBe(false);
  }, 15_000);

  test("a failed 1Password lookup is remembered, not retried every call", () => {
    process.env.PREVAIL_TYPESAFE_KEY = "op://Dev/Definitely Not A Real Item/api_key";
    const t0 = Date.now();
    for (let i = 0; i < 25; i++) decisionApiKey();
    // 25 uncached spawns would be ~50s at a 2s timeout each. One is bounded.
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 15_000);

  test("the status output names somewhere real to put a key", () => {
    expect(KEY_SOURCES.join(" ")).toContain("PREVAIL_TYPESAFE_KEY");
    expect(KEY_SOURCES.join(" ")).toContain("op://");
  });
});

describe("no secret is committed to this repository", () => {
  // A key assigned to a literal, rather than read from the environment.
  const HARDCODED = /(PREVAIL_TYPESAFE_KEY|TYPESAFE_API_KEY|apiKey|api_key)\s*[=:]\s*["'`][^"'`\n]{16,}["'`]/;
  // Long opaque tokens sitting in source, which is what a real key looks like.
  const TOKEN_SHAPED = /["'`][A-Za-z0-9_-]{40,}["'`]/;

  const sourceFiles = (): string[] =>
    readdirSync("src")
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      .map((f) => join("src", f));

  test("no file assigns a key to a literal", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (!HARDCODED.test(line)) return;
        // Reading from the environment, and the short placeholders the tests
        // use, are exactly what we want to see.
        if (/process\.env|opts\.apiKey|apiKey\?:|=> *(null|raw|key)\b/.test(line)) return;
        offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("no decision-layer file carries a token-shaped literal", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles().filter((f) => f.includes("decision"))) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (TOKEN_SHAPED.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 60)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
