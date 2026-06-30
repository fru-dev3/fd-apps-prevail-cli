// playwright-resolve — robust runtime resolution of playwright-core for the
// COMPILED single-file binary.
//
// THE BUG (#6): the engine is built with `bun build --compile`, which bakes
// playwright-core into the binary's virtual filesystem (/$bunfs/root/prevail).
// At runtime, playwright-core's own internals resolve their package.json /
// browser registry relative to the BUILD-TIME node_modules path
// (".../engine/node_modules/playwright-core/package.json"), which does not
// exist on the user's machine and is not present inside /$bunfs. So a plain
// `import("playwright-core")` inside the packaged binary throws:
//   "playwright-core unavailable: Cannot find module
//    '.../engine/node_modules/playwright-core/package.json' from '/$bunfs/root/prevail'".
//
// THE FIX: do NOT rely on the in-binary copy. Resolve a REAL on-disk
// playwright-core that is shipped alongside the executable (the sidecar layout)
// and import it from that absolute path. The release build copies
// node_modules/playwright-core into dist/ next to the binary, and the desktop
// app ships the same folder as a sidecar resource. Resolution order:
//   1. PREVAIL_PLAYWRIGHT_CORE env override (desktop points at its sidecar).
//   2. node_modules/playwright-core next to the executable (and ../, Resources/,
//      resources/ for macOS .app / packaged layouts).
//   3. The repo node_modules (dev: running from source under `bun`).
//   4. Last resort: the bundled `import("playwright-core")` (works only when the
//      build managed to bundle it cleanly, e.g. some dev/test contexts).
//
// Importing the on-disk copy by ABSOLUTE PATH sidesteps the broken in-binary
// resolution entirely, because the loaded module's __dirname/import.meta.dir
// then point at the real folder that owns its package.json and lib/ bundles.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

// User-facing message shown when the bundled browser engine (playwright-core)
// cannot be resolved on disk. Replaces the raw "Cannot find module .../$bunfs/..."
// dump, which is meaningless to a user and exposes the CI build path. Actionable:
// the only real remedy for a packaging miss is a fresh install / update.
export const PLAYWRIGHT_UNAVAILABLE_MESSAGE =
  "Browser automation isn't available in this build. The bundled browser engine could not be found. Try updating Prevail; if it persists, reinstall.";

// True when an error/message originates from playwright-core being unavailable
// (failed on-disk resolution, then the in-binary fallback throwing a
// module-not-found). Used to swap the raw dump for PLAYWRIGHT_UNAVAILABLE_MESSAGE
// wherever a browser skill surfaces the failure.
export function isPlaywrightUnavailable(err: unknown): boolean {
  const s = typeof err === "string" ? err : String((err as { message?: unknown })?.message ?? err ?? "");
  return (
    s.includes("playwright-core") ||
    s.includes("playwright") && s.includes("Cannot find module") ||
    s === PLAYWRIGHT_UNAVAILABLE_MESSAGE
  );
}

// Resolved playwright-core package directory (absolute), or "" to mean "fall
// back to the bare specifier". Computed once.
let cachedDir: string | null = null;

function candidateDirs(): string[] {
  const dirs: string[] = [];
  const env = process.env.PREVAIL_PLAYWRIGHT_CORE;
  if (env && isAbsolute(env)) {
    // Accept either the package dir or a path to its package.json.
    dirs.push(env.endsWith("package.json") ? dirname(env) : env);
  }
  let exeDir = "";
  try {
    exeDir = dirname(process.execPath);
  } catch {
    exeDir = "";
  }
  if (exeDir) {
    // macOS .app: sidecar lives in Contents/MacOS, resources in Contents/Resources.
    // Windows/Linux: resources sit beside the exe (or under a resources/ subdir).
    // Tauri v2 may or may not preserve the declared `resources/` path segment, so
    // probe both `<base>/node_modules/...` and `<base>/resources/node_modules/...`.
    for (const base of [exeDir, join(exeDir, ".."), join(exeDir, "..", "Resources"), join(exeDir, "resources")]) {
      dirs.push(join(base, "node_modules", "playwright-core"));
      dirs.push(join(base, "resources", "node_modules", "playwright-core"));
    }
  }
  // Dev / source layout: repo node_modules relative to this module.
  dirs.push(join(import.meta.dir, "..", "node_modules", "playwright-core"));
  return dirs;
}

function resolvePackageDir(): string {
  if (cachedDir !== null) return cachedDir;
  for (const d of candidateDirs()) {
    try {
      if (d && existsSync(join(d, "package.json"))) {
        cachedDir = d;
        return d;
      }
    } catch {
      /* keep probing */
    }
  }
  cachedDir = "";
  return "";
}

// Resolve the absolute entry file for an on-disk playwright-core directory,
// honoring its package.json "exports"/"main" so we import a concrete file (ESM
// dynamic import of a bare directory is not portable).
function entryFile(dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      exports?: { "."?: Record<string, string> | string };
      main?: string;
    };
    const root = pkg.exports?.["."];
    let rel: string | undefined;
    if (typeof root === "string") rel = root;
    else if (root && typeof root === "object") rel = root.import || root.require || root.default;
    rel = rel || pkg.main || "index.js";
    const abs = join(dir, rel);
    return existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

// Import the main playwright-core module. Used for `pw.chromium.*`.
export async function loadPlaywrightCore(): Promise<any> {
  const dir = resolvePackageDir();
  if (dir) {
    const entry = entryFile(dir);
    if (entry) {
      try {
        return await import(entry);
      } catch {
        /* fall through to bare specifier */
      }
    }
  }
  // Last resort: the in-binary copy. Inside the compiled binary this throws the
  // raw "Cannot find module .../$bunfs/..." dump, so translate any failure into
  // the actionable, build-path-free message rather than leaking it to the user.
  try {
    return await import("playwright-core");
  } catch {
    throw new Error(PLAYWRIGHT_UNAVAILABLE_MESSAGE);
  }
}

// Import a playwright-core SUBMODULE (e.g. "lib/coreBundle", "lib/utilsBundle")
// used by the __install-chromium path. Resolves against the on-disk sidecar so
// the install CLI program runs from the real package, not the broken in-binary copy.
export async function loadPlaywrightSubmodule(sub: string): Promise<any> {
  const dir = resolvePackageDir();
  if (dir) {
    for (const candidate of [join(dir, sub), join(dir, `${sub}.js`), join(dir, `${sub}.cjs`), join(dir, sub, "index.js")]) {
      if (existsSync(candidate)) {
        try {
          return await import(candidate);
        } catch {
          /* fall through */
        }
      }
    }
  }
  return import(`playwright-core/${sub}`);
}
