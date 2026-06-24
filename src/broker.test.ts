import { describe, it, expect } from "bun:test";
import { decideAction } from "./broker.ts";

describe("decideAction — C1 broker policy (taxonomy + autonomy gate)", () => {
  it("never auto-executes a consequential action, even with autonomy ON", () => {
    const d = decideAction("Pay the $200 invoice", { autonomousActs: true });
    expect(d.cls).toBe("financial");
    expect(d.mayAutoExecute).toBe(false);
  });
  it("auto-executes a reversible action only when autonomy is opted in", () => {
    expect(decideAction("Draft a note", { autonomousActs: true }).mayAutoExecute).toBe(true);
    expect(decideAction("Draft a note", { autonomousActs: false }).mayAutoExecute).toBe(false);
  });
});
