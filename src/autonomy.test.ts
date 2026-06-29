import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVaultSession } from "./vault-session.ts";
import { getAutonomyState, setAutonomyState, setPolicyFor, getActionPolicy, setMonthlyFinancialCap, recordSpend, monthSpendUsd } from "./autonomy.ts";
import { gateAction, parseAmountUsd } from "./broker.ts";

function freshVault(): string {
  const v = mkdtempSync(join(tmpdir(), "prevail-autonomy-"));
  mkdirSync(join(v, "_meta"), { recursive: true });
  return v;
}

describe("autonomy + gateAction — the global brake", () => {
  beforeEach(() => { initVaultSession({}); });

  it("defaults: ask mode, money asks, destructive/credential never", () => {
    const v = freshVault();
    expect(getAutonomyState(v)).toBe("ask");
    const p = getActionPolicy(v);
    expect(p.financial).toBe("ask");
    expect(p.irreversible).toBe("never");
    expect(p.credential).toBe("never");
    expect(p.read).toBe("allow");
  });

  it("global pause blocks every action regardless of class", () => {
    const v = freshVault();
    setAutonomyState(v, "paused");
    expect(gateAction("fetch balances", { vault: v, autonomousActs: true }).decision).toBe("block");
    expect(gateAction("read the inbox", { vault: v, autonomousActs: true }).decision).toBe("block");
  });

  it("policy 'never' is an absolute block even with autonomy on", () => {
    const v = freshVault();
    setPolicyFor(v, "financial", "never");
    const g = gateAction("pay the vendor invoice", { vault: v, autonomousActs: true });
    expect(g.cls).toBe("financial");
    expect(g.decision).toBe("block");
  });

  it("allow + autonomy-on auto-runs; allow + autonomy-off asks", () => {
    const v = freshVault();
    expect(gateAction("fetch account balances", { vault: v, autonomousActs: true }).decision).toBe("auto");
    expect(gateAction("fetch account balances", { vault: v, autonomousActs: false }).decision).toBe("ask");
  });

  it("default consequential classes route to ask, not auto", () => {
    const v = freshVault();
    expect(gateAction("send an email to the team", { vault: v, autonomousActs: true }).decision).toBe("ask");
  });

  it("parses dollar amounts from action text", () => {
    expect(parseAmountUsd("pay the $1,200.50 invoice")).toBe(1200.5);
    expect(parseAmountUsd("transfer money to savings")).toBe(null);
  });

  it("enforces the monthly financial cap: allowed+auto downgrades to ask once the cap would be exceeded", () => {
    const v = freshVault();
    setPolicyFor(v, "financial", "allow"); // user opts financial into allow
    setMonthlyFinancialCap(v, 100);
    // Under cap → auto.
    expect(gateAction("pay the $40 invoice", { vault: v, autonomousActs: true }).decision).toBe("auto");
    // Record spend, then a charge that would exceed → ask.
    recordSpend(v, 80);
    expect(monthSpendUsd(v)).toBe(80);
    expect(gateAction("pay the $40 invoice", { vault: v, autonomousActs: true }).decision).toBe("ask");
  });
});
