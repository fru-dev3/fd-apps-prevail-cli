import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  syncOnce, syncApp, refreshToCron, refreshIntervalMs, nextRefreshDue, globMatch, readSyncState, looksLikeSecretFile, backoffNextDue,
  producedRealData,
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

function seedWorld(opts: { command?: string; refresh?: object; routes?: object[]; failProbe?: boolean; noOutputs?: boolean } = {}) {
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
    // The fetch gate test needs a run that produces NO artifact and NO payload;
    // omit the declared output so artifacts[] stays empty.
    ...(opts.noOutputs ? [] : [
      "outputs:",
      "  - path: data/run-${date}.log",
      "    kind: replace",
    ]),
    "---",
    "Pull statements.",
  ].join("\n"));
  process.env.PREVAIL_APPS_DIR = APPS;
}

// Rewrite ONLY the skill to a clean-but-empty command, leaving sync-state.json
// (and its latched first_fetch_ok) intact, for asserting the latch holds across
// a later "nothing new" run.
function seedWorldEmptyKeepState() {
  writeFileSync(join(APPS, "demo-bank", "skills", "pull", "SKILL.md"), [
    "---", "id: pull", "runner: cli", 'command: printf ""', "---", "Pull nothing new.",
  ].join("\n"));
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
  // Multi-day / multi-week cadences are interval-based, NOT cron, so
  // refreshToCron returns null for them and refreshIntervalMs carries the ms.
  test("multi-day/week are not cron", () => {
    expect(refreshToCron({ every: "2d" })).toBeNull();
    expect(refreshToCron({ every: "1w" })).toBeNull();
  });
});

describe("refreshIntervalMs", () => {
  const DAY = 24 * 3600_000;
  test("every other day = 2*24h", () => expect(refreshIntervalMs({ every: "2d" })).toBe(2 * DAY));
  test("1d = 24h", () => expect(refreshIntervalMs({ every: "1d" })).toBe(DAY));
  test("90d = 90*24h", () => expect(refreshIntervalMs({ every: "90d" })).toBe(90 * DAY));
  test("1w = 7*24h", () => expect(refreshIntervalMs({ every: "1w" })).toBe(7 * DAY));
  test("2w = 14*24h", () => expect(refreshIntervalMs({ every: "2w" })).toBe(14 * DAY));
  test("cron cadences yield null", () => {
    expect(refreshIntervalMs({ every: "hourly" })).toBeNull();
    expect(refreshIntervalMs({ every: "6h" })).toBeNull();
    expect(refreshIntervalMs({ every: "daily" })).toBeNull();
    expect(refreshIntervalMs({ every: "weekly" })).toBeNull();
  });
});

describe("nextRefreshDue", () => {
  const DAY = 24 * 3600_000;
  const now = 1_700_000_000_000;
  test("2d advances from last run by 2 days", () =>
    expect(nextRefreshDue({ every: "2d" }, now, now)).toBe(now + 2 * DAY));
  test("1w advances from last run by 7 days", () =>
    expect(nextRefreshDue({ every: "1w" }, now, now)).toBe(now + 7 * DAY));
  test("interval anchors on lastRunTs, not now", () =>
    expect(nextRefreshDue({ every: "1d" }, now, now - DAY)).toBe(now));
  test("first run (null lastRun) anchors on now", () =>
    expect(nextRefreshDue({ every: "3d" }, now, null)).toBe(now + 3 * DAY));
  // "daily"/"weekly" stay cron-driven. nextRunWithin resolves against the real
  // clock, so anchor the bound on real Date.now(): the next daily slot is always
  // within ~24h, and weekly within ~7d.
  test("daily still resolves within ~24h via cron", () => {
    const real = Date.now();
    const due = nextRefreshDue({ every: "daily", at: "07:30" }, real, real);
    expect(due).toBeGreaterThan(real);
    expect(due).toBeLessThanOrEqual(real + DAY + 1000);
  });
  test("weekly still resolves within ~7d via cron", () => {
    const real = Date.now();
    const due = nextRefreshDue({ every: "weekly", on: "fri", at: "17:00" }, real, real);
    expect(due).toBeGreaterThan(real);
    expect(due).toBeLessThanOrEqual(real + 7 * DAY + 1000);
  });
});

describe("backoffNextDue", () => {
  test("no backoff when not failing; grows then caps on repeated failures", () => {
    const base = 1000;
    expect(backoffNextDue(base, 0, 0)).toBe(base); // success → cron time
    expect(backoffNextDue(0, 0, 1)).toBe(10 * 60_000); // 2^1 * 5min
    expect(backoffNextDue(0, 0, 2)).toBe(20 * 60_000);
    expect(backoffNextDue(0, 0, 20)).toBe(6 * 3600_000); // capped at 6h
    expect(backoffNextDue(9_999_999_999, 0, 5)).toBe(9_999_999_999); // never earlier than base
  });
});

describe("globMatch", () => {
  test("** crosses dirs, * does not", () => {
    expect(globMatch("data/attachments/**/*.pdf", "data/attachments/2026/lease.pdf")).toBe(true);
    expect(globMatch("data/*.pdf", "data/sub/lease.pdf")).toBe(false);
    expect(globMatch("data/*.pdf", "data/lease.pdf")).toBe(true);
  });
});

describe("producedRealData (the fetch-gate predicate)", () => {
  const base = { ok: true, message: "", outputsWritten: [], durationMs: 1 };
  test("an artifact counts as real data", () => {
    expect(producedRealData({ ...base }, ["data/x.json"])).toBe(true);
  });
  test("a non-empty payload counts even with no artifact", () => {
    expect(producedRealData({ ...base, raw: '{"items":[1]}' }, [])).toBe(true);
  });
  test("clean run with no artifact and empty payload is NOT real data", () => {
    expect(producedRealData({ ...base, raw: "" }, [])).toBe(false);
    expect(producedRealData({ ...base, raw: "   \n" }, [])).toBe(false);
    expect(producedRealData({ ...base }, [])).toBe(false);
  });
  test("empty-shaped JSON payloads are NOT real data", () => {
    for (const raw of ["[]", "{}", "null", '""', "[ ]", "{ }"]) {
      expect(producedRealData({ ...base, raw }, [])).toBe(false);
    }
  });
  test("auth-challenge / error / help responses are NOT real data (the Credit Karma bug)", () => {
    const bad = [
      "You are not authenticated. Please log in to continue.",
      "Error: 401 Unauthorized",
      "Please sign in to your account first",
      '{"error":"unauthorized"}',
      '{"status":"error","message":"invalid token"}',
      '{"authenticated":false}',
      "usage: creditkarma-mcp [options]",
      "No transactions found yet.",
      "Sign in to Airbnb to continue",
    ];
    for (const raw of bad) {
      expect(producedRealData({ ...base, raw }, [])).toBe(false);
      // and even if it wrote a (likely empty) file, an auth/error response still fails.
      expect(producedRealData({ ...base, raw }, ["data/out.json"])).toBe(false);
    }
  });
  test("genuine authenticated data IS real (and survives the word 'error' deep inside)", () => {
    expect(producedRealData({ ...base, raw: '[{"merchant":"Acme","amount":42}]' }, [])).toBe(true);
    expect(producedRealData({ ...base, raw: '{"score":712,"accounts":[{"name":"Checking"}]}' }, [])).toBe(true);
    expect(producedRealData({ ...base, raw: "Statement for June: 14 transactions, no error flags." }, [])).toBe(true);
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

  // The fetch gate: a skill that runs CLEANLY but pulls no data must NOT go
  // green. It stays "configured" (authorized · verifying), first_fetch_ok false,
  // and syncApp reports ok:false so the connect flow doesn't claim "verified".
  test("clean run with no data stays 'configured', never 'connected' (fetch gate)", async () => {
    seedWorld({ command: 'command: printf ""', noOutputs: true, refresh: { every: "daily", skill: "pull" } });
    const r = await syncApp(CFG, "demo-bank");
    expect(r.ok).toBe(false);
    expect(r.artifacts).toBe(0);
    const st = readSyncState(appShim());
    expect(st.last_run_ok).toBe(true);       // the skill itself ran fine
    expect(st.first_fetch_ok).toBe(false);   // but it never fetched real data
    expect(st.last_ok_ts).toBeNull();        // lastSuccessTs must not advance
    const conn = JSON.parse(readFileSync(join(APPS, "demo-bank", "connection-status.json"), "utf8"));
    expect(conn.status).toBe("configured");
  });

  // Once a sync DOES pull data, first_fetch_ok latches true and the app is
  // connected, and a later "nothing new" run keeps it connected (not amber).
  test("first real fetch latches connected; later empty run stays connected", async () => {
    seedWorld({ refresh: { every: "daily", skill: "pull" } }); // default skill writes a run-log artifact
    const first = await syncApp(CFG, "demo-bank");
    expect(first.ok).toBe(true);
    let st = readSyncState(appShim());
    expect(st.first_fetch_ok).toBe(true);
    expect(st.first_fetch_ts).toBeGreaterThan(0);

    // Re-point the skill at a clean-but-empty command; the latch must hold.
    seedWorldEmptyKeepState();
    const second = await syncApp(CFG, "demo-bank");
    expect(second.ok).toBe(true);            // still connected (latched)
    st = readSyncState(appShim());
    expect(st.first_fetch_ok).toBe(true);
    const conn = JSON.parse(readFileSync(join(APPS, "demo-bank", "connection-status.json"), "utf8"));
    expect(conn.status).toBe("connected");
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

  test("connections[] selects the skill from the first passing connection", async () => {
    // Seed with two connection entries: first fails (missing env key), second passes.
    // The second connection points to a separate skill that emits a distinct marker.
    seedWorld();
    const appDir = join(APPS, "demo-bank");
    // Write a second skill: pull-alt that outputs a DIFFERENT summary.
    mkdirSync(join(appDir, "skills", "pull-alt"), { recursive: true });
    writeFileSync(join(appDir, "skills", "pull-alt", "SKILL.md"), [
      "---",
      "id: pull-alt",
      "runner: cli",
      'command: printf "===SUMMARY===\\nalt-skill ran\\n"',
      "outputs:",
      "  - path: alt-run.log",
      "    kind: replace",
      "---",
      "Alt skill.",
    ].join("\n"));
    // Update manifest: add connections[] that prefers a missing env key first.
    const mPath = join(appDir, "manifest.json");
    const m = JSON.parse(readFileSync(mPath, "utf8"));
    m.connections = [
      {
        kind: "api",
        auth_check: { kind: "env-keys", env_keys: ["DEFINITELY_MISSING_KEY_ABC"] },
        skill: "pull",
      },
      {
        kind: "cli",
        auth_check: { kind: "file-exists", paths: [mPath] },
        skill: "pull-alt",
      },
    ];
    writeFileSync(mPath, JSON.stringify(m));
    const r = await syncOnce(CFG);
    expect(r.ran).toBe(1);
    expect(r.ok).toBe(1);
    // The intent should contain "alt-skill ran" (from pull-alt), NOT "2 statements downloaded"
    const ledger = readFileSync(join(VAULT, "wealth", "_intents.jsonl"), "utf8").trim();
    const rec = JSON.parse(ledger.split("\n").pop()!);
    expect(rec.message).toContain("alt-skill ran");
  });
});
