// G11 — factory reset / secure purge.
//
// Removes the machine-local APP SECRETS Prevail keeps under the config dir
// (~/.prevail by default): OAuth refresh tokens, the MCP server token, the
// Telegram bot token, the app config, the passcode verifier, and the
// rebuildable session/index/prompt caches. The user's VAULT — their notes,
// the real data — is left ALONE unless includeVault is explicitly set,
// mirroring the existing "never delete user data without an explicit opt-in"
// guard used by the demo-vault clear (production.ts).
//
// Safety nuance: if the vault is encrypted, its keyring (vault-keyring.json)
// is the only thing that can unwrap the DEK. Deleting the keyring while KEEPING
// an encrypted vault would make the vault permanently unreadable. So the keyring
// is preserved whenever we keep an encrypted vault, and only removed when the
// vault is plaintext or is itself being erased.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.ts";
import { isVaultEncrypted } from "./vault-encrypt-ops.ts";

export type PurgeKind =
  | "config" | "lock" | "mcp-token" | "telegram" | "keyring"
  | "budget" | "watcher" | "sessions-db" | "sessions" | "prompts"
  | "connectors" | "vault";

export interface PurgeTarget {
  kind: PurgeKind;
  path: string;
  /** Human one-liner for the confirm UI. */
  label: string;
}

export interface PurgeOptions {
  /** Override the config root (test seam; defaults to configDir()). */
  dir?: string;
  /** Vault path to consider for keyring-safety + optional erase. */
  vaultPath?: string;
  /** Also erase the vault contents (DANGEROUS — the user's notes). Default false. */
  includeVault?: boolean;
  /** List only; delete nothing. */
  dryRun?: boolean;
}

export interface PurgeResult {
  /** Existing targets slated for removal (the plan; populated even on dry-run). */
  planned: PurgeTarget[];
  /** Targets actually removed (empty when dryRun). */
  removed: PurgeTarget[];
  /** Targets deliberately preserved, with the reason. */
  kept: { target: PurgeTarget; reason: string }[];
  dryRun: boolean;
}

// The machine-local secret/cache files under the config dir, in deletion order.
// The keyring and the vault are handled separately (they have safety rules).
function appSecretTargets(dir: string): PurgeTarget[] {
  return [
    { kind: "config", path: join(dir, "config.json"), label: "App settings & vault pointer" },
    { kind: "lock", path: join(dir, "lock.json"), label: "App passcode verifier" },
    { kind: "mcp-token", path: join(dir, "mcp.json"), label: "MCP server token" },
    { kind: "telegram", path: join(dir, "telegram.json"), label: "Telegram bot token & allowlist" },
    { kind: "budget", path: join(dir, "budget.jsonl"), label: "Spend ledger" },
    { kind: "watcher", path: join(dir, "watcher.jsonl"), label: "Observation cache" },
    { kind: "sessions-db", path: join(dir, "sessions.db"), label: "Chat search index" },
    { kind: "sessions", path: join(dir, "sessions"), label: "Chat session cache" },
    { kind: "prompts", path: join(dir, "prompts"), label: "Prompt logs" },
    { kind: "connectors", path: join(dir, "connectors"), label: "All connector OAuth tokens" },
  ];
}

/**
 * Compute what a purge WOULD do, without touching disk. Pure + testable.
 * Returns only targets that currently exist, split into remove vs keep
 * (with the reason a target is preserved).
 */
export function planPurge(opts: PurgeOptions = {}): { remove: PurgeTarget[]; keep: { target: PurgeTarget; reason: string }[] } {
  const dir = opts.dir ?? configDir();
  const vaultPath = opts.vaultPath;
  const remove: PurgeTarget[] = [];
  const keep: { target: PurgeTarget; reason: string }[] = [];

  for (const t of appSecretTargets(dir)) {
    if (existsSync(t.path)) remove.push(t);
  }

  // Keyring: only safe to delete if we're NOT keeping an encrypted vault.
  const keyring: PurgeTarget = { kind: "keyring", path: join(dir, "vault-keyring.json"), label: "Vault encryption keyring" };
  if (existsSync(keyring.path)) {
    const encryptedVaultKept = !opts.includeVault && !!vaultPath && existsSync(vaultPath) && isVaultEncrypted(vaultPath);
    if (encryptedVaultKept) {
      keep.push({ target: keyring, reason: "vault is encrypted and is being kept — deleting the keyring would make it permanently unreadable" });
    } else {
      remove.push(keyring);
    }
  }

  // Vault: only when explicitly opted in.
  if (vaultPath && existsSync(vaultPath)) {
    const vt: PurgeTarget = { kind: "vault", path: vaultPath, label: "Vault contents (your notes & history)" };
    if (opts.includeVault) remove.push(vt);
    else keep.push({ target: vt, reason: "vault data is preserved unless you explicitly opt in" });
  }

  return { remove, keep };
}

/** Execute the purge (or dry-run). Removes each planned target best-effort. */
export function purge(opts: PurgeOptions = {}): PurgeResult {
  const { remove, keep } = planPurge(opts);
  const removed: PurgeTarget[] = [];
  if (!opts.dryRun) {
    for (const t of remove) {
      try {
        rmSync(t.path, { recursive: true, force: true });
        removed.push(t);
      } catch {
        // Best-effort: a target we couldn't remove is reported as kept so the
        // caller can surface it rather than silently claiming a clean wipe.
        keep.push({ target: t, reason: "could not be removed (permissions or in use)" });
      }
    }
  }
  return { planned: remove, removed, kept: keep, dryRun: !!opts.dryRun };
}
