// Demo -> production transition. The "switch to production" flow scaffolds a
// clean, empty workspace for real use and (only when explicitly safe) clears the
// throwaway demo content. Safety is the whole point here: we NEVER delete a
// vault that isn't explicitly marked as a demo, so a content-rich real vault can
// never be wiped by this path.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { embeddedVaultPath } from "./vault-embed.ts";
import { setAppMode } from "./config.ts";

/** Marker file dropped into a seeded demo vault. Its presence is the ONLY thing
 *  that authorizes `initProduction` to delete a vault's contents. */
export const DEMO_MARKER = ".prevail-demo";

/** Write the demo marker so a later production switch can safely clear it. */
export function markDemoVault(vault: string): void {
  try {
    mkdirSync(resolve(vault), { recursive: true });
    writeFileSync(
      join(resolve(vault), DEMO_MARKER),
      "prevail demo vault — seeded sample data, safe to clear on the switch to production.\n",
    );
  } catch {
    /* best-effort: a missing marker just means we won't auto-clear it later */
  }
}

/** True only if `vault` carries the demo marker (i.e. it is OUR seeded sandbox). */
export function isDemoVault(vault: string): boolean {
  return existsSync(join(resolve(vault), DEMO_MARKER));
}

export interface ProductionInitResult {
  ok: boolean;
  vault: string; // the clean production vault to point the app at
  created: boolean; // true if we created the dir fresh
  demoCleared: boolean; // true if a demo-marked vault was emptied
  refusedClear?: string; // set if a clear was requested but refused (not a demo vault)
}

/**
 * Prepare a clean production workspace.
 *
 * - Ensures an empty vault exists at `vault` (default: the app-embedded
 *   `~/.prevail/vault`). The app then points itself there.
 * - Sets app mode to "production".
 * - If `clearDemo` is given AND that path is a demo-marked vault (and not the
 *   target itself), empties it. Otherwise it is LEFT UNTOUCHED and reported via
 *   `refusedClear` — we never delete an unmarked (possibly real) vault.
 */
export function initProduction(opts: { vault?: string; clearDemo?: string }): ProductionInitResult {
  const vault = resolve((opts.vault ?? "").trim() || embeddedVaultPath());
  const created = !existsSync(vault);
  mkdirSync(vault, { recursive: true });

  let demoCleared = false;
  let refusedClear: string | undefined;
  if (opts.clearDemo && opts.clearDemo.trim()) {
    const demo = resolve(opts.clearDemo.trim());
    if (demo === vault) {
      // clearing into the same dir we just made the workspace — skip
    } else if (isDemoVault(demo)) {
      for (const entry of readdirSync(demo)) {
        rmSync(join(demo, entry), { recursive: true, force: true });
      }
      demoCleared = true;
    } else {
      refusedClear = demo; // not a demo vault — refuse to delete it
    }
  }

  setAppMode("production", vault);
  return { ok: true, vault, created, demoCleared, refusedClear };
}
