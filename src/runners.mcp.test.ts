import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runSkillMcp } from "./runners.ts";

const TMP = process.platform === "darwin" ? "/tmp" : require("node:os").tmpdir();
const ROOT = join(TMP, `prevail-mcp-${process.pid}`);
const conn = join(ROOT, "connector");

// A minimal mock MCP server: JSON-RPC over stdio (initialize + tools/call).
function writeMock(): string {
  mkdirSync(conn, { recursive: true });
  const p = join(ROOT, "mock-mcp.mjs");
  writeFileSync(p, [
    "#!/usr/bin/env bun",
    "let buf='';",
    "process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;let m;try{m=JSON.parse(line)}catch{continue}",
    " if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'mock'}}})+'\\n');",
    " else if(m.method==='tools/call')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'===SUMMARY===\\nmock returned '+(m.params&&m.params.arguments&&m.params.arguments.q||'?')+'\\n'}]}})+'\\n');",
    "}});",
  ].join("\n"));
  chmodSync(p, 0o755);
  return p;
}

function skill(mcpPath: string) {
  return {
    id: "t", filePath: join(conn, "skills/t.md"), runner: "mcp" as const, auth: [], inputs: [],
    outputs: [{ path: "out.md", kind: "replace" as const }], description: "", connectorId: "t",
    connectorDir: conn, extra: { mcp_command: mcpPath, tool: "search", args: '{"q":"hello"}', save: "out.md" },
  };
}

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("runSkillMcp", () => {
  test("initialize + tools/call against a mock MCP server, writes output", async () => {
    const mock = writeMock();
    const r = await runSkillMcp(skill(mock) as Parameters<typeof runSkillMcp>[0], {}, {});
    expect(r.ok).toBe(true);
    expect(r.raw).toContain("mock returned hello");
    expect(existsSync(join(conn, "data/out.md"))).toBe(true);
    expect(readFileSync(join(conn, "data/out.md"), "utf8")).toContain("mock returned hello");
  });

  test("refuses unsafe mcp_command", async () => {
    const s = skill("../evil"); s.extra.mcp_command = "../evil";
    const r = await runSkillMcp(s as Parameters<typeof runSkillMcp>[0], {}, {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain("unsafe");
  });

  test("missing mcp_command/tool errors", async () => {
    const s = skill("x"); s.extra = { mcp_command: "", tool: "", args: "", save: "" } as typeof s.extra;
    const r = await runSkillMcp(s as Parameters<typeof runSkillMcp>[0], {}, {});
    expect(r.ok).toBe(false);
  });
});
