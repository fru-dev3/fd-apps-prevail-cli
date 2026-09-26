import { existsSync, realpathSync, statSync, mkdirSync, renameSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep, dirname } from "node:path";
import { homedir } from "node:os";

// Belt-and-suspenders defense against vault-path attacks. The vault path is
// user-controlled (from config.json or --vault flag), and domain/app names
// come from readdirSync which already strips slashes — but explicit
// validation here means:
//
//   1. A misconfigured config.json pointing at "/" doesn't get accepted
//      silently (the TUI would scan and try to write to system dirs).
//   2. A domain entry with a name like "..\x00etc" (theoretically possible
//      on some FS APIs or via a malicious symlink farm) is rejected.
//   3. A symlink farm that escapes the vault root is detected and refused.
//
// This is defense-in-depth — the readdirSync code path was already safe in
// practice. But the rule "we never read or write outside the vault root"
// should be enforceable as an invariant, not an emergent property.

// Valid vault location predicates. We refuse paths that look catastrophic
// (root, /etc, /tmp, /var) but otherwise allow the user to put their vault
// wherever they want — including under iCloud / Dropbox / Tailscale-mounted
// directories, which is part of the design.
const FORBIDDEN_PREFIXES = [
  "/etc",
  "/var",
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library/System",
  "/private/var",
  "/dev",
  "/proc",
  "/sys",
];

export interface PathValidation {
  ok: boolean;
  reason?: string;
}

export function validateVaultPath(path: string): PathValidation {
  if (!path || typeof path !== "string") {
    return { ok: false, reason: "vault path is empty or not a string" };
  }
  if (path.includes("\0")) {
    return { ok: false, reason: "vault path contains null bytes" };
  }
  if (!isAbsolute(path)) {
    return { ok: false, reason: "vault path must be absolute" };
  }
  const norm = normalize(path);
  if (norm === "/" || norm === sep) {
    return { ok: false, reason: "vault path can't be the filesystem root" };
  }
  for (const forbidden of FORBIDDEN_PREFIXES) {
    if (norm === forbidden || norm.startsWith(forbidden + sep)) {
      return { ok: false, reason: `vault path can't live under ${forbidden}` };
    }
  }
  return { ok: true };
}

// Domain / app names come from readdirSync — already sanitized of slashes
// at the OS level, but null bytes, leading dots (hidden dirs we want to
// skip), and weird control chars are still possible. Reject them so any
// downstream `join(vaultPath, name)` is guaranteed to stay under vaultPath.
export function isSafeEntryName(name: string): boolean {
  if (!name || name.length === 0 || name.length > 200) return false;
  if (name.includes("\0")) return false;
  if (name === "." || name === "..") return false;
  if (name.startsWith(".")) return false; // hidden dirs aren't domains/apps
  // Control chars including newline / tab — no legit dir name has these.
  if (/[\x00-\x1f]/.test(name)) return false;
  return true;
}

// Confirm a resolved child path actually lives under the vault root after
// symlink resolution. Catches the "symlink escape" case where a vault
// subdir's symlink points outside the vault. Returns the realpath when
// safe, or null when not.
export function resolveSafeChild(vaultRoot: string, child: string): string | null {
  try {
    const joined = resolve(vaultRoot, child);
    const realChild = realpathSync(joined);
    const realRoot = realpathSync(vaultRoot);
    if (realChild === realRoot) return null; // child resolves to root itself
    if (!realChild.startsWith(realRoot + sep)) return null;
    return realChild;
  } catch {
    // Most often: child doesn't exist yet. Caller decides what to do.
    return null;
  }
}

// ── Vault layout (v3) ────────────────────────────────────────────────────────
// The canonical layout nests domains under <vault>/domains/<domain> and apps
// under <vault>/apps/<app>, so the vault root holds just those two containers
// (plus a few engine files). For backward compatibility we still READ legacy
// domains that live directly at <vault>/<domain> (pre-v3): resolveDomainDir
// prefers the new home and falls back to legacy, so existing vaults keep working
// with zero migration. New domains are always created under domains/, and the
// migrate-vault-v3 tool moves legacy domains on the user's terms.
export const DOMAINS_DIR = "domains";
export const APPS_DIR = "apps";

// ── Vault layout (v4: the `data/` container) ──────────────────────────────────
// W4 (Monday feedback): "Avoid loose files. Everything should be in a folder.
// Use a prefix for apps and domains so they are close together inside a data
// folder." v4 introduces a single `<vault>/data/` container that becomes the
// effective content root — domains, apps, and the General-bucket files all live
// under it, so the vault root is no longer littered with loose `_*.jsonl` /
// `*.md` / `*.ndjson` files. Backward compatible: when no `data/` dir exists the
// effective root IS the vault root, so pre-v4 vaults keep working untouched. The
// migrator (vault-data-layout.ts) copies content in non-destructively; readers
// prefer `data/` the instant it appears. Mirror this resolution in the desktop
// (paths.rs) and TUI so all three processes agree on where content lives.
export const DATA_DIR = "data";
export const BUILD_DIR = "build";

// ── App-scope conversation keys ───────────────────────────────────────────────
// The desktop gives an open app its OWN thread space keyed `_app-<id>` (App.tsx,
// chatpanel.tsx) so app chats live in the app's space, independent of any domain.
// That key is NOT a domain: if it were resolved like one it would materialize a
// shadow folder under data/domains/_app-<id>, shadowing the real app that lives
// in data/apps/<id>. Instead we route `_app-<id>` to the app's OWN space under
// data/apps/<id>/_scope, a contained subfolder that the app scanner ignores (it
// only reads plain content files at the app root). Both the engine (resolvers
// below) and the desktop (paths.rs resolve_domain_base) MUST agree on this, or
// app chat history would split between apps/ and domains/.
export const APP_SCOPE_PREFIX = "_app-";
export const APP_SCOPE_SUBDIR = "_scope";

// Return the app id for an `_app-<id>` scope key, or null when `domain` is a
// normal domain. Rejects ids that could escape the apps container.
export function appScopeId(domain: string): string | null {
  if (!domain || !domain.startsWith(APP_SCOPE_PREFIX)) return null;
  const id = domain.slice(APP_SCOPE_PREFIX.length);
  if (!id) return null;
  if (id.includes("/") || id.includes("\\") || id.includes("..") || id.includes("\0")) return null;
  return id;
}

// B2-12 (Phase 1, additive — no behavior change until a migration creates build/).
// The `build/` container holds supporting/runtime files (ledgers, _meta, _threads,
// benchmark, usage, …). `runtimePath` PREFERS <vault>/build/<name> when it exists,
// else falls back to the current location (vault root). Route runtime readers
// through this in Phase 2.
export function buildRoot(vaultPath: string): string {
  const b = join(vaultPath, BUILD_DIR);
  try {
    if (existsSync(b) && statSync(b).isDirectory()) return b;
  } catch { /* fall through */ }
  return vaultPath;
}
export function runtimePath(vaultPath: string, name: string): string {
  const buildDir = join(vaultPath, BUILD_DIR);
  // build/ is the SINGLE canonical home for app-support. When it exists, ALWAYS
  // resolve under it - for reads AND writes - and never fall back to a root-level
  // legacy path. The old root fallback caused split state, writing _meta/usage/
  // etc. OUTSIDE data/ and build/. Only a pre-build vault (no build/ yet) uses
  // the root, and only until build/ is created.
  try { if (existsSync(buildDir) && statSync(buildDir).isDirectory()) return join(buildDir, name); } catch { /* */ }
  return join(vaultPath, name);
}

// The effective content root: `<vault>/data` once migrated, else the vault root.
// Every domain/app/General resolver routes through this so a single switch flips
// the whole vault to the v4 layout.
export function dataRoot(vaultPath: string): string {
  const nu = join(vaultPath, DATA_DIR);
  try {
    if (existsSync(nu) && statSync(nu).isDirectory()) return nu;
  } catch { /* fall through to the vault root */ }
  return vaultPath;
}

// The directory of a domain. Resolution order (newest layout wins, all readable
// simultaneously for zero-migration compatibility):
//   1. v4:     <vault>/data/domains/<d>
//   2. v3:     <vault>/domains/<d>
//   3. legacy: <vault>/<d>  (also the write target for a not-yet-created domain)
// dataRoot() collapses (1) and (2) into one check when no data/ dir exists.
export function resolveDomainDir(vaultPath: string, domain: string): string {
  // App-scope keys (`_app-<id>`) belong with the app, not among domains. Route
  // them to data/apps/<id>/_scope so no data/domains/_app-<id> shadow appears.
  const scopeId = appScopeId(domain);
  if (scopeId) return join(appsContainer(vaultPath), scopeId, APP_SCOPE_SUBDIR);
  const v4 = join(dataRoot(vaultPath), DOMAINS_DIR, domain);
  if (existsSync(v4)) return v4;
  const v3 = join(vaultPath, DOMAINS_DIR, domain);
  if (existsSync(v3)) return v3;
  // Brand-new domain: NEVER create it at the vault root. The canonical home is
  // data/domains/<d> whenever a data/ root exists (v4 vault); only a legacy
  // vault with no data/ keeps domains at the root. This stops stray top-level
  // domain folders (e.g. a duplicate general/) from appearing outside data/.
  const dr = dataRoot(vaultPath);
  return dr !== vaultPath ? join(dr, DOMAINS_DIR, domain) : join(vaultPath, domain);
}

// Where a NEW domain should be created: the canonical home under the effective
// content root (data/domains once migrated, else domains/).
export function newDomainDir(vaultPath: string, domain: string): string {
  // Same app-scope rerouting as resolveDomainDir: a brand-new `_app-<id>` scope
  // is created under data/apps/<id>/_scope, never data/domains/.
  const scopeId = appScopeId(domain);
  if (scopeId) return join(appsContainer(vaultPath), scopeId, APP_SCOPE_SUBDIR);
  return join(dataRoot(vaultPath), DOMAINS_DIR, domain);
}

// ── Browser-automation Chrome profiles (MACHINE-LOCAL, never in the vault) ─────
// A browser connector drives the user's real Chrome in a persistent user-data
// directory so a one-time Google sign-in survives across runs. That directory is
// a FULL Chrome profile (GPU/component caches, Safe Browsing, extension crx
// caches, absolute-path locks) and is machine-specific. It MUST NOT live inside
// the vault: the vault is synced across the user's Macs, and syncing a live
// Chrome profile both bloats the vault and can corrupt auth when two machines
// write it. So we root every browser profile under the user's home, entirely
// outside any vault:
//
//   ~/.prevail/browser-profiles/<connectorId>/profile
//
// Only the connectorId (the app id, e.g. "fidelity-com") keys the path. We do
// NOT scope by vault path: the app id is already unique per connector, keeping
// the layout simple and deterministic, and a single machine driving the same
// connector from two vaults would (correctly) share one login. The Rust side
// (ingestion/storage.rs `browser_profile_dir`) mirrors this exact path so a
// profile written by either process is found by the other.
export const BROWSER_PROFILES_DIR = "browser-profiles";

// Reduce a connector id to a single safe path segment matching [a-z0-9._-].
// Takes the basename first so a full connectorDir path collapses to the app id,
// then lowercases and replaces every other char with "-". Never empty.
export function sanitizeConnectorId(id: string): string {
  const base = (id ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  const clean = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return clean || "connector";
}

// The machine-local root for all browser profiles: ~/.prevail/browser-profiles.
export function browserProfilesRoot(): string {
  return join(homedir(), ".prevail", BROWSER_PROFILES_DIR);
}

// Pure resolver: the machine-local Chrome user-data dir for a connector. No
// filesystem side effects — safe to call from read-only probes.
export function browserProfilePath(connectorId: string): string {
  return join(browserProfilesRoot(), sanitizeConnectorId(connectorId), "profile");
}

// THE helper the browser call sites use. Returns the machine-local profile dir,
// creating it on demand. `legacyVaultProfileDir` is the OLD in-vault location
// (<connectorDir>/auth/profile); when given, we perform a ONE-TIME, non-
// destructive migration: if the machine-local dir does not exist yet but a
// legacy profile does, MOVE (rename) the legacy profile out of the vault to the
// new home so the user keeps their login and the vault stops carrying it. If the
// move fails (cross-device, locks), we fall back to a fresh profile at the new
// location and leave the legacy dir untouched (we never delete what we did not
// just relocate).
export function browserProfileDir(connectorId: string, legacyVaultProfileDir?: string): string {
  const dir = browserProfilePath(connectorId);
  if (legacyVaultProfileDir && !existsSync(dir) && existsSync(legacyVaultProfileDir)) {
    try {
      mkdirSync(dirname(dir), { recursive: true });
      renameSync(legacyVaultProfileDir, dir);
    } catch (e) {
      // Cross-device rename or a locked profile — keep going with a fresh
      // machine-local profile; the legacy dir stays put and can be retried.
      try {
        console.error(
          `prevail: could not move legacy browser profile out of the vault (${(e as Error).message}); starting a fresh machine-local profile at ${dir}`,
        );
      } catch { /* ignore logging failure */ }
    }
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The apps container inside the vault — under the effective content root.
export function appsContainer(vaultPath: string): string {
  const v4 = join(dataRoot(vaultPath), APPS_DIR);
  if (existsSync(v4)) return v4;
  const legacy = join(vaultPath, APPS_DIR);
  if (existsSync(legacy)) return legacy;
  return v4; // default new writes to the v4 home
}
