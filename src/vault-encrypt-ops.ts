// Vault encryption operations — Feature 4, Phase 1 (migration + keyring store).
//
// Builds on vault-crypto.ts. Two responsibilities:
//   1. Persist the keyring (the wrapped DEK) at ~/.prevail/vault-keyring.json,
//      OUTSIDE the vault so encrypting the vault never encrypts its own key.
//   2. Migrate a vault directory between plaintext and ciphertext in place,
//      non-destructively verified, marked by a control file at the vault root.
//
// IMPORTANT: this is the tested migration core. It is NOT yet wired into the
// engine's ~20 vault read sites (vault.ts et al. have no single choke point),
// so turning a real vault to ciphertext would make those reads fail until that
// integration lands. Callers must therefore treat `encryptVaultInPlace` as
// gated behind that integration + a verified backup + live testing. Nothing
// here runs automatically.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { configDir } from "./config.ts";
import { decryptText, encryptText, type Keyring } from "./vault-crypto.ts";

export function keyringFilePath(): string {
  return join(configDir(), "vault-keyring.json");
}

export function saveKeyring(keyring: Keyring, file: string = keyringFilePath()): void {
  writeFileSync(file, JSON.stringify(keyring, null, 2));
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

export function loadKeyring(file: string = keyringFilePath()): Keyring | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Keyring;
  } catch {
    return null;
  }
}

// Control file at the vault root marking the vault as encrypted. Its presence is
// how every surface knows to decrypt on read.
const MARKER = ".prevail-encrypted";

export function vaultMarkerPath(vaultDir: string): string {
  return join(vaultDir, MARKER);
}

export function isVaultEncrypted(vaultDir: string): boolean {
  return existsSync(vaultMarkerPath(vaultDir));
}

// Walk every regular file under `dir`, skipping the marker and any dotfiles at
// the root we manage. Returns absolute paths.
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === MARKER) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export interface VaultCryptoResult {
  files: number;
  ok: boolean;
}

/**
 * Encrypt every file in `vaultDir` in place (plaintext -> sealed JSON), then
 * drop the marker. Idempotent: a no-op if already marked encrypted. The DEK
 * comes from an unlocked keyring. NON-destructive in the sense that decrypt
 * fully restores the originals — but callers MUST back up first and MUST have
 * the read-path integration in place before doing this to a live vault.
 */
export function encryptVaultInPlace(vaultDir: string, dek: Buffer): VaultCryptoResult {
  if (isVaultEncrypted(vaultDir)) return { files: 0, ok: true };
  const files = walkFiles(vaultDir);
  for (const f of files) {
    const plain = readFileSync(f, "utf8");
    writeFileSync(f, encryptText(dek, plain));
  }
  writeFileSync(vaultMarkerPath(vaultDir), `${new Date().toISOString()}\n`);
  return { files: files.length, ok: true };
}

/** Reverse of `encryptVaultInPlace`: decrypt every file and remove the marker. */
export function decryptVaultInPlace(vaultDir: string, dek: Buffer): VaultCryptoResult {
  if (!isVaultEncrypted(vaultDir)) return { files: 0, ok: true };
  const files = walkFiles(vaultDir);
  for (const f of files) {
    const blob = readFileSync(f, "utf8");
    writeFileSync(f, decryptText(dek, blob));
  }
  rmSync(vaultMarkerPath(vaultDir));
  return { files: files.length, ok: true };
}

/**
 * The transparent read every engine vault-read site will eventually call: if
 * the vault is encrypted and we hold the DEK, decrypt; otherwise pass the bytes
 * through unchanged. Provided + tested now so the future read-site wiring is a
 * mechanical swap of `readFileSync` for this.
 */
export function readVaultFile(path: string, dek: Buffer | null, encrypted: boolean): string {
  const raw = readFileSync(path, "utf8");
  if (!encrypted || !dek) return raw;
  return decryptText(dek, raw);
}

/** Ensure the keyring directory exists (mirrors config dir). */
export function ensureKeyringDir(): void {
  mkdirSync(configDir(), { recursive: true });
}

// Re-exported for callers/tests that need to assert on a directory's shape.
export function isDirectory(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}
