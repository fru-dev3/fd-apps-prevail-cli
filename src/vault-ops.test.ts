import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupVault,
  parseDuration,
  pruneLog,
  restoreVault,
} from "./vault-ops.ts";

// ─────────────────────────────────────────────────────────────────────────
// parseDuration
// ─────────────────────────────────────────────────────────────────────────

describe("parseDuration", () => {
  test("30d → 30 days in ms", () => {
    expect(parseDuration("30d")).toBe(30 * 24 * 3600 * 1000);
  });
  test("1h → 1 hour in ms", () => {
    expect(parseDuration("1h")).toBe(3600 * 1000);
  });
  test("12h → 12 hours in ms", () => {
    expect(parseDuration("12h")).toBe(12 * 3600 * 1000);
  });
  test("90d → 90 days in ms", () => {
    expect(parseDuration("90d")).toBe(90 * 24 * 3600 * 1000);
  });
  test("1y → 365 days in ms", () => {
    expect(parseDuration("1y")).toBe(365 * 24 * 3600 * 1000);
  });
  test("compound 7d12h → combined ms", () => {
    expect(parseDuration("7d12h")).toBe(
      7 * 24 * 3600 * 1000 + 12 * 3600 * 1000,
    );
  });
  test("garbage throws", () => {
    expect(() => parseDuration("abc")).toThrow();
    expect(() => parseDuration("")).toThrow();
    expect(() => parseDuration("30")).toThrow();
    expect(() => parseDuration("d30")).toThrow();
    expect(() => parseDuration("30x")).toThrow();
    expect(() => parseDuration("30d garbage")).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// pruneLog — shared scaffold helper
// ─────────────────────────────────────────────────────────────────────────

function makeTempVault(): string {
  const root = mkdtempSync(join(tmpdir(), "prevail-vault-ops-"));
  // Build: <root>/wealth/{_log, _journal, state.md, ...}
  const wealth = join(root, "wealth");
  mkdirSync(join(wealth, "_log"), { recursive: true });
  mkdirSync(join(wealth, "_journal"), { recursive: true });
  mkdirSync(join(wealth, "skills"), { recursive: true });
  return root;
}

function touch(path: string, ageMs: number): void {
  writeFileSync(path, "stub content\n");
  const ts = (Date.now() - ageMs) / 1000;
  utimesSync(path, ts, ts);
}

describe("pruneLog", () => {
  test("dry-run reports old files without deleting", () => {
    const root = makeTempVault();
    const wealth = join(root, "wealth");
    const old = join(wealth, "_log", "2024-01-01.md");
    const fresh = join(wealth, "_log", "2026-06-01.md");
    touch(old, 365 * 24 * 3600 * 1000); // 1 year old
    touch(fresh, 1 * 24 * 3600 * 1000); // 1 day old

    const result = pruneLog({
      vaultPath: root,
      olderThanMs: 30 * 24 * 3600 * 1000,
      dryRun: true,
    });

    expect(result.files).toContain(old);
    expect(result.files).not.toContain(fresh);
    expect(result.totalBytes).toBeGreaterThan(0);
    // Nothing actually deleted in dry-run.
    expect(existsSync(old)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  test("force mode deletes the old files", () => {
    const root = makeTempVault();
    const wealth = join(root, "wealth");
    const old = join(wealth, "_log", "2024-01-01.md");
    const fresh = join(wealth, "_log", "2026-06-01.md");
    touch(old, 365 * 24 * 3600 * 1000);
    touch(fresh, 1 * 24 * 3600 * 1000);

    const result = pruneLog({
      vaultPath: root,
      olderThanMs: 30 * 24 * 3600 * 1000,
      dryRun: false,
    });

    expect(result.files).toContain(old);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("never touches state.md / QUICKSTART.md / open-loops.md / skills/", () => {
    const root = makeTempVault();
    const wealth = join(root, "wealth");
    const stateMd = join(wealth, "state.md");
    const quickstart = join(wealth, "QUICKSTART.md");
    const openLoops = join(wealth, "open-loops.md");
    const skill = join(wealth, "skills", "wealth-op-brief.md");
    // All deliberately ancient — should still survive.
    const ancient = 5 * 365 * 24 * 3600 * 1000;
    touch(stateMd, ancient);
    touch(quickstart, ancient);
    touch(openLoops, ancient);
    touch(skill, ancient);

    const result = pruneLog({
      vaultPath: root,
      olderThanMs: 30 * 24 * 3600 * 1000,
      dryRun: false,
    });

    expect(result.files).not.toContain(stateMd);
    expect(result.files).not.toContain(quickstart);
    expect(result.files).not.toContain(openLoops);
    expect(result.files).not.toContain(skill);
    expect(existsSync(stateMd)).toBe(true);
    expect(existsSync(quickstart)).toBe(true);
    expect(existsSync(openLoops)).toBe(true);
    expect(existsSync(skill)).toBe(true);
  });

  test("prunes only decisions.md / facts.md inside _journal", () => {
    const root = makeTempVault();
    const journal = join(root, "wealth", "_journal");
    const decisions = join(journal, "decisions.md");
    const facts = join(journal, "facts.md");
    const notes = join(journal, "notes.md"); // user-curated, must survive
    const ancient = 365 * 24 * 3600 * 1000;
    touch(decisions, ancient);
    touch(facts, ancient);
    touch(notes, ancient);

    const result = pruneLog({
      vaultPath: root,
      olderThanMs: 30 * 24 * 3600 * 1000,
      dryRun: false,
    });

    expect(result.files).toContain(decisions);
    expect(result.files).toContain(facts);
    expect(result.files).not.toContain(notes);
    expect(existsSync(notes)).toBe(true);
  });

  test("prunes .shasum sidecars alongside log files", () => {
    const root = makeTempVault();
    const logDir = join(root, "wealth", "_log");
    const md = join(logDir, "2024-01-01.md");
    const sha = join(logDir, "2024-01-01.md.shasum");
    const ancient = 365 * 24 * 3600 * 1000;
    touch(md, ancient);
    touch(sha, ancient);

    const result = pruneLog({
      vaultPath: root,
      olderThanMs: 30 * 24 * 3600 * 1000,
      dryRun: false,
    });

    expect(result.files).toContain(md);
    expect(result.files).toContain(sha);
    expect(existsSync(md)).toBe(false);
    expect(existsSync(sha)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// backupVault — make sure telegram.json / auth dirs / *.token are excluded
// ─────────────────────────────────────────────────────────────────────────

describe("backupVault", () => {
  test("excludes telegram.json and auth dirs and *.token from the tarball", async () => {
    const root = mkdtempSync(join(tmpdir(), "prevail-backup-"));
    const vaultPath = join(root, "vault");
    const prevailHome = join(root, "prevail-home");
    mkdirSync(join(vaultPath, "wealth", "_log"), { recursive: true });
    mkdirSync(join(prevailHome, "connectors", "fidelity", "auth"), {
      recursive: true,
    });
    writeFileSync(join(vaultPath, "wealth", "state.md"), "wealth state\n");
    writeFileSync(
      join(vaultPath, "wealth", "_log", "2026-06-01.md"),
      "log entry\n",
    );
    writeFileSync(
      join(prevailHome, "config.json"),
      JSON.stringify({ vaultPath }),
    );
    // Sensitive — must NOT show up in archive.
    writeFileSync(
      join(prevailHome, "telegram.json"),
      JSON.stringify({ botToken: "secret" }),
    );
    writeFileSync(
      join(prevailHome, "connectors", "fidelity", "auth", "refresh.token"),
      "refresh-token-value",
    );
    writeFileSync(
      join(prevailHome, "some-extra.refresh_token"),
      "extra-secret",
    );

    const out = join(root, "out.tar.gz");
    const result = await backupVault({
      vaultPath,
      outputPath: out,
      prevailHome,
    });
    expect(existsSync(result.archivePath)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);

    // Extract and inspect.
    const extractDir = join(root, "extracted");
    mkdirSync(extractDir, { recursive: true });
    const proc = Bun.spawn(["tar", "-xzf", out, "-C", extractDir]);
    const code = await proc.exited;
    expect(code).toBe(0);

    const all = walk(extractDir);
    // Vault files survived.
    expect(all.some((p) => p.endsWith("/wealth/state.md"))).toBe(true);
    expect(all.some((p) => p.endsWith("/wealth/_log/2026-06-01.md"))).toBe(
      true,
    );
    // config.json survived.
    expect(all.some((p) => p.endsWith("/config.json"))).toBe(true);
    // Sensitive paths are gone.
    expect(all.some((p) => p.endsWith("/telegram.json"))).toBe(false);
    expect(all.some((p) => p.includes("/auth/"))).toBe(false);
    expect(all.some((p) => p.endsWith(".token"))).toBe(false);
    expect(all.some((p) => p.endsWith(".refresh_token"))).toBe(false);
  });

  test("restoreVault refuses on wrong confirmation, succeeds on right one", async () => {
    // Round-trip: backup → wipe → restore. The restore must reject a wrong
    // answer to the confirm prompt, then succeed when we pass the basename.
    const root = mkdtempSync(join(tmpdir(), "prevail-restore-"));
    const vaultPath = join(root, "wealth-vault");
    const prevailHome = join(root, "prevail-home");
    mkdirSync(vaultPath, { recursive: true });
    mkdirSync(prevailHome, { recursive: true });
    writeFileSync(join(vaultPath, "marker.md"), "original\n");
    const archive = join(root, "snap.tar.gz");
    await backupVault({ vaultPath, outputPath: archive, prevailHome });

    const target = join(root, "restore-target");
    mkdirSync(target, { recursive: true });

    // Wrong answer → throws.
    await expect(
      restoreVault({
        archivePath: archive,
        targetVaultPath: target,
        confirm: async () => "nope",
      }),
    ).rejects.toThrow(/confirmation mismatch/);

    // Right answer (basename of the target) → succeeds.
    await restoreVault({
      archivePath: archive,
      targetVaultPath: target,
      confirm: async () => "restore-target",
    });
    // The archive contains a folder named after the original basename
    // ("wealth-vault") — extracting -C target produces target/wealth-vault.
    expect(existsSync(join(target, "wealth-vault", "marker.md"))).toBe(true);
  });
});

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let isDir = false;
    try {
      isDir = require("node:fs").statSync(p).isDirectory();
    } catch {}
    if (isDir) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
