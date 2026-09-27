import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  actClass, actMarker, approvePendingAct, denyPendingAct, gateToolCall, isAlwaysEligible,
  readActRules, readPendingActs, readPendingActsView, revokeActRule, threadIdFromEnv, DECLINED_REASON,
} from "./act-gate.ts";
import { readActionAudit } from "./action-audit.ts";

// In-chat approvals: the deny marker, Deny (no requeue), and per-tool,
// per-domain "Always allow" rules that never cover consequential or
// sensitive calls.
const VAULT = `/tmp/prevail-actgate-approvals-${process.pid}`;
const PLAYLIST = "mcp__claude_ai_Spotify__create_playlist"; // reversible
const INVOICE = "mcp__claude_ai_PayPal__create_invoice"; // financial

beforeEach(() => { rmSync(VAULT, { recursive: true, force: true }); mkdirSync(join(VAULT, "_meta"), { recursive: true }); });
afterAll(() => rmSync(VAULT, { recursive: true, force: true }));

describe("deny reason marker + thread", () => {
  test("a queued act's deny reason keeps its text and ends with the stable marker", () => {
    const d = gateToolCall(VAULT, "music", PLAYLIST, { title: "foo" });
    const id = readPendingActs(VAULT)[0]!.id;
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("This action was NOT run");
    expect(d.reason).toContain(actMarker(id));
    expect(actMarker(id)).toBe(`[prevail-act:${id}]`);
  });

  test("a known thread is recorded on the pending act; none means none", () => {
    gateToolCall(VAULT, "music", PLAYLIST, { title: "a" }, true, { thread: "thread_foo" });
    gateToolCall(VAULT, "music", PLAYLIST, { title: "b" });
    const [a, b] = readPendingActs(VAULT);
    expect(a!.thread).toBe("thread_foo");
    expect(b!.thread).toBeUndefined();
  });

  test("threadIdFromEnv accepts only a plain id", () => {
    expect(threadIdFromEnv({ PREVAIL_THREAD_ID: "2026-01-01_00-00-00_abc" })).toBe("2026-01-01_00-00-00_abc");
    expect(threadIdFromEnv({ PREVAIL_THREAD_ID: "../x" })).toBeUndefined();
    expect(threadIdFromEnv({})).toBeUndefined();
  });
});

describe("pending-list view", () => {
  test("carries actionClass and alwaysEligible", () => {
    gateToolCall(VAULT, "music", PLAYLIST, { title: "foo" });
    gateToolCall(VAULT, "biz", INVOICE, { amount: "10.00" });
    const view = readPendingActsView(VAULT);
    const pl = view.find((a) => a.tool === PLAYLIST)!;
    const inv = view.find((a) => a.tool === INVOICE)!;
    expect(pl.actionClass).toBe("reversible");
    expect(pl.alwaysEligible).toBe(true);
    expect(inv.actionClass).toBe("financial");
    expect(inv.alwaysEligible).toBe(false);
  });

  test("tool leaves are split before classifying (create_invoice is not one word)", () => {
    expect(actClass("mcp__foo_gateway__MAIL_SEND_EMAIL")).toBe("external_send");
    expect(actClass("mcp__foo__deleteRecord")).toBe("irreversible");
    expect(isAlwaysEligible(PLAYLIST, ["an email address"])).toBe(false);
  });

  test("a tool the classifier cannot place is never eligible", () => {
    for (const t of ["mcp__foo__make_payment", "mcp__foo__submit_order", "mcp__foo__execute_trade"]) {
      expect(actClass(t)).toBe("unknown");
      expect(isAlwaysEligible(t, [])).toBe(false);
    }
  });
});

describe("deny", () => {
  test("removes the act, audits it, and a same-args retry is refused WITHOUT requeueing", () => {
    const input = { title: "foo" };
    gateToolCall(VAULT, "music", PLAYLIST, input);
    const id = readPendingActs(VAULT)[0]!.id;
    expect(denyPendingAct(VAULT, id)).toEqual({ ok: true });
    expect(readPendingActs(VAULT)).toHaveLength(0);
    const retry = gateToolCall(VAULT, "music", PLAYLIST, input);
    expect(retry).toEqual({ action: "deny", reason: DECLINED_REASON });
    expect(readPendingActs(VAULT)).toHaveLength(0);
    expect(readActionAudit(VAULT).some((e) => e.outcome === "denied")).toBe(true);
  });

  test("different arguments are a new request and queue normally", () => {
    gateToolCall(VAULT, "music", PLAYLIST, { title: "foo" });
    denyPendingAct(VAULT, readPendingActs(VAULT)[0]!.id);
    const d = gateToolCall(VAULT, "music", PLAYLIST, { title: "bar" });
    expect(d.reason).toContain("[prevail-act:");
    expect(readPendingActs(VAULT)).toHaveLength(1);
  });

  test("an unknown id is an error", () => {
    expect(denyPendingAct(VAULT, "act_missing").ok).toBe(false);
  });
});

describe("always-allow rules", () => {
  test("an eligible act approved with always runs later calls of that tool in that domain", () => {
    gateToolCall(VAULT, "music", PLAYLIST, { title: "a" });
    const id = readPendingActs(VAULT)[0]!.id;
    expect(approvePendingAct(VAULT, id, false, true)).toEqual({ ok: true });
    const rules = readActRules(VAULT);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ tool: PLAYLIST, domain: "music" });
    expect(typeof rules[0]!.ts).toBe("number");
    // The approved retry, then brand-new arguments: both run without queueing.
    expect(gateToolCall(VAULT, "music", PLAYLIST, { title: "a" }).action).toBe("allow");
    expect(gateToolCall(VAULT, "music", PLAYLIST, { title: "b" }).action).toBe("allow");
    expect(readPendingActs(VAULT)).toHaveLength(0);
    expect(readActionAudit(VAULT).some((e) => e.outcome === "executed" && (e.report ?? "").includes("always-allow rule"))).toBe(true);
    // Scoped per domain: the same tool elsewhere still asks.
    expect(gateToolCall(VAULT, "work", PLAYLIST, { title: "c" }).action).toBe("deny");
  });

  test("a rule never lets a sensitive call through", () => {
    gateToolCall(VAULT, "music", PLAYLIST, { title: "a" });
    approvePendingAct(VAULT, readPendingActs(VAULT)[0]!.id, false, true);
    const d = gateToolCall(VAULT, "music", PLAYLIST, { title: "a", note: "SSN 123-45-6789" });
    expect(d.action).toBe("deny");
    expect(readPendingActs(VAULT)).toHaveLength(1);
  });

  test("a consequential act is not eligible: --always errors and approves nothing", () => {
    gateToolCall(VAULT, "biz", INVOICE, { amount: "10.00" });
    const id = readPendingActs(VAULT)[0]!.id;
    expect(approvePendingAct(VAULT, id, false, true)).toEqual({ ok: false, error: "not eligible for always-allow" });
    expect(readPendingActs(VAULT)).toHaveLength(1); // still pending
    expect(readActRules(VAULT)).toHaveLength(0);
    expect(gateToolCall(VAULT, "biz", INVOICE, { amount: "10.00" }).action).toBe("deny"); // no grant minted
  });

  test("a sensitive act is not eligible even with the sensitive release", () => {
    gateToolCall(VAULT, "music", PLAYLIST, { title: "a", note: "SSN 123-45-6789" });
    const id = readPendingActs(VAULT)[0]!.id;
    expect(approvePendingAct(VAULT, id, true, true).ok).toBe(false);
    expect(readActRules(VAULT)).toHaveLength(0);
  });

  test("a rule stored for a consequential tool still never allows it", () => {
    // Hand-planted rule (e.g. an older build): the gate re-checks the class.
    writeFileSync(join(VAULT, "_meta", "act_rules.json"), JSON.stringify([{ tool: INVOICE, domain: "biz", ts: 1 }]));
    expect(gateToolCall(VAULT, "biz", INVOICE, { amount: "1.00" }).action).toBe("deny");
  });

  test("a rule stored for an unknown-class tool never allows it", () => {
    const ORDER = "mcp__foo__submit_order";
    writeFileSync(join(VAULT, "_meta", "act_rules.json"), JSON.stringify([{ tool: ORDER, domain: "biz", ts: 1 }]));
    expect(gateToolCall(VAULT, "biz", ORDER, { sku: "foo" }).action).toBe("deny");
  });

  test("rules list and revoke", () => {
    gateToolCall(VAULT, "music", PLAYLIST, { title: "a" });
    approvePendingAct(VAULT, readPendingActs(VAULT)[0]!.id, false, true);
    expect(readActRules(VAULT)).toHaveLength(1);
    expect(revokeActRule(VAULT, PLAYLIST, "music")).toEqual({ ok: true });
    expect(readActRules(VAULT)).toHaveLength(0);
    expect(revokeActRule(VAULT, PLAYLIST, "music")).toEqual({ ok: true }); // idempotent
    expect(gateToolCall(VAULT, "music", PLAYLIST, { title: "z" }).action).toBe("deny");
  });
});
