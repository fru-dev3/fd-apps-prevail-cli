// The GLOBAL outbound-email guardrail: mail from the user's accounts may only
// be SENT to the user themself. Anything addressed to a third party is, by
// policy, either refused or downgraded to a DRAFT for the user to review and
// send by hand - never sent directly, not even after a generic approval tap.
// Enforced at the EXECUTION choke points (the gws write queue's executor and
// the queue-time classifier), so no prompt phrasing can talk around it.
//
// Policy values (persisted in ~/.prevail/config.json `emailPolicy`):
//   self-only     third-party sends are refused outright
//   draft-others  (DEFAULT) third-party sends become Gmail DRAFTS
//   allow         sends run as approved (the pre-guardrail behavior)
//
// "Self" = the union of every Google account connected on this machine, so
// mailing one of your own inboxes from another still counts as you.

import { readConfig, writeConfig } from "./config.ts";
import { listGwsProfiles, gwsSpawnEnv, resolveGwsBinary } from "./calendar-sync.ts";
import { spawnSync } from "node:child_process";

export type EmailPolicy = "self-only" | "draft-others" | "allow";

export const DEFAULT_EMAIL_POLICY: EmailPolicy = "draft-others";

export function readEmailPolicy(): EmailPolicy {
  try {
    const raw = readConfig()?.emailPolicy;
    if (raw === "self-only" || raw === "draft-others" || raw === "allow") return raw;
  } catch { /* default */ }
  return DEFAULT_EMAIL_POLICY;
}

export function writeEmailPolicy(policy: EmailPolicy): void {
  const cfg = readConfig() ?? ({} as ReturnType<typeof readConfig> & object);
  (cfg as { emailPolicy?: string }).emailPolicy = policy;
  writeConfig(cfg as NonNullable<ReturnType<typeof readConfig>>);
}

// Every email address the user is signed in as on this machine (all connected
// gws profiles), lowercased. Cached per process; the probe is one auth-status
// spawn per profile.
let selfCache: Set<string> | null = null;
export function selfAddresses(fetch?: (configDir: string) => string | null): Set<string> {
  if (selfCache) return selfCache;
  const out = new Set<string>();
  const probe = fetch ?? ((dir: string) => {
    try {
      const gws = resolveGwsBinary();
      if (!gws) return null;
      const env = { ...gwsSpawnEnv(), GOOGLE_WORKSPACE_CLI_CONFIG_DIR: dir };
      const r = spawnSync(gws, ["auth", "status"], { encoding: "utf8", env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
      const user = (JSON.parse(r.stdout || "{}") as { user?: unknown }).user;
      return typeof user === "string" ? user : null;
    } catch { return null; }
  });
  for (const p of listGwsProfiles()) {
    const email = probe(p.configDir);
    if (email && email.includes("@")) out.add(email.trim().toLowerCase());
  }
  selfCache = out;
  return out;
}

/** Test hook: reset the per-process self-address cache. */
export function resetSelfCache(): void { selfCache = null; }

// Is this gws argv an email SEND (as opposed to any other write)?
function isEmailSend(args: string[]): boolean {
  if ((args[0] ?? "").toLowerCase() !== "gmail") return false;
  return args.some((a) => a === "+send" || a === "+reply" || a === "+reply-all" || a === "+forward" || a === "send");
}

// Extract explicit recipient addresses from --to/--cc/--bcc flags (comma lists).
export function extractRecipients(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    const grab = (v: string | undefined) => {
      for (const part of (v ?? "").split(",")) {
        const t = part.trim().toLowerCase();
        if (t.includes("@")) out.push(t);
      }
    };
    if (a === "--to" || a === "--cc" || a === "--bcc") grab(args[i + 1]);
    else if (/^--(to|cc|bcc)=/.test(a)) grab(a.slice(a.indexOf("=") + 1));
  }
  return out;
}

export interface EmailPolicyDecision {
  action: "allow" | "draft" | "refuse";
  /** The (possibly transformed) argv to execute. */
  args: string[];
  reason: string;
}

// Apply the guardrail to one gws argv. Non-send commands and self-only sends
// pass through untouched. Replies/forwards without explicit --to flags target
// the original thread's participants (unknowable here), so they are treated as
// third-party by default - conservative is correct for a guardrail.
export function applyEmailPolicy(
  args: string[],
  policy: EmailPolicy = readEmailPolicy(),
  selves: Set<string> = selfAddresses(),
): EmailPolicyDecision {
  if (!isEmailSend(args)) return { action: "allow", args, reason: "not an email send" };
  if (policy === "allow") return { action: "allow", args, reason: "email policy: allow" };
  const recipients = extractRecipients(args);
  const external = recipients.filter((r) => !selves.has(r));
  const allSelf = recipients.length > 0 && external.length === 0;
  if (allSelf) return { action: "allow", args, reason: "all recipients are your own accounts" };
  const who = external.length ? external.join(", ") : "recipients resolved by the thread (reply/forward)";
  if (policy === "self-only") {
    return { action: "refuse", args, reason: `blocked by your email guardrail (self-only): would reach ${who}` };
  }
  // draft-others: transform to a Gmail draft the user reviews and sends by hand.
  const drafted = args.includes("--draft") ? args : [...args, "--draft"];
  return { action: "draft", args: drafted, reason: `saved as a DRAFT per your email guardrail: would reach ${who}. Review and send it yourself from Gmail.` };
}
