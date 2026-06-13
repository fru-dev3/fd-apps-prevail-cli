import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runSkillBrowser } from "./runners.ts";

const TMP = process.platform === "darwin" ? "/tmp" : require("node:os").tmpdir();
const conn = join(TMP, `prevail-br-${process.pid}`);
mkdirSync(conn, { recursive: true });
afterAll(() => rmSync(conn, { recursive: true, force: true }));

function skill(extra: Record<string, unknown>) {
  return { id: "t", filePath: join(conn, "t.md"), runner: "browser" as const, auth: [], inputs: [],
    outputs: [{ path: "page.txt", kind: "replace" as const }], description: "", connectorId: "t", connectorDir: conn, extra };
}

describe("runSkillBrowser", () => {
  test("rejects non-http url without spawning", async () => {
    const r = await runSkillBrowser(skill({ url: "file:///etc/passwd" }) as Parameters<typeof runSkillBrowser>[0], {}, {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain("http");
  });

  test("requires a url", async () => {
    const r = await runSkillBrowser(skill({}) as Parameters<typeof runSkillBrowser>[0], {}, {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain("url");
  });

  test("degrades gracefully when Playwright is not installed", async () => {
    // node runs the driver; playwright isn't a dep here → structured graceful error.
    const r = await runSkillBrowser(skill({ url: "https://example.com" }) as Parameters<typeof runSkillBrowser>[0], {}, {});
    expect(r.ok).toBe(false);
    expect(r.message.toLowerCase()).toContain("playwright");
  });
});
