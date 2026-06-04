import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeConnector } from "./connector-probe.ts";
import type { AppSkill } from "./vault.ts";

const fakeApp = (id: string): AppSkill => ({
  id,
  title: id,
  description: "",
  domains: [],
  path: "/tmp",
  hasState: false,
  openLoopCount: 0,
  stateMtime: null,
  skills: [],
  community: true,
  integration: "api",
  status: "not-configured",
  lastSuccessTs: null,
  configured: false,
});

describe("probeConnector — env-keys kind", () => {
  test("all keys present → connected", async () => {
    process.env.PROBE_TEST_KEY_1 = "x";
    process.env.PROBE_TEST_KEY_2 = "y";
    try {
      const r = await probeConnector(fakeApp("envtest"), {
        kind: "env-keys",
        env_keys: ["PROBE_TEST_KEY_1", "PROBE_TEST_KEY_2"],
      });
      expect(r.status).toBe("connected");
      expect(r.ok).toBe(true);
    } finally {
      delete process.env.PROBE_TEST_KEY_1;
      delete process.env.PROBE_TEST_KEY_2;
    }
  });

  test("missing key → not-configured + names what's missing", async () => {
    process.env.PROBE_TEST_KEY_A = "x";
    delete process.env.PROBE_TEST_KEY_B;
    try {
      const r = await probeConnector(fakeApp("envtest"), {
        kind: "env-keys",
        env_keys: ["PROBE_TEST_KEY_A", "PROBE_TEST_KEY_B"],
      });
      expect(r.status).toBe("not-configured");
      expect(r.missing).toEqual(["PROBE_TEST_KEY_B"]);
      expect(r.fixHint).toBeDefined();
    } finally {
      delete process.env.PROBE_TEST_KEY_A;
    }
  });
});

describe("probeConnector — file-exists kind", () => {
  test("all files present → connected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    const f = join(dir, "token");
    writeFileSync(f, "x");
    const r = await probeConnector(fakeApp("filetest"), {
      kind: "file-exists",
      files: [f],
    });
    expect(r.status).toBe("connected");
  });

  test("missing file → not-configured + lists the missing one", async () => {
    const r = await probeConnector(fakeApp("filetest"), {
      kind: "file-exists",
      files: ["/tmp/definitely-not-a-real-file-12345"],
    });
    expect(r.status).toBe("not-configured");
    expect(r.missing?.length).toBe(1);
  });
});

describe("probeConnector — http kind", () => {
  test("no auth_header_env set when required → not-configured", async () => {
    delete process.env.NON_EXISTENT_HTTP_KEY;
    const r = await probeConnector(fakeApp("httptest"), {
      kind: "http",
      url: "https://api.github.com/user",
      auth_header_env: "NON_EXISTENT_HTTP_KEY",
    });
    expect(r.status).toBe("not-configured");
    expect(r.missing).toEqual(["NON_EXISTENT_HTTP_KEY"]);
  });

  test("metadata URLs are refused (SSRF guard)", async () => {
    const r = await probeConnector(fakeApp("ssrftest"), {
      kind: "http",
      url: "http://169.254.169.254/latest/meta-data/",
    });
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/refusing/i);
  });
});

describe("probeConnector — no auth_check declared", () => {
  test("returns not-configured with hint to add auth_check", async () => {
    const r = await probeConnector(fakeApp("notest"), null);
    expect(r.status).toBe("not-configured");
    expect(r.fixHint).toMatch(/auth_check/);
  });
});
