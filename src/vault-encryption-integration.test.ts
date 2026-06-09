// Integration test: prove the read-site wiring (vault.ts/usage.ts via vreadFile)
// transparently decrypts an encrypted vault, and that plaintext vaults are
// unaffected (passthrough). Exercises the real high-level engine functions, not
// the crypto primitives in isolation.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// NB: scanVault's validateVaultPath rejects /var (macOS tmpdir lives there), so
// the synthetic vault must sit under the repo dir, not os.tmpdir().
const TEST_ROOT = process.cwd();

import { createKeyring } from "./vault-crypto.ts";
import { encryptVaultInPlace, decryptVaultInPlace } from "./vault-encrypt-ops.ts";
import { setVaultSession } from "./vault-session.ts";
import { scanVault } from "./vault.ts";
import { readUsage } from "./usage.ts";

function makeVault(): string {
  const dir = mkdtempSync(join(TEST_ROOT, ".prevail-encint-"));
  mkdirSync(join(dir, "health", "_log"), { recursive: true });
  mkdirSync(join(dir, "_meta"), { recursive: true });
  writeFileSync(join(dir, "health", "soul.md"), "# Health\n\nstay well\n");
  writeFileSync(join(dir, "health", "_state.md"), "# State\n\nBP normal, next checkup soon\n");
  writeFileSync(join(dir, "health", "config.md"), "name: Demo\n");
  writeFileSync(
    join(dir, "_meta", "usage.jsonl"),
    JSON.stringify({ ts: 1, day: "2026-06-01", session: "s", domain: "health", surface: "chat", cli: "claude", model: "opus", input_tokens: 10, output_tokens: 5, token_source: "reported", est_cost_usd: 0.001, billed: false }) + "\n",
  );
  return dir;
}

afterEach(() => {
  // Always clear the process-global session so tests don't leak into each other.
  setVaultSession(null, false);
});

describe("encrypted-vault read integration", () => {
  it("scanVault + readUsage decrypt transparently when the session holds the DEK", () => {
    const dir = makeVault();
    const { dek } = createKeyring("pw1234", "2026-06-09T00:00:00Z");

    // Encrypt the whole vault on disk, then unlock the session.
    encryptVaultInPlace(dir, dek);
    setVaultSession(dek, true);

    // The high-level engine read paths now return DECRYPTED content.
    const domains = scanVault(dir);
    expect(domains.map((d) => d.name)).toContain("health");

    const usage = readUsage(dir);
    expect(usage.length).toBe(1);
    expect(usage[0]!.domain).toBe("health");

    rmSync(dir, { recursive: true, force: true });
  });

  it("plaintext vault is unaffected (passthrough, no session)", () => {
    const dir = makeVault();
    setVaultSession(null, false);
    const domains = scanVault(dir);
    expect(domains.map((d) => d.name)).toContain("health");
    expect(readUsage(dir).length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("decrypting restores plaintext that reads without a session", () => {
    const dir = makeVault();
    const { dek } = createKeyring("pw1234", "2026-06-09T00:00:00Z");
    encryptVaultInPlace(dir, dek);
    decryptVaultInPlace(dir, dek);
    // No session, plaintext on disk again → still reads.
    setVaultSession(null, false);
    expect(scanVault(dir).map((d) => d.name)).toContain("health");
    rmSync(dir, { recursive: true, force: true });
  });
});
