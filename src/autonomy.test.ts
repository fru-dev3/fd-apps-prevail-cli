import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVaultSession } from "./vault-session.ts";
import { getAutonomyState, setAutonomyState, setPolicyFor, getActionPolicy } from "./autonomy.ts";
import { gateAction } from "./broker.ts";

function freshVault(): string {
  const v = mkdtempSync(join(tmpdir(), "prevail-autonomy-"));
  mkdirSync(join(v, "_meta"), { recursive: true });
  return v;
}

describe("autonomy + gateAction — the global brake", () => {
  beforeEach(() => { initVaultSession({}); });

  it("defaults: active, money asks, destructive/credential never", () => {
    const v = freshVault();
    expect(getAutonomyState(v)).toBe("active");
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
});
