import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// mcp-config honors PREVAIL_CONFIG_DIR for tests because Node's
// os.homedir() is cached at process start on macOS — mutating HOME
// mid-process doesn't reroute the production configDir(). The env-var
// override is the test seam.

let savedDir: string | undefined;
let tmpDir: string;

beforeEach(() => {
  savedDir = process.env.PREVAIL_CONFIG_DIR;
  tmpDir = mkdtempSync(join(tmpdir(), "prevail-mcp-cfg-"));
  process.env.PREVAIL_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.PREVAIL_CONFIG_DIR;
  else process.env.PREVAIL_CONFIG_DIR = savedDir;
});

async function freshImport() {
  // Bun caches modules. A query suffix forces re-evaluation so each test
  // sees a clean module-level state.
  const stamp = Date.now() + Math.random();
  return await import(`./mcp-config.ts?t=${stamp}`);
}

describe("mcp-config", () => {
  test("readOrCreateMcpToken creates mcp.json with 0600 on first call", async () => {
    const mod = await freshImport();
    const token = mod.readOrCreateMcpToken();
    expect(typeof token).toBe("string");
    // 32 random bytes hex-encoded = 64 chars.
    expect(token.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
    const path: string = mod.mcpConfigPath();
    expect(path).toBe(join(tmpDir, "mcp.json"));
    expect(existsSync(path)).toBe(true);
    // chmod 0600 — the bottom 9 mode bits should read rw------- (0o600).
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.token).toBe(token);
    expect(typeof parsed.createdAt).toBe("string");
  });

  test("subsequent calls return the same token (persistence)", async () => {
    const mod = await freshImport();
    const first = mod.readOrCreateMcpToken();
    const second = mod.readOrCreateMcpToken();
    expect(second).toBe(first);
    // A second freshImport (i.e. simulated process restart) keeps the token.
    const mod2 = await freshImport();
    const third = mod2.readOrCreateMcpToken();
    expect(third).toBe(first);
  });

  test("malformed mcp.json regenerates instead of crashing", async () => {
    const mod = await freshImport();
    const original = mod.readOrCreateMcpToken();
    const path: string = mod.mcpConfigPath();
    writeFileSync(path, "{not json", "utf8");
    const recovered = mod.readOrCreateMcpToken();
    expect(typeof recovered).toBe("string");
    expect(recovered.length).toBe(64);
    expect(recovered).not.toBe(original);
    // And the file should now be valid again.
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.token).toBe(recovered);
  });

  test("mcp.json with no token field is treated as malformed", async () => {
    const mod = await freshImport();
    mod.readOrCreateMcpToken();
    const path: string = mod.mcpConfigPath();
    writeFileSync(path, JSON.stringify({ createdAt: "2026-01-01" }), "utf8");
    const recovered = mod.readOrCreateMcpToken();
    expect(typeof recovered).toBe("string");
    expect(recovered.length).toBe(64);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.token).toBe(recovered);
  });
});
