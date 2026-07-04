import { describe, expect, test } from "bun:test";
import {
  parseClaudeLocalConfig,
  parseClaudeMcpList,
  parseCodexConfig,
  parseGeminiSettings,
  scanHarnessConnections,
  matchAppConnections,
} from "./harness-connections.ts";

// The superset registry: three vendors' formats normalize into one inventory,
// account connectors carry live health, and app matching bridges the naming
// differences ("paypal" app <-> "claude.ai PayPal" connector).
describe("harness connections registry", () => {
  test("claude local config: stdio + http servers", () => {
    const c = parseClaudeLocalConfig(JSON.stringify({
      mcpServers: { prevail: { type: "stdio", command: "/x/prevail" }, hub: { type: "http", url: "https://h/mcp" } },
    }));
    expect(c.length).toBe(2);
    expect(c.find((x) => x.id === "prevail")!.transport).toBe("stdio");
    expect(c.find((x) => x.id === "hub")!.url).toBe("https://h/mcp");
  });

  test("claude mcp list: account connectors with health, incl. degraded", () => {
    const text = [
      "Checking MCP server health…",
      "",
      "claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected",
      "claude.ai PayPal: https://mcp.paypal.com/mcp - ! Connected · tools fetch failed",
      "claude.ai Plaid Developer Tools: https://api.dashboard.plaid.com/mcp/sse - ✔ Connected",
    ].join("\n");
    const c = parseClaudeMcpList(text);
    expect(c.length).toBe(3);
    const paypal = c.find((x) => x.name === "PayPal")!;
    expect(paypal.source).toBe("account");
    expect(paypal.health).toBe("degraded");
    expect(c.find((x) => x.name === "Notion")!.health).toBe("healthy");
    expect(c.find((x) => x.name === "Plaid Developer Tools")!.transport).toBe("sse");
  });

  test("codex config.toml: server blocks found, tool sub-tables ignored", () => {
    const toml = [
      "[mcp_servers.prevail]",
      'command = "/x/prevail"',
      'args = ["mcp"]',
      "",
      "[mcp_servers.prevail.tools.chat]",
      'approval_mode = "approve"',
      "",
      "[mcp_servers.linear]",
      'url = "https://mcp.linear.app/sse"',
    ].join("\n");
    const c = parseCodexConfig(toml);
    expect(c.map((x) => x.id).sort()).toEqual(["linear", "prevail"]);
    expect(c.find((x) => x.id === "prevail")!.transport).toBe("stdio");
    expect(c.find((x) => x.id === "linear")!.transport).toBe("sse");
  });

  test("gemini settings.json mcpServers", () => {
    const c = parseGeminiSettings(JSON.stringify({ mcpServers: { notion: { httpUrl: "https://mcp.notion.com/mcp" } } }));
    expect(c.length).toBe(1);
    expect(c[0]).toMatchObject({ harness: "gemini", id: "notion", transport: "http" });
  });

  test("scan merges all sources; live claude list supersedes config dupes", () => {
    const scan = scanHarnessConnections({
      readFile: (p) => {
        if (p.endsWith(".claude.json")) return JSON.stringify({ mcpServers: { prevail: { type: "stdio", command: "/x" } } });
        if (p.endsWith("config.toml")) return "[mcp_servers.prevail]\ncommand = \"/x\"\n";
        if (p.endsWith("settings.json")) return JSON.stringify({ mcpServers: {} });
        return null;
      },
      runClaudeMcpList: () => "claude.ai PayPal: https://mcp.paypal.com/mcp - ✔ Connected",
    });
    expect(scan.connections.filter((c) => c.harness === "claude").length).toBe(2); // local prevail + account paypal
    expect(scan.connections.filter((c) => c.harness === "codex").length).toBe(1);
    expect(scan.notes.some((n) => n.includes("Codex session"))).toBe(true);
  });

  test("app matching bridges vendor naming", () => {
    const scan = { notes: [], connections: parseClaudeMcpList("claude.ai PayPal: https://mcp.paypal.com/mcp - ✔ Connected\nclaude.ai Intuit QuickBooks: https://q/mcp - ✔ Connected") };
    expect(matchAppConnections("paypal", "PayPal", scan).length).toBe(1);
    expect(matchAppConnections("quickbooks", "QuickBooks", scan).length).toBe(1);
    expect(matchAppConnections("chase", "Chase", scan).length).toBe(0);
  });
});
