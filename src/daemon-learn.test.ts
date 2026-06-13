import { describe, expect, test } from "bun:test";
import { planDistill, renderActivity, parseDistillOutput, buildDistillPrompt } from "./daemon-learn.ts";

describe("headless learn daemon (distill port)", () => {
  test("planDistill protects the recent tail and skips partial trailing lines", () => {
    const lines = [
      JSON.stringify({ kind: "intent", message: "a" }),
      JSON.stringify({ kind: "intent", message: "b" }),
      JSON.stringify({ kind: "intent", message: "c" }),
      JSON.stringify({ kind: "intent", message: "d" }),
    ];
    // 4 complete lines + a partial in-progress write (no newline).
    const slice = lines.map((l) => l + "\n").join("") + '{"kind":"intent","mess';
    const { records, bytes } = planDistill(slice, 2);
    // protectedRecent=2 -> distill the first 2 only; partial line excluded.
    expect(records.length).toBe(2);
    expect((records[0] as { message: string }).message).toBe("a");
    // bytes must equal exactly the first two complete lines.
    const expectBytes = Buffer.byteLength(lines[0] + "\n" + lines[1] + "\n", "utf8");
    expect(bytes).toBe(expectBytes);
  });

  test("planDistill returns nothing when records <= protectedRecent", () => {
    const slice = [1, 2].map((n) => JSON.stringify({ kind: "intent", message: String(n) }) + "\n").join("");
    expect(planDistill(slice, 2).records.length).toBe(0);
    expect(planDistill(slice, 5).records.length).toBe(0);
  });

  test("planDistill counts corrupt lines toward the byte cursor", () => {
    const good = JSON.stringify({ kind: "intent", message: "x" });
    const slice = `${good}\nnot json at all\n${good}\n${good}\n`;
    const { records, bytes } = planDistill(slice, 1);
    // 4 complete lines, protect 1 -> take 3; one is corrupt so 2 parse, but
    // bytes must cover all 3 taken lines.
    expect(records.length).toBe(2);
    expect(bytes).toBe(Buffer.byteLength(`${good}\nnot json at all\n${good}\n`, "utf8"));
  });

  test("renderActivity builds a USER/ASSISTANT transcript", () => {
    const recs = [
      { kind: "intent", message: "Should I sell?" },
      { kind: "reply", raw: "Consider your concentration risk." },
    ];
    const out = renderActivity(recs);
    expect(out).toContain("USER: Should I sell?");
    expect(out).toContain("ASSISTANT: Consider your concentration risk.");
  });

  test("parseDistillOutput splits the three marker sections", () => {
    const out = [
      "===MEMORY===",
      "## Standing context\nLikes index funds.",
      "===STATE===",
      "Net worth rising.",
      "===DECISIONS===",
      '{"decision":"Sell RSUs on vest","rationale":"diversify"}',
    ].join("\n");
    const p = parseDistillOutput(out);
    expect(p.memory).toContain("Likes index funds.");
    expect(p.state).toContain("Net worth rising.");
    expect(p.decisions.length).toBe(1);
    expect((p.decisions[0] as { decision: string }).decision).toBe("Sell RSUs on vest");
  });

  test("parseDistillOutput degrades when sections are missing", () => {
    const p = parseDistillOutput("just a blob of memory text, no markers");
    expect(p.memory).toBeNull();
    expect(p.state).toBeNull();
    expect(p.decisions.length).toBe(0);
  });

  test("buildDistillPrompt has the three markers and untrusted-data guard, no em dash", () => {
    const prompt = buildDistillPrompt("wealth", "old mem", "old state", "USER: hi\n", 800, 4000);
    expect(prompt).toContain("===MEMORY===");
    expect(prompt).toContain("===STATE===");
    expect(prompt).toContain("===DECISIONS===");
    expect(prompt).toContain("UNTRUSTED DATA BELOW");
    expect(prompt).not.toContain("—"); // em dash
  });
});
