import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// End-to-end smoke against the compiled binary: spawn `prevail mcp`, send
// initialize + tools/list, verify the JSON-RPC responses come back over
// stdout and the tool catalog includes our 5 tools. Skipped if the
// compiled binary isn't built yet (saves CI from needing a full build
// step before running tests).
//
// The binary now (a) requires a token on every non-initialize request
// and (b) refuses to run from non-TTY / unknown parents — `bun test`
// triggers both gates. We sidestep with --unsafe-detach (parent check)
// and by reading the auto-generated token out of mcp.json before sending
// tools/list. PREVAIL_CONFIG_DIR redirects mcp.json into a tmpdir so we
// don't trample the user's real token.
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
    const cfgDir = mkdtempSync(join(tmpdir(), "prevail-mcp-cfg-"));
    const child = spawn(BIN, ["mcp", "--vault", vault, "--unsafe-detach"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PREVAIL_CONFIG_DIR: cfgDir },
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
    // Wait for the server to materialize mcp.json (lazy on startup),
    // then read the token and send the authenticated tools/list. A short
    // poll is cleaner than racing initialize's reply.
    const tokenPath = join(cfgDir, "mcp.json");
    const tokenDeadline = Date.now() + 8000;
    let token = "";
    while (Date.now() < tokenDeadline) {
      try {
        const cfg = JSON.parse(readFileSync(tokenPath, "utf8"));
        if (typeof cfg.token === "string" && cfg.token.length > 0) {
          token = cfg.token;
          break;
        }
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(token.length).toBeGreaterThan(0);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: { _meta: { authorization: `prevail-${token}` } },
      }) + "\n",
    );
    // Poll for the two expected responses with a generous ceiling. Binary
    // cold-start under bun --compile takes longer than a same-process call.
    const deadline = Date.now() + 8000;
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
