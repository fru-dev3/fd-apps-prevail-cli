import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  classifyAct, actSummary, gateToolCall, approvePendingAct, readPendingActs, actHash,
} from "./act-gate.ts";

// The Action Gateway: connector writes from ANY lane queue for approval and
// pass the egress guard; approval mints a single-use grant the retry consumes.
const VAULT = `/tmp/prevail-actgate-${process.pid}`;

describe("classifyAct", () => {
  test("builtins and engine-owned servers pass; they are governed elsewhere", () => {
    expect(classifyAct("Bash")).toBe("allow");
    expect(classifyAct("WebFetch")).toBe("allow");
    expect(classifyAct("mcp__google_workspace__google_workspace")).toBe("allow");
    expect(classifyAct("mcp__prevail__add_task")).toBe("allow");
  });
  test("read-shaped connector tools run live", () => {
    expect(classifyAct("mcp__claude_ai_PayPal__list_transactions")).toBe("allow");
    expect(classifyAct("mcp__claude_ai_Gmail__search_threads")).toBe("allow");
    expect(classifyAct("mcp__claude_ai_Shopify__get-order")).toBe("allow");
  });
  test("write-shaped connector tools gate", () => {
    expect(classifyAct("mcp__claude_ai_PayPal__create_invoice")).toBe("gate");
    expect(classifyAct("mcp__claude_ai_Shopify__update-product")).toBe("gate");
    expect(classifyAct("mcp__claude_ai_Spotify__add_to_library")).toBe("gate");
    expect(classifyAct("mcp__composio__GMAIL_SEND_EMAIL")).toBe("gate");
  });
  test("unknown verbs gate (paranoid default, same as the gws classifier)", () => {
    expect(classifyAct("mcp__somesrv__frobnicate_widget")).toBe("gate");
  });
  test("export/download gate — they move documents to shareable locations", () => {
    expect(classifyAct("mcp__claude_ai_Canva__export-design")).toBe("gate");
    expect(classifyAct("mcp__claude_ai_Google_Drive__download_file_content")).toBe("gate");
  });
  test("summaries are human, not tool-id soup", () => {
    expect(actSummary("mcp__claude_ai_PayPal__create_invoice")).toBe("PayPal: create_invoice");
  });
});

describe("gate lifecycle", () => {
  beforeEach(() => { rmSync(VAULT, { recursive: true, force: true }); mkdirSync(join(VAULT, "_meta"), { recursive: true }); });
  afterAll(() => rmSync(VAULT, { recursive: true, force: true }));

  test("a write denies, queues once (dedupes retries), and names the pending id", () => {
    const input = { recipient_email: "them@corp.com", amount: "150.00" };
    const d1 = gateToolCall(VAULT, "business", "mcp__claude_ai_PayPal__create_invoice", input);
    expect(d1.action).toBe("deny");
    const pending = readPendingActs(VAULT);
    expect(pending).toHaveLength(1);
    expect(d1.reason).toContain(pending[0]!.id);
    // Model retries before approval: same record, no dupe.
    gateToolCall(VAULT, "business", "mcp__claude_ai_PayPal__create_invoice", input);
    expect(readPendingActs(VAULT)).toHaveLength(1);
  });

  test("approval mints a single-use grant: retry passes ONCE, then re-queues", () => {
    const input = { title: "Test playlist" };
    gateToolCall(VAULT, "music", "mcp__claude_ai_Spotify__create_playlist", input);
    const id = readPendingActs(VAULT)[0]!.id;
    expect(approvePendingAct(VAULT, id).ok).toBe(true);
    expect(readPendingActs(VAULT)).toHaveLength(0);
    expect(gateToolCall(VAULT, "music", "mcp__claude_ai_Spotify__create_playlist", input).action).toBe("allow");
    // Grant consumed: an identical second call queues again.
    expect(gateToolCall(VAULT, "music", "mcp__claude_ai_Spotify__create_playlist", input).action).toBe("deny");
  });

  test("changed arguments do NOT ride an old grant", () => {
    const a = { title: "A" };
    gateToolCall(VAULT, "music", "mcp__claude_ai_Spotify__create_playlist", a);
    approvePendingAct(VAULT, readPendingActs(VAULT)[0]!.id);
    expect(gateToolCall(VAULT, "music", "mcp__claude_ai_Spotify__create_playlist", { title: "B" }).action).toBe("deny");
    expect(actHash("t", JSON.stringify(a))).not.toBe(actHash("t", JSON.stringify({ title: "B" })));
  });

  test("sensitive content is detected, blocks plain approval, releases with the explicit flag", () => {
    const input = { recipient_email: "them@corp.com", note: "my salary is $185,000" };
    const d = gateToolCall(VAULT, "work", "mcp__claude_ai_PayPal__create_invoice", input);
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("salary");
    expect(d.reason).not.toContain("185,000");
    const act = readPendingActs(VAULT)[0]!;
    expect(act.categories.length).toBeGreaterThan(0);
    expect(approvePendingAct(VAULT, act.id).ok).toBe(false);
    expect(approvePendingAct(VAULT, act.id, true).ok).toBe(true);
    expect(gateToolCall(VAULT, "work", "mcp__claude_ai_PayPal__create_invoice", input).action).toBe("allow");
  });

  test("plain grant does not release sensitive content queued after it", () => {
    const input = { recipient_email: "x@y.com", note: "SSN 123-45-6789" };
    gateToolCall(VAULT, "w", "mcp__claude_ai_PayPal__create_invoice", input);
    const id = readPendingActs(VAULT)[0]!.id;
    expect(approvePendingAct(VAULT, id, false).ok).toBe(false); // must not mint
    expect(gateToolCall(VAULT, "w", "mcp__claude_ai_PayPal__create_invoice", input).action).toBe("deny");
  });

  test("reads never queue anything", () => {
    expect(gateToolCall(VAULT, "biz", "mcp__claude_ai_PayPal__list_transactions", {}).action).toBe("allow");
    expect(readPendingActs(VAULT)).toHaveLength(0);
  });
});
