import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkContracts, contractBlock, foreignDomainOf, formatHandoff, ownerFor, parseContract, parseHandoff, readContracts } from "./agent-contract.ts";
import { scopeToolCall, scopedTools, toolAllowed } from "./mcp-scope.ts";
import { gateToolCall } from "./act-gate.ts";
import { routeMessage } from "./route.ts";

// Under home: scanVault refuses /var/folders vaults.
mkdirSync(join(homedir(), ".prevail-test-tmp"), { recursive: true });
const V = mkdtempSync(join(homedir(), ".prevail-test-tmp", "mesh-contract-"));
afterAll(() => rmSync(V, { recursive: true, force: true }));

const contract = (owns: string[], extra = "") => `---\nowns:\n${owns.map((o) => `  - ${o}`).join("\n")}\nhears: [home sales, new income]\nmay: [read, draft]\nhands_off_to: [orchard]\ntier: draft\n${extra}---\n# Notes\nKeep it short.\n`;

function seed() {
  for (const d of ["general", "orchard", "ledger", "harbor"]) mkdirSync(join(V, "data", "domains", d, "memory"), { recursive: true });
  mkdirSync(join(V, "build"), { recursive: true });
  writeFileSync(join(V, "data", "domains", "ledger", "agent.md"), contract(["estimated payments", "filing deadlines"]));
  writeFileSync(join(V, "data", "domains", "orchard", "agent.md"), contract(["apple harvest", "orchard equipment"]).replace("hands_off_to: [orchard]", "hands_off_to: [ledger]"));
}
seed();

describe("agent.md contracts", () => {
  test("parse: owns is required, tier falls back to draft", () => {
    const c = parseContract(contract(["a thing"]), "ledger")!;
    expect(c.owns).toEqual(["a thing"]);
    expect(c.hears).toEqual(["home sales", "new income"]);
    expect(c.tier).toBe("draft");
    expect(c.body).toContain("Keep it short");
    expect(parseContract("---\nhears: [x]\n---\n", "x")).toBeNull();
    expect(parseContract(contract(["a"], "").replace("tier: draft", "tier: everything"), "x")!.tier).toBe("draft");
  });

  test("one writer per fact: two owners of one thing is an issue", () => {
    expect(checkContracts(V)).toEqual([]);
    writeFileSync(join(V, "data", "domains", "harbor", "agent.md"), contract(["Estimated  payments"]).replace("hands_off_to: [orchard]", "hands_off_to: [nowhere]"));
    const issues = checkContracts(V);
    expect(issues.some((i) => i.includes("harbor and ledger"))).toBe(true);
    expect(issues.some((i) => i.includes('"nowhere"'))).toBe(true);
    rmSync(join(V, "data", "domains", "harbor", "agent.md"));
  });

  test("the declared owner wins; a tie or no match is left to a model", () => {
    const cs = readContracts(V);
    expect(ownerFor("When are my estimated payments due?", cs)?.domain).toBe("ledger");
    expect(ownerFor("the apple harvest and estimated payments", cs)).toBeNull();
    expect(ownerFor("what should I cook", cs)).toBeNull();
    expect(ownerFor("estimated payments", cs, ["orchard"])).toBeNull();
  });

  test("the generated block carries the contract and the handoff rule", () => {
    const b = contractBlock(readContracts(V).find((c) => c.domain === "ledger")!);
    expect(b).toContain("estimated payments");
    expect(b).toContain('starts "From ledger:"');
    expect(b).toContain("Approval tier: draft");
  });

  test("routing asks no model when a contract owns the subject", async () => {
    const r = await routeMessage({ vault: V, text: "check my filing deadlines", runner: async () => { throw new Error("no model call expected"); } });
    expect(r.source).toBe("contract");
    expect(r.domains[0]!.slug).toBe("ledger");
  });
});

describe("handoffs", () => {
  test("format and parse round trip, with the From prefix", () => {
    const t = formatHandoff({ from: "orchard", event: "Sold the old tractor", amount: "$4,200", date: "2026-09-30", source: "source/bill-of-sale.pdf" });
    expect(t).toBe("From orchard: Sold the old tractor | amount: $4,200 | date: 2026-09-30 | source: orchard/source/bill-of-sale.pdf");
    expect(parseHandoff(t)).toEqual({ from: "orchard", event: "Sold the old tractor", amount: "$4,200", date: "2026-09-30", source: "orchard/source/bill-of-sale.pdf" });
    expect(formatHandoff({ from: "orchard", event: "From orchard: already prefixed" })).toBe("From orchard: already prefixed");
    expect(() => formatHandoff({ from: "orchard", event: "x", date: "Sept 30" })).toThrow();
    expect(() => formatHandoff({ from: "orchard", event: "x", source: "../ledger/x" })).toThrow();
    expect(() => formatHandoff({ from: "orchard", event: "  " })).toThrow();
  });
});

describe("an agent writes only its own folder", () => {
  test("foreignDomainOf names the other domain, or null", () => {
    const own = join(V, "data", "domains", "orchard", "memory", "memory.md");
    const other = join(V, "data", "domains", "ledger", "memory", "tasks.md");
    expect(foreignDomainOf(V, "orchard", own)).toBeNull();
    expect(foreignDomainOf(V, "orchard", other)).toBe("ledger");
    expect(foreignDomainOf(V, "_mission-trip", other)).toBeNull();
    expect(foreignDomainOf(V, "orchard", join(V, "build", "x.md"))).toBeNull();
  });

  test("the act gate denies a Write into another domain even with Vault Lock off", () => {
    const d = gateToolCall(V, "orchard", "Write", { file_path: join(V, "data", "domains", "ledger", "memory", "memory.md"), content: "x" }, false);
    expect(d.action).toBe("deny");
    expect(d.reason).toContain('starts "From orchard:"');
    const ok = gateToolCall(V, "orchard", "Edit", { file_path: join(V, "data", "domains", "orchard", "memory", "memory.md") }, false);
    expect(ok.action).toBe("allow");
  });
});

describe("MCP domain scope", () => {
  test("a domain session gets its own tools, the chief of staff gets all", () => {
    expect(toolAllowed("orchard", "read_state")).toBe(true);
    expect(toolAllowed("orchard", "connect_app")).toBe(false);
    expect(toolAllowed("general", "connect_app")).toBe(true);
    expect(toolAllowed(null, "connect_app")).toBe(true);
    expect(scopedTools("orchard", [{ name: "read_state" }, { name: "sync_app" }]).map((t) => t.name)).toEqual(["read_state"]);
  });

  test("own domain forced, another domain refused, add_task elsewhere becomes a handoff", () => {
    const own = scopeToolCall(V, "orchard", "read_state", {});
    expect(own.ok && own.args.domain).toBe("orchard");
    const peek = scopeToolCall(V, "orchard", "read_memory", { domain: "ledger" });
    expect(peek.ok).toBe(false);
    const h = scopeToolCall(V, "orchard", "add_task", { domain: "ledger", text: "Sold the old tractor", amount: "$4,200", date: "2026-09-30" });
    expect(h.ok && h.args.text).toBe("From orchard: Sold the old tractor | amount: $4,200 | date: 2026-09-30");
    expect(scopeToolCall(V, "orchard", "chat", { prompt: "x", mission: "trip" }).ok).toBe(false);
    expect(scopeToolCall(V, "nowhere", "read_state", {}).ok).toBe(false);
    expect(scopeToolCall(V, "orchard", "sync_app", { id: "x" }).ok).toBe(false);
    const chief = scopeToolCall(V, "general", "read_memory", { domain: "ledger" });
    expect(chief.ok && chief.args.domain).toBe("ledger");
  });

  test("over the MCP dispatcher a scoped handoff lands in the owner's tasks and nowhere in the sender", async () => {
    const { dispatch, mcpTools } = await import("./mcp-server.ts");
    const call = (name: string, args: Record<string, unknown>) => dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, mcpTools(), V, "orchard");
    const r = (await call("add_task", { domain: "ledger", text: "Sold the old tractor", amount: "$4,200" })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toContain("Added to ledger");
    const { readTasks } = await import("./tasks.ts");
    expect(readTasks(join(V, "data", "domains", "ledger")).map((t) => t.text)).toContain("From orchard: Sold the old tractor | amount: $4,200");
    expect(readTasks(join(V, "data", "domains", "orchard"))).toEqual([]);
    // A v4 domain's board is memory/tasks.md; nothing splits it into a root _tasks.md.
    expect(existsSync(join(V, "data", "domains", "ledger", "memory", "tasks.md"))).toBe(true);
    expect(existsSync(join(V, "data", "domains", "ledger", "_tasks.md"))).toBe(false);
    await expect(call("update_task", { domain: "ledger", id: "x", status: "done" })).rejects.toThrow("reads and writes only orchard");
    const list = (await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" }, mcpTools(), V, "orchard")) as { tools: { name: string }[] };
    expect(list.tools.some((t) => t.name === "connect_app")).toBe(false);
  });
});

describe("the chief of staff watches open handoffs", () => {
  test("the weekly review counts open From lines per pair", async () => {
    const { handoffLine } = await import("./review.ts");
    const line = handoffLine(V);
    expect(line).toContain("orchard to ledger");
  });
});
