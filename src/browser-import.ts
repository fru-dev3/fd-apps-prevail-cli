// browser-import — optional one-time convenience: seed a connector's dedicated
// Prevail Chrome profile with the user's EXISTING login cookies for that site,
// so they don't have to sign in even once.
//
// How it stays safe + scoped (vs. the cookie-theft anti-pattern):
//   * We never open a remote-debugging port and never decrypt Chrome's cookie
//     store ourselves. We ask the user's OWN Chrome to read its OWN cookies
//     (Chrome decrypts them), which requires Chrome to be CLOSED (profile lock).
//   * We copy ONLY the cookies for the target site's host(s) — not the user's
//     whole browsing life — into the connector's isolated profile.
//   * The result is identical to the user logging in once: the dedicated profile
//     now holds that site's session, and replay reuses it headlessly.

import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

// The user's real Chrome "User Data" dir (the parent that holds Default/). On
// macOS this is the only location; we keep it mac-first (Prevail is mac-first).
function realChromeUserDataDir(): string | null {
  const home = homedir();
  const mac = join(home, "Library/Application Support/Google/Chrome");
  if (existsSync(mac)) return mac;
  // Linux fallback (best effort).
  const linux = join(home, ".config/google-chrome");
  if (existsSync(linux)) return linux;
  return null;
}

function normalizeHost(h: string): string {
  return h.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase();
}

function cookieMatchesHosts(domain: string, hosts: string[]): boolean {
  const d = (domain || "").replace(/^\./, "").replace(/^www\./, "").toLowerCase();
  return hosts.some((h) => d === h || d.endsWith("." + h) || h.endsWith("." + d));
}

export interface ImportResult {
  ok: boolean;
  imported: number;
  message: string;
}

// Copy the user's existing login cookies for `rawHosts` from their real Chrome
// into the connector's dedicated profile dir. Chrome MUST be closed.
export async function importChromeLogins(prevailProfileDir: string, rawHosts: string[]): Promise<ImportResult> {
  const hosts = [...new Set(rawHosts.map(normalizeHost).filter(Boolean))];
  if (hosts.length === 0) return { ok: false, imported: 0, message: "no target site host to import for" };
  const userDataDir = realChromeUserDataDir();
  if (!userDataDir) return { ok: false, imported: 0, message: "no Google Chrome profile found on this machine" };

  const pw = await import("playwright-core");

  // 1) Read cookies from the user's REAL Chrome (Chrome decrypts its own store).
  //    Requires Chrome to be quit — otherwise the profile is locked.
  let real: any;
  try {
    real = await pw.chromium.launchPersistentContext(userDataDir, { headless: true, channel: "chrome" });
  } catch {
    return { ok: false, imported: 0, message: "couldn't open your Chrome profile — please QUIT Google Chrome completely, then try again." };
  }
  let scoped: any[] = [];
  try {
    const all = await real.cookies();
    scoped = all.filter((c: any) => cookieMatchesHosts(c.domain, hosts));
  } finally {
    await real.close().catch(() => {});
  }
  if (scoped.length === 0) {
    return { ok: false, imported: 0, message: `no saved logins for ${hosts.join(", ")} in your Chrome (sign into the site in Chrome first, then import).` };
  }

  // 2) Write them into the connector's ISOLATED Prevail profile.
  mkdirSync(prevailProfileDir, { recursive: true });
  let prevail: any;
  try {
    prevail = await pw.chromium.launchPersistentContext(prevailProfileDir, { headless: true, channel: "chrome" });
  } catch (e) {
    return { ok: false, imported: 0, message: `couldn't open the Prevail browser profile: ${String((e as Error)?.message || e).slice(0, 120)}` };
  }
  try {
    await prevail.addCookies(scoped);
  } finally {
    await prevail.close().catch(() => {});
  }
  return { ok: true, imported: scoped.length, message: `imported ${scoped.length} login cookie(s) for ${hosts.join(", ")} — no sign-in needed.` };
}
