// secret-file — the single safe way to persist a credential-bearing file (C2/B9).
//
// The scattered pattern was `writeFileSync(path, secret)` (created world-readable
// under the default umask) followed by a best-effort `chmod 0600` whose failure
// was swallowed — leaving a window where the secret is readable, and on some
// setups leaving it readable permanently with no warning (audit O12/O44).
//
// writeSecretFile creates the file mode-0600 up front AND enforces 0600 after
// (the mode arg is ignored for an already-existing file), surfacing a chmod
// failure on POSIX instead of hiding it.

import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function writeSecretFile(path: string, data: string): void {
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); } catch { /* exists */ }
  // mode applies on create; harmless no-op when the file already exists.
  writeFileSync(path, data, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch (e) {
    // Tolerate filesystems without POSIX perms (Windows, some network mounts),
    // but never silently leave a secret world-readable on a POSIX system.
    if (process.platform !== "win32") {
      throw new Error(`could not secure ${path} to 0600: ${e instanceof Error ? e.message : e}`);
    }
  }
}
