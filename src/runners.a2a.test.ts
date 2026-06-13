import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runSkillA2a, isUnsafeRemoteUrl } from "./runners.ts";

const TMP = process.platform === "darwin" ? "/tmp" : require("node:os").tmpdir();
const conn = join(TMP, `prevail-a2a-${process.pid}`);
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; rmSync(conn, { recursive: true, force: true }); });

function skill(extra: Record<string, unknown>) {
  return { id: "t", filePath: join(conn, "t.md"), runner: "a2a" as const, auth: [], inputs: [],
    outputs: [{ path: "out.md", kind: "replace" as const }], description: "", connectorId: "t", connectorDir: conn, extra };
}

describe("isUnsafeRemoteUrl", () => {
  test("blocks non-https, localhost, and private ranges", () => {
    expect(isUnsafeRemoteUrl("http://x.com")).toBe(true);
    expect(isUnsafeRemoteUrl("https://localhost/rpc")).toBe(true);
    expect(isUnsafeRemoteUrl("https://127.0.0.1/rpc")).toBe(true);
    expect(isUnsafeRemoteUrl("https://10.0.0.5/rpc")).toBe(true);
    expect(isUnsafeRemoteUrl("https://192.168.1.2/rpc")).toBe(true);
    expect(isUnsafeRemoteUrl("https://mcp.example.com/rpc")).toBe(false);
  });
});

describe("runSkillA2a", () => {
  test("POSTs JSON-RPC tools/call, parses content, writes output", async () => {
    mkdirSync(conn, { recursive: true });
    let captured: { url: string; body: unknown } | null = null;
    globalThis.fetch = (async (url: string, init: { body?: string }) => {
      captured = { url, body: JSON.parse(init.body ?? "{}") };
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "remote says hi" }] } }) };
    }) as unknown as typeof fetch;
    const r = await runSkillA2a(skill({ mcp_url: "https://mcp.example.com/rpc", tool: "search", args: '{"q":"x"}', save: "out.md" }) as Parameters<typeof runSkillA2a>[0], {}, {});
    expect(r.ok).toBe(true);
    expect(r.raw).toContain("remote says hi");
    expect(existsSync(join(conn, "data/out.md"))).toBe(true);
    expect(readFileSync(join(conn, "data/out.md"), "utf8")).toContain("remote says hi");
    const b = captured!.body as { method: string; params: { name: string } };
    expect(b.method).toBe("tools/call");
    expect(b.params.name).toBe("search");
  });

  test("refuses unsafe (internal) url without fetching", async () => {
    globalThis.fetch = (async () => { throw new Error("should not be called"); }) as unknown as typeof fetch;
    const r = await runSkillA2a(skill({ mcp_url: "https://127.0.0.1/rpc", tool: "search" }) as Parameters<typeof runSkillA2a>[0], {}, {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain("unsafe");
  });

  test("surfaces a JSON-RPC error", async () => {
    globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "nope" } }) })) as unknown as typeof fetch;
    const r = await runSkillA2a(skill({ mcp_url: "https://mcp.example.com/rpc", tool: "search" }) as Parameters<typeof runSkillA2a>[0], {}, {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain("error");
  });
});
