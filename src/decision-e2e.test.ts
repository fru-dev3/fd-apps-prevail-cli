// End to end through the real call path: classifyAsCouncilWorthy talks to a
// stub standing in for the decision service, and a shadow row lands in a real
// vault. This is the test that would catch the integration being wired up
// wrong even when every unit below it passes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyAsCouncilWorthy, flushDecisionShadow } from "./auto-council.ts";
import { resetDecisionLayerCache } from "./decision-config.ts";
import { readDecisionShadow } from "./decision-shadow.ts";
import type { AvailableCli } from "./cli-bridge.ts";

// A CLI kind with no handler: runChatTurn returns a "(no handler)" string
// rather than spawning anything, so the expensive classifier resolves fast
// and deterministically without touching a real model.
const inertCli = { kind: "nonexistent", bin: "nope", label: "Nope" } as unknown as AvailableCli;

let server: ReturnType<typeof Bun.serve> | null = null;
let seen: { auth: string | null; body: unknown } | null = null;
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen = { auth: req.headers.get("authorization"), body: await req.json() };
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
});
afterAll(() => server?.stop(true));

describe("auto-council with a decision layer behind it", () => {
  let vault = "";
  let cfgDir = "";
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ["PREVAIL_CONFIG_DIR", "PREVAIL_TYPESAFE_KEY", "PREVAIL_TYPESAFE_URL", "PREVAIL_BUNKER"]) {
      saved[k] = process.env[k];
    }
    vault = mkdtempSync(join(tmpdir(), "prevail-e2e-vault-"));
    mkdirSync(join(vault, "build", "_meta"), { recursive: true });
    cfgDir = mkdtempSync(join(tmpdir(), "prevail-e2e-cfg-"));
    process.env.PREVAIL_CONFIG_DIR = cfgDir;
    process.env.PREVAIL_TYPESAFE_KEY = "e2e-key";
    process.env.PREVAIL_TYPESAFE_URL = `http://127.0.0.1:${server!.port}/v1/systemone`;
    delete process.env.PREVAIL_BUNKER;
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ vaultPath: vault, decisionProvider: "typesafe" }));
    seen = null;
    reply = {
      status: 200,
      body: {
        model: "jev-1.13.0",
        answers: {
          route: { type: "choice", choice: "council", confidence: 0.93, probabilities: { council: 0.93 } },
          stakes: { type: "score", score: 2, confidence: 0.88, probabilities: { "2": 0.88 } },
          needsMoreContext: { type: "noul", noul: 0.2 },
        },
        usage: { input_tokens: 420, output_tokens: 12 },
      },
    };
    resetDecisionLayerCache();
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    resetDecisionLayerCache();
  });

  const classify = () =>
    classifyAsCouncilWorthy({
      cwd: vault,
      cli: inertCli,
      userPrompt: "Should I move the rentals into the trust before refinancing?",
      vault,
      domain: "real-estate",
      availableModels: 4,
    });

  test("shadow mode records the disagreement and still returns Prevail's verdict", async () => {
    const verdict = await classify();
    // The stub was emphatic that this deserves a council. Shadow mode means
    // the user still got exactly what they would have got before.
    expect(verdict).toBe(false);

    await flushDecisionShadow();
    const rows = readDecisionShadow(vault);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.surface).toBe("auto-council");
    expect(r.domain).toBe("real-estate");
    expect(r.actual).toBe("single");
    expect(r.proposed).toBe("council");
    expect(r.agreed).toBe(false);
    expect(r.provider).toBe("typesafe");
    expect(r.model).toBe("jev-1.13.0");
    expect(r.confidence).toBeCloseTo(0.93, 4);
    expect(r.decision_ms).toBeGreaterThanOrEqual(0);
    // 420 input tokens at $0.042 per million.
    expect(r.decision_usd).toBeCloseTo(420 * 0.042 / 1_000_000, 10);
  });

  test("it sent a Bearer token and a redacted state, not the raw prompt", async () => {
    await classifyAsCouncilWorthy({
      cwd: vault,
      cli: inertCli,
      userPrompt: "wire $42,000 to a@b.com before friday, call 555-987-6543",
      vault,
      domain: "real-estate",
      availableModels: 4,
    });
    await flushDecisionShadow();
    expect(seen).not.toBeNull();
    expect(seen!.auth).toBe("Bearer e2e-key");
    const body = seen!.body as { model: string; state: Record<string, unknown>; questions: Record<string, unknown> };
    expect(body.model).toBe("jev-latest");
    const sent = JSON.stringify(body.state);
    expect(sent).not.toContain("a@b.com");
    expect(sent).not.toContain("42,000");
    expect(sent).not.toContain("555-987-6543");
    expect(Object.keys(body.questions).sort()).toEqual(["needsMoreContext", "route", "stakes"]);
  });

  test("Bunker Mode means the service is never contacted at all", async () => {
    process.env.PREVAIL_BUNKER = "1";
    resetDecisionLayerCache();
    const verdict = await classify();
    expect(verdict).toBe(false);
    expect(seen).toBeNull();
    // The skip is still recorded, with the reason, so an empty report is
    // explainable rather than mysterious.
    await flushDecisionShadow();
    const rows = readDecisionShadow(vault);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.proposed).toBeNull();
    expect(rows[0]!.skipped).toMatch(/Bunker Mode/);
  });

  test("a decision service that errors changes nothing", async () => {
    reply = { status: 500, body: { detail: { message: "boom" } } };
    const verdict = await classify();
    expect(verdict).toBe(false);
    await flushDecisionShadow();
    const rows = readDecisionShadow(vault);
    expect(rows[0]!.proposed).toBeNull();
    expect(rows[0]!.skipped).toMatch(/returned nothing/);
  });

  test("live mode is what lets the signal actually route", async () => {
    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({ vaultPath: vault, decisionProvider: "typesafe", decisionMode: "live" }),
    );
    resetDecisionLayerCache();
    const verdict = await classify();
    // Same stub, same signal, different switch: now it convenes a council.
    expect(verdict).toBe(true);
    await flushDecisionShadow();
    const rows = readDecisionShadow(vault);
    expect(rows[0]!.proposed).toBe("council");
  });

  test("with only one runtime, a council is never proposed", async () => {
    const verdict = await classifyAsCouncilWorthy({
      cwd: vault,
      cli: inertCli,
      userPrompt: "Should I move the rentals into the trust?",
      vault,
      domain: "real-estate",
      availableModels: 1,
    });
    expect(verdict).toBe(false);
    await flushDecisionShadow();
    const body = seen!.body as { questions: { route: { criteria: Record<string, string> } } };
    // The impossible branch was never even offered to the model.
    expect(Object.keys(body.questions.route.criteria)).not.toContain("council");
    await flushDecisionShadow();
    expect(readDecisionShadow(vault)[0]!.proposed).toBe("single");
  });

  test("shadow mode does not make the user wait for a slow decision service", async () => {
    // The failure this guards against: a fast classifier and a slow decision
    // call, where shadow mode would otherwise add the difference to every
    // single turn for data the user never sees.
    server!.stop(true);
    const slow = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(3_000);
        return new Response("{}", { status: 200 });
      },
    });
    process.env.PREVAIL_TYPESAFE_URL = `http://127.0.0.1:${slow.port}/v1/systemone`;
    resetDecisionLayerCache();
    try {
      const t0 = Date.now();
      await classify();
      const elapsed = Date.now() - t0;
      // Measured at 1ms. Were the path awaiting the decision call, this
      // would be the full 1.2s deadline, so the margin here is decisive.
      expect(elapsed).toBeLessThan(200);
    } finally {
      slow.stop(true);
      // Let the abandoned call finish so it does not leak into the next test.
      await flushDecisionShadow();
    }
  });

  test("no vault means no recording and no behaviour change", async () => {
    const verdict = await classifyAsCouncilWorthy({
      cwd: vault,
      cli: inertCli,
      userPrompt: "Should I do the thing?",
      availableModels: 4,
    });
    expect(verdict).toBe(false);
    await flushDecisionShadow();
    expect(readDecisionShadow(vault)).toEqual([]);
  });
});
