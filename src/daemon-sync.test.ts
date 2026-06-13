import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  syncOnce, syncApp, refreshToCron, globMatch, readSyncState, looksLikeSecretFile,
  type SyncConfig,
} from "./daemon-sync.ts";

// A self-contained world: a vault with two domains and one user-installed
// connector that uses the generic CLI pattern (no app-specific code anywhere).
// NOTE: macOS tmpdir() is /var/folders/... which validateVaultPath correctly
// forbids (no vault under /var). Use /tmp there so the seeded vault is in a
// location scanVault will actually accept; Linux tmpdir() is already /tmp.
const TMP_BASE = process.platform === "darwin" ? "/tmp" : tmpdir();
const ROOT = join(TMP_BASE, `prevail-sync-${process.pid}`);
const VAULT = join(ROOT, "vault");
const APPS = join(ROOT, "apps");

function seedWorld(opts: { command?: string; refresh?: object; routes?: object[]; failProbe?: boolean } = {}) {
  rmSync(ROOT, { recursive: true, force: true });
  for (const d of ["wealth", "insurance"]) {
    mkdirSync(join(VAULT, d), { recursive: true });
    writeFileSync(join(VAULT, d, "soul.md"), `# ${d}\n`);
  }
  const app = join(APPS, "demo-bank");
  mkdirSync(join(app, "skills", "pull"), { recursive: true });
  mkdirSync(join(app, "data"), { recursive: true });
  writeFileSync(join(app, "SKILL.md"), "# Demo bank\n");
  writeFileSync(join(app, "manifest.json"), JSON.stringify({
    id: "demo-bank",
    name: "Demo Bank",
    domains: ["wealth", "insurance"],
    integration: "api",
    auth_check: opts.failProbe
      ? { kind: "file-exists", paths: [join(app, "auth", "definitely-missing")] }
      : { kind: "file-exists", paths: [join(app, "manifest.json")] },
    refresh: opts.refresh ?? { every: "daily", at: "02:00", skill: "pull" },
    autonomy: "read-only",
    account: { label: "demo" },
    ...(opts.routes ? { routes: opts.routes } : {}),
  }));
  writeFileSync(join(app, "connection-status.json"), JSON.stringify({ status: "connected" }));
  writeFileSync(join(app, "skills", "pull", "SKILL.md"), [
    "---",
    "id: pull",
    "runner: cli",
    opts.command ?? 'command: printf "===SUMMARY===\\n2 statements downloaded\\n" && printf "st1" > data/statement-jun.pdf && printf "x" > data/token.txt',
    "outputs:",
    "  - path: data/run-${date}.log",
    "    kind: replace",
    "---",
    "Pull statements.",
  ].join("\n"));
  process.env.PREVAIL_APPS_DIR = APPS;
}

const CFG: SyncConfig = { vaultPath: VAULT, tickSec: 60, maxRunsPerTick: 5 };
const appShim = () => ({ path: join(APPS, "demo-bank") }) as Parameters<typeof readSyncState>[0];

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.PREVAIL_APPS_DIR;
});

describe("refreshToCron", () => {
  test("interval hours", () => expect(refreshToCron({ every: "6h" })).toBe("0 */6 * * *"));
  test("daily at time", () => expect(refreshToCron({ every: "daily", at: "07:30" })).toBe("30 7 * * *"));
  test("weekly on day", () => {
    const cron = refreshToCron({ every: "weekly", on: "fri", at: "17:00" });
    expect(cron).toContain("17");
    expect(cron?.endsWith("5") || cron?.includes("fri")).toBe(true);
  });
});

describe("globMatch", () => {
  test("** crosses dirs, * does not", () => {
    expect(globMatch("data/attachments/**/*.pdf", "data/attachments/2026/lease.pdf")).toBe(true);
    expect(globMatch("data/*.pdf", "data/sub/lease.pdf")).toBe(false);
    expect(globMatch("data/*.pdf", "data/lease.pdf")).toBe(true);
  });
});

describe("looksLikeSecretFile", () => {
  test("blocks credential-shaped names", () => {
    expect(looksLikeSecretFile("data/token.txt")).toBe(true);
    expect(looksLikeSecretFile("auth/refresh-token.json")).toBe(true);
    expect(looksLikeSecretFile("data/statement-jun.pdf")).toBe(false);
  });
});

describe("syncOnce (pattern-agnostic end to end)", () => {
  beforeEach(() => seedWorld());

  test("runs a due cli connector, routes intents to all domains, advances state", async () => {
    const r = await syncOnce(CFG);
    expect(r.ran).toBe(1);
    expect(r.ok).toBe(1);

    // Intent records landed in BOTH domains with the summary + app identity.
    for (const d of ["wealth", "insurance"]) {
      const ledger = readFileSync(join(VAULT, d, "_intents.jsonl"), "utf8").trim();
      const rec = JSON.parse(ledger.split("\n").pop()!);
      expect(rec.kind).toBe("intent");
      expect(rec.source).toBe("sync");
      expect(rec.app).toBe("demo-bank");
      expect(rec.message).toContain("2 statements downloaded");
    }

    // Sync state advanced: ok, cursor file exists, next_due in the future.
    const st = readSyncState(appShim());
    expect(st.last_run_ok).toBe(true);
    expect(st.consecutive_failures).toBe(0);
    expect(st.next_due_ts).toBeGreaterThan(Date.now());
    expect(st.runs.length).toBe(1);

    // connection-status mirrored.
    const conn = JSON.parse(readFileSync(join(APPS, "demo-bank", "connection-status.json"), "utf8"));
    expect(conn.status).toBe("connected");
  });

  test("not due again until next_due_ts passes (cursor idempotency)", async () => {
    await syncOnce(CFG);
    const again = await syncOnce(CFG);
    expect(again.ran).toBe(0);
  });

  test("syncApp runs one app on demand (ignores schedule) and routes", async () => {
    const r = await syncApp(CFG, "demo-bank");
    expect(r.ok).toBe(true);
    const ledger = readFileSync(join(VAULT, "wealth", "_intents.jsonl"), "utf8");
    expect(ledger).toContain("demo-bank");
    const missing = await syncApp(CFG, "no-such-app");
    expect(missing.ok).toBe(false);
  });

  test("copy routes place artifacts into <domain>/imports with sidecar, secrets filtered", async () => {
    seedWorld({ routes: [{ match: "data/**", domain: "wealth", copy: true }] });
    await syncOnce(CFG);
    // The pdf artifact was declared via outputs only (run log). The skill also
    // wrote statement-jun.pdf + token.txt directly, but artifacts[] only
    // carries declared outputs — run log matches data/** and is copied.
    const imports = join(VAULT, "wealth", "imports");
    expect(existsSync(imports)).toBe(true);
    const files = (await import("node:fs")).readdirSync(imports);
    expect(files.some((f) => f.startsWith("demo-bank-") && !f.endsWith(".meta.json"))).toBe(true);
    expect(files.some((f) => f.endsWith(".meta.json"))).toBe(true);
    expect(files.some((f) => /token/.test(f))).toBe(false);
  });

  test("failure increments, elevates ONCE into _tasks.md at 3 strikes, dedupes", async () => {
    seedWorld({ command: "command: exit 7", refresh: { every: "daily", skill: "pull" } });
    for (let i = 0; i < 4; i++) {
      // Force due each pass.
      const stPath = join(APPS, "demo-bank", "sync-state.json");
      if (existsSync(stPath)) {
        const st = JSON.parse(readFileSync(stPath, "utf8"));
        st.next_due_ts = Date.now() - 1000;
        writeFileSync(stPath, JSON.stringify(st));
      }
      await syncOnce(CFG);
    }
    const st = readSyncState(appShim());
    expect(st.consecutive_failures).toBeGreaterThanOrEqual(3);
    expect(st.elevated).toBe(true);
    for (const d of ["wealth", "insurance"]) {
      const tasks = readFileSync(join(VAULT, d, "_tasks.md"), "utf8");
      const matches = tasks.match(/Fix demo-bank sync/g) ?? [];
      expect(matches.length).toBe(1); // elevated once, deduped across passes
    }
  });

  test("dead auth probe marks expired and never runs the skill", async () => {
    seedWorld({ failProbe: true });
    const r = await syncOnce(CFG);
    expect(r.failed).toBe(1);
    const st = readSyncState(appShim());
    expect(st.last_error).toContain("auth");
    // The skill never ran: no run log output was produced.
    expect(existsSync(join(APPS, "demo-bank", "data", `run-${new Date().toISOString().slice(0, 10)}.log`))).toBe(false);
    const conn = JSON.parse(readFileSync(join(APPS, "demo-bank", "connection-status.json"), "utf8"));
    expect(conn.status).toBe("expired");
  });

  test("apps without a refresh block are ignored", async () => {
    seedWorld({ refresh: undefined });
    // Overwrite manifest without refresh.
    const mPath = join(APPS, "demo-bank", "manifest.json");
    const m = JSON.parse(readFileSync(mPath, "utf8"));
    delete m.refresh;
    writeFileSync(mPath, JSON.stringify(m));
    const r = await syncOnce(CFG);
    expect(r.ran).toBe(0);
  });
});
