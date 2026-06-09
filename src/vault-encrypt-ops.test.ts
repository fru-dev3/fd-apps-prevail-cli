import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createKeyring } from "./vault-crypto.ts";
import {
  decryptVaultInPlace,
  encryptVaultInPlace,
  isVaultEncrypted,
  loadKeyring,
  readVaultFile,
  saveKeyring,
} from "./vault-encrypt-ops.ts";

function makeVault(): { dir: string; files: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "prevail-enc-"));
  mkdirSync(join(dir, "health", "_log"), { recursive: true });
  mkdirSync(join(dir, "wealth"), { recursive: true });
  const files = {
    "health/soul.md": "# Health\n\nplaintext secret: lab results\n",
    "health/_log/2026-06-01.md": "private journal entry\n",
    "wealth/soul.md": "# Wealth\n\nnet worth notes\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content);
  }
  return { dir, files };
}

describe("keyring persistence", () => {
  it("saves and loads a keyring", () => {
    const f = join(mkdtempSync(join(tmpdir(), "prevail-kr-")), "keyring.json");
    const { keyring } = createKeyring("pw1234", "2026-06-09T00:00:00Z");
    saveKeyring(keyring, f);
    const back = loadKeyring(f)!;
    expect(back.schema).toBe(keyring.schema);
    expect(back.wrappedDek.ct).toBe(keyring.wrappedDek.ct);
  });
  it("returns null when absent", () => {
    expect(loadKeyring(join(tmpdir(), "no-keyring-xyz.json"))).toBeNull();
  });
});

describe("encrypt/decrypt vault in place", () => {
  it("turns every file to ciphertext and restores it exactly", () => {
    const { dir, files } = makeVault();
    const { dek } = createKeyring("pw1234", "2026-06-09T00:00:00Z");

    expect(isVaultEncrypted(dir)).toBe(false);
    const enc = encryptVaultInPlace(dir, dek);
    expect(enc.files).toBe(3);
    expect(isVaultEncrypted(dir)).toBe(true);

    // On disk the plaintext is gone.
    const onDisk = readFileSync(join(dir, "health", "soul.md"), "utf8");
    expect(onDisk).not.toContain("lab results");

    // But the transparent reader recovers it with the DEK.
    expect(readVaultFile(join(dir, "health", "soul.md"), dek, true)).toBe(files["health/soul.md"]);

    // And a full decrypt restores originals byte-for-byte.
    const dec = decryptVaultInPlace(dir, dek);
    expect(dec.files).toBe(3);
    expect(isVaultEncrypted(dir)).toBe(false);
    for (const [rel, content] of Object.entries(files)) {
      expect(readFileSync(join(dir, rel), "utf8")).toBe(content);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("encrypt is idempotent (no double-encryption)", () => {
    const { dir } = makeVault();
    const { dek } = createKeyring("pw1234", "2026-06-09T00:00:00Z");
    encryptVaultInPlace(dir, dek);
    const second = encryptVaultInPlace(dir, dek);
    expect(second.files).toBe(0); // already encrypted → no-op
    // Still decrypts cleanly (not double-wrapped).
    decryptVaultInPlace(dir, dek);
    expect(readFileSync(join(dir, "wealth", "soul.md"), "utf8")).toContain("net worth notes");
    rmSync(dir, { recursive: true, force: true });
  });

  it("readVaultFile passes through when not encrypted", () => {
    const { dir, files } = makeVault();
    expect(readVaultFile(join(dir, "wealth", "soul.md"), null, false)).toBe(files["wealth/soul.md"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
