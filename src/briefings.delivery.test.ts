import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { deliverBriefing, type BriefingEntry } from "./briefings.ts";

const TMP = process.platform === "darwin" ? "/tmp" : require("node:os").tmpdir();
const ROOT = join(TMP, `prevail-deliv-${process.pid}`);
const domainPath = join(ROOT, "wealth");
mkdirSync(domainPath, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function entry(over: Partial<BriefingEntry>): BriefingEntry {
  return { id: "b1", name: "Daily", cron: "0 7 * * *", domain: "wealth", prompt: "p", mode: "single", deliver: "log", enabled: true, last_run: null, created_at: 0, ...over };
}

describe("deliverBriefing", () => {
  test("routes to configured channels via hooks; skips channels with no hook", async () => {
    let emailedTo = "";
    const d = await deliverBriefing(
      entry({ deliver: "log", channels: ["email", "drive"] }),
      "the brief body", 123, "claude", domainPath,
      undefined,
      { email: async (subj, body) => { emailedTo = `${subj}|${body}`; return "sent:msg-1"; } },
    );
    expect(d.log).toBe(true);
    expect(d.channels?.email).toBe("sent:msg-1");
    expect(d.channels?.drive).toContain("skipped");
    expect(emailedTo).toContain("Daily · wealth");
    expect(emailedTo).toContain("the brief body");
  });

  test("telegram hook counted; channel hook error captured not thrown", async () => {
    const d = await deliverBriefing(
      entry({ deliver: "telegram", channels: ["email"] }),
      "body", 1, "claude", domainPath,
      async () => 3,
      { email: async () => { throw new Error("smtp down"); } },
    );
    expect(d.telegram).toBe(3);
    expect(d.channels?.email).toContain("error: smtp down");
  });
});
