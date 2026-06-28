import { describe, expect, test } from "bun:test";
import {
  extractFirstJsonObject,
  validateAgentAction,
  guardAgentAction,
  isSecretText,
  redactSnapshot,
  redactActionValue,
  buildLocator,
  buildFallbackLocator,
  validateReplaySteps,
  type AgentAction,
} from "./browser-actions.ts";

describe("extractFirstJsonObject", () => {
  test("pulls a bare object", () => {
    expect(extractFirstJsonObject('{"action":"done"}')).toEqual({ action: "done" });
  });
  test("pulls the object out of prose + fences", () => {
    const reply = 'Sure, I will click it.\n```json\n{"action":"click","ref":"e4"}\n```\nDone.';
    expect(extractFirstJsonObject(reply)).toEqual({ action: "click", ref: "e4" });
  });
  test("ignores braces inside strings", () => {
    expect(extractFirstJsonObject('{"text":"a{b}c","action":"fill","ref":"e1"}')).toEqual({
      text: "a{b}c",
      action: "fill",
      ref: "e1",
    });
  });
  test("returns null when there is no object", () => {
    expect(extractFirstJsonObject("no json here")).toBeNull();
  });
});

describe("validateAgentAction", () => {
  test("accepts a well-formed click", () => {
    const r = validateAgentAction({ action: "click", ref: "e3", thought: "open statements" });
    expect(r.ok).toBe(true);
    expect(r.action?.ref).toBe("e3");
  });
  test("rejects unknown action", () => {
    expect(validateAgentAction({ action: "teleport" }).ok).toBe(false);
  });
  test("rejects ref action without a valid ref", () => {
    expect(validateAgentAction({ action: "click", ref: "button#x" }).ok).toBe(false);
    expect(validateAgentAction({ action: "click" }).ok).toBe(false);
  });
  test("rejects non-http navigate", () => {
    expect(validateAgentAction({ action: "navigate", url: "file:///etc/passwd" }).ok).toBe(false);
    expect(validateAgentAction({ action: "navigate", url: "https://ok.com" }).ok).toBe(true);
  });
  test("rejects over-long fill", () => {
    expect(validateAgentAction({ action: "fill", ref: "e1", text: "x".repeat(5000) }).ok).toBe(false);
  });
  test("rejects disallowed key", () => {
    expect(validateAgentAction({ action: "press_key", key: "Meta+Q" }).ok).toBe(false);
    expect(validateAgentAction({ action: "press_key", key: "Enter" }).ok).toBe(true);
  });
  test("clamps wait_for timeout", () => {
    const r = validateAgentAction({ action: "wait_for", timeout_ms: 999999 });
    expect(r.ok).toBe(true);
    expect(r.action?.timeout_ms).toBe(60000);
  });
});

describe("guardAgentAction", () => {
  const fill = (text: string): AgentAction => ({ action: "fill", ref: "e1", text });
  test("refuses to fill credential fields by element name", () => {
    expect(guardAgentAction(fill("hunter2"), "Password").block).toBe(true);
    expect(guardAgentAction(fill("123456"), "One-time code").block).toBe(true);
  });
  test("refuses to fill a flagged password element", () => {
    expect(guardAgentAction(fill("x"), "", true).block).toBe(true);
  });
  test("allows filling a benign field", () => {
    expect(guardAgentAction(fill("2026-01-01"), "Start date").block).toBe(false);
  });
  test("hard-blocks consequential controls", () => {
    const click: AgentAction = { action: "click", ref: "e2" };
    const v = guardAgentAction(click, "Send Money");
    expect(v.block).toBe(true);
    expect(v.needConfirm).toBe(true);
  });
  test("asks for confirmation on financially-classed clicks", () => {
    const v = guardAgentAction({ action: "click", ref: "e2" }, "Purchase subscription");
    expect(v.block).toBe(false);
    expect(v.needConfirm).toBe(true);
  });
  test("passes a plain Download control", () => {
    const v = guardAgentAction({ action: "click", ref: "e2" }, "Download statement");
    expect(v.block).toBe(false);
    expect(v.needConfirm).toBe(false);
  });
});

describe("redaction", () => {
  test("detects secret-shaped numbers", () => {
    expect(isSecretText("card 4111111111111111")).toBe(true);
    expect(isSecretText("ssn 123-45-6789")).toBe(true);
    expect(isSecretText("otp 482913")).toBe(true);
    expect(isSecretText("Last 365 days")).toBe(false);
  });
  test("redactSnapshot masks long numbers", () => {
    const out = redactSnapshot("Account 4111111111111111 balance $10");
    expect(out).not.toContain("4111111111111111");
  });
  test("redactActionValue placeholders secrets but keeps benign values", () => {
    expect(redactActionValue("4111111111111111")).toBe("${input.redacted}");
    expect(redactActionValue("Last 365 days")).toBe("Last 365 days");
  });
});

describe("buildLocator", () => {
  test("prefers role+name", () => {
    const loc = buildLocator({ role: "button", name: "Download", testid: "dl", css: ".x" });
    expect(loc).toEqual({ role: "button", name: "Download" });
  });
  test("falls back through label → text → testid → css(brittle)", () => {
    expect(buildLocator({ label: "Email" })).toEqual({ label: "Email" });
    expect(buildLocator({ text: "Statements" })).toEqual({ text: "Statements" });
    expect(buildLocator({ testid: "period" })).toEqual({ testid: "period" });
    expect(buildLocator({ css: "div:nth-child(3)" })).toEqual({ css: "div:nth-child(3)", brittle: true });
  });
  test("flags positional-only as brittle", () => {
    expect(buildLocator({ role: "button", name: "X", positionalOnly: true }).brittle).toBe(true);
  });
  test("fallback locator is distinct from primary", () => {
    const primary = buildLocator({ role: "button", name: "Download" });
    expect(buildFallbackLocator({ role: "button", name: "Download", testid: "dl" }, primary)).toEqual({ testid: "dl" });
  });
});

describe("validateReplaySteps", () => {
  test("accepts a clean steps array", () => {
    const r = validateReplaySteps([
      { action: "navigate", url: "https://x.com/s", expect: { url_matches: "/s" } },
      { action: "click", locator: { role: "button", name: "Download" }, expect: { download: true } },
    ]);
    expect(r.ok).toBe(true);
  });
  test("rejects non-array", () => {
    expect(validateReplaySteps({}).ok).toBe(false);
  });
  test("rejects navigate without http url and click without locator", () => {
    const r = validateReplaySteps([
      { action: "navigate", url: "ftp://x" },
      { action: "click" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBe(2);
  });
  test("rejects a secret-shaped fill value", () => {
    const r = validateReplaySteps([{ action: "fill", locator: { label: "card" }, value: "4111111111111111" }]);
    expect(r.ok).toBe(false);
  });
});
