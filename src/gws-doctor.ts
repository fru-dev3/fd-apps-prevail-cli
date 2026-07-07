// The Google connector's self-diagnosis: everything a human debugging session
// would check, as one callable tool. When a google_workspace call fails, the
// agent runs THIS instead of poking blind calls one at a time or asking the
// user to open a terminal: for every connected profile it reads the live
// `gws auth status` and reports identity, token health, granted scopes, and
// which Google APIs are enabled on the OAuth project - then names the exact
// remedial action per service (re-authorize / enable API at URL / fix keychain).
// Read-only and bounded: one auth-status spawn per profile.

import { spawnSync } from "node:child_process";
import { resolveGwsBinary, listGwsProfiles, augmentedPath, type GwsProfile } from "./calendar-sync.ts";

export interface GwsAuthStatus {
  user?: string;
  token_valid?: boolean;
  has_refresh_token?: boolean;
  scopes?: string[];
  enabled_apis?: string[];
  project_id?: string;
  keyring_backend?: string;
  encryption_valid?: boolean;
  error?: string; // set by the fetcher when the probe itself failed
}

// Service -> the OAuth scope that must be granted AND the Google API that must
// be enabled on the client's project. Scope regexes match gws's scope URLs.
const SERVICES: Array<{ id: string; label: string; scope: RegExp; api: string }> = [
  { id: "calendar", label: "Calendar", scope: /auth\/calendar/, api: "calendar-json.googleapis.com" },
  { id: "gmail", label: "Gmail", scope: /auth\/gmail\./, api: "gmail.googleapis.com" },
  { id: "drive", label: "Drive", scope: /auth\/drive/, api: "drive.googleapis.com" },
  { id: "docs", label: "Docs", scope: /auth\/documents/, api: "docs.googleapis.com" },
  { id: "sheets", label: "Sheets", scope: /auth\/spreadsheets/, api: "sheets.googleapis.com" },
  { id: "tasks", label: "Tasks", scope: /auth\/tasks/, api: "tasks.googleapis.com" },
];

function fetchStatus(configDir: string): GwsAuthStatus {
  const gws = resolveGwsBinary();
  if (!gws) return { error: "gws binary not found" };
  try {
    const run = spawnSync(gws, ["auth", "status"], {
      encoding: "utf8",
      env: { ...process.env, PATH: augmentedPath(), GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDir },
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (run.error) return { error: String(run.error.message ?? run.error) };
    try {
      return JSON.parse(run.stdout || "{}") as GwsAuthStatus;
    } catch {
      // auth status did not return JSON - surface whatever it said (keychain
      // denials in an app context land here).
      const said = `${run.stderr || ""} ${run.stdout || ""}`.replace(/using keyring backend:[^\n]*/gi, "").replace(/\s+/g, " ").trim();
      return { error: said.slice(0, 300) || `auth status exited ${run.status}` };
    }
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
}

// Produce the human/agent-readable health report. `fetch` and `machine` are
// injectable so tests can pin machine state instead of depending on whatever
// gws binary/profiles the running host happens to have.
export function runGwsDoctor(
  fetch: (configDir: string) => GwsAuthStatus = fetchStatus,
  machine: { hasBinary: () => boolean; profiles: () => GwsProfile[] } = {
    hasBinary: () => resolveGwsBinary() !== null,
    profiles: listGwsProfiles,
  },
): string {
  if (!machine.hasBinary()) {
    return "Google connector doctor: the gws CLI is NOT installed on this machine. Install it (brew install gws) and connect an account from the Prevail Google panel.";
  }
  const profiles = machine.profiles();
  if (profiles.length === 0) {
    return "Google connector doctor: gws is installed but NO Google accounts are connected on this machine. Connect one from the Prevail Google panel.";
  }
  const lines: string[] = [`Google connector doctor - ${profiles.length} account(s) on this machine:`];
  for (const p of profiles) {
    const st = fetch(p.configDir);
    if (st.error) {
      const keychainish = /keychain|keyring|errsec/i.test(st.error);
      lines.push(
        `- ${p.label}: PROBE FAILED - ${st.error}` +
          (keychainish
            ? " (looks like a macOS Keychain denial in this execution context: it works in Terminal but not from the app. Fix: open Keychain Access and allow gws, or re-run 'gws auth login' in Terminal and choose Always Allow.)"
            : ""),
      );
      continue;
    }
    const who = st.user || "(unknown identity)";
    const token = st.token_valid ? "token valid" : st.has_refresh_token ? "token expired but refreshable" : "NOT signed in (no valid token)";
    lines.push(`- ${p.label} (${who}): ${token}${st.project_id ? ` · OAuth project ${st.project_id}` : ""}`);
    const scopes = st.scopes ?? [];
    const apis = st.enabled_apis ?? [];
    for (const svc of SERVICES) {
      const scopeOk = scopes.some((s) => svc.scope.test(s));
      const apiOk = apis.length === 0 ? null : apis.includes(svc.api); // no list -> unknown, do not accuse
      if (scopeOk && apiOk !== false) continue; // healthy (or unknown-but-scoped): stay quiet
      if (!scopeOk) {
        lines.push(`    ${svc.label}: scope NOT granted for this account - re-authorize "${p.label}" from the Prevail Google panel and approve ALL permissions.`);
      } else if (apiOk === false) {
        lines.push(`    ${svc.label}: the ${svc.label} API is DISABLED on OAuth project ${st.project_id ?? "(unknown)"} - one-time fix: open https://console.developers.google.com/apis/api/${svc.api}/overview${st.project_id ? `?project=${st.project_id}` : ""} and click Enable (fixes every account sharing this client).`);
      }
    }
  }
  lines.push("Services not listed under an account are healthy for it. Retry the original call with the account that is healthy for the service you need, or apply the named fix first.");
  return lines.join("\n");
}
