import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// End-to-end smoke against the compiled binary: spawn `prevail mcp`, send
// initialize + tools/list, verify the JSON-RPC responses come back over
// stdout and the tool catalog includes our 5 tools. Skipped if the
// compiled binary isn't built yet (saves CI from needing a full build
// step before running tests).
const BIN = join(import.meta.dir, "..", "dist", "prevail");

function makeFakeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "prevail-mcp-"));
  mkdirSync(join(dir, "wealth"), { recursive: true });
  writeFileSync(join(dir, "wealth", "state.md"), "# wealth\nactive items: 0");
  return dir;
}

describe("mcp-server (stdio)", () => {
  test("initialize + tools/list round-trip", async () => {
    if (!Bun.file(BIN).size) return; // binary not built — skip
    const vault = makeFakeVault();
    const child = spawn(BIN, ["mcp", "--vault", vault], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: string[] = [];
    let buffer = "";
    child.stdout.on("data", (b) => {
      buffer += b.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) out.push(line);
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    // Poll for the two expected responses with a generous ceiling. Binary
    // cold-start under bun --compile takes longer than a same-process call.
    const deadline = Date.now() + 5000;
    while (out.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    child.kill();
    await new Promise((r) => child.on("close", r));
    expect(out.length).toBeGreaterThanOrEqual(2);
    const init = JSON.parse(out[0]!);
    expect(init.result?.serverInfo?.name).toBe("prevail");
    expect(init.result?.protocolVersion).toBeDefined();
    const tools = JSON.parse(out[1]!);
    const names = tools.result?.tools?.map((t: { name: string }) => t.name) ?? [];
    expect(names).toContain("council");
    expect(names).toContain("chat");
    expect(names).toContain("list_domains");
    expect(names).toContain("read_state");
    expect(names).toContain("read_log");
  });
});
