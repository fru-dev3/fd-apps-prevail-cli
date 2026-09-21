// Wiring: config plus environment plus the privacy gate, resolved into either
// a provider or a reason there isn't one.
//
// Everything that decides WHETHER the decision layer runs lives here, so the
// call sites stay a single function call and the gate cannot be forgotten at
// one of them.

import { readDecisionMode, readDecisionPrivacy, readDecisionProvider } from "./config.ts";
import type { DecisionProvider } from "./decision.ts";
import { TypeSafeProvider } from "./decision-typesafe.ts";
import type { StatePrivacy } from "./decision-routing.ts";

/**
 * Preferred key name. The PREVAIL_ prefix is deliberate: scrubbedEnv() in
 * cli-bridge strips anything matching API_KEY / TOKEN / _SECRET before
 * spawning a model subprocess, and PREVAIL_*_KEY is the allowlist carve-out
 * every other provider key already uses.
 */
const KEY_ENV = "PREVAIL_TYPESAFE_KEY";
/** What the vendor's own SDK reads, accepted as a fallback. */
const KEY_ENV_ALT = "TYPESAFE_API_KEY";

/** Where a user can put a key, in the order we look. For status output. */
export const KEY_SOURCES = [
  `${KEY_ENV} (preferred)`,
  KEY_ENV_ALT,
  `either of those holding a 1Password reference, e.g. ${KEY_ENV}='op://Vault/Item/field'`,
];

/**
 * Whoever runs Prevail brings their own key.
 *
 * There is deliberately no bundled default and no fallback key anywhere in
 * this repository. With none of the sources below set, the layer reports
 * itself off and Prevail routes exactly as it did before it existed. Nothing
 * here writes a key to disk or logs one.
 *
 * A value beginning `op://` is treated as a 1Password reference and resolved
 * through the `op` CLI, so the secret never has to sit in a shell profile or
 * a process listing. That resolution is opt-in (the user writes the
 * reference), memoized for the life of the process, and a failure is
 * remembered so a locked vault does not re-prompt on every request.
 */
export function decisionApiKey(): string | null {
  const raw = (process.env[KEY_ENV] || process.env[KEY_ENV_ALT] || "").trim();
  if (!raw) return null;
  if (!raw.startsWith("op://")) return raw;
  return resolveOpReference(raw);
}

/**
 * Measured on a warm machine, `op read` takes anywhere from 1.2s to 7.5s. That
 * is far too slow and far too variable to sit on a request path, so it never
 * does: the first call that needs it starts the lookup in the BACKGROUND and
 * reports no key, which simply leaves the layer off for that one turn. Every
 * later call gets the cached value. Nothing waits, ever.
 */
const OP_TIMEOUT_MS = 20_000;

const opCache = new Map<string, string | null>();
const opInFlight = new Map<string, Promise<void>>();

function resolveOpReference(ref: string): string | null {
  if (opCache.has(ref)) return opCache.get(ref) ?? null;
  void warmOpReference(ref);
  return null;
}

function warmOpReference(ref: string): Promise<void> {
  const existing = opInFlight.get(ref);
  if (existing) return existing;
  const p = new Promise<void>((resolve) => {
    try {
      const { execFile } = require("node:child_process") as typeof import("node:child_process");
      // stdin is closed so `op` fails fast rather than waiting to prompt.
      execFile("op", ["read", ref], { timeout: OP_TIMEOUT_MS, encoding: "utf8" }, (err, stdout) => {
        opCache.set(ref, err ? null : (String(stdout).trim() || null));
        opInFlight.delete(ref);
        resolve();
      }).stdin?.end();
    } catch {
      opCache.set(ref, null);
      opInFlight.delete(ref);
      resolve();
    }
  });
  opInFlight.set(ref, p);
  return p;
}

/**
 * Wait for a pending 1Password lookup. For commands that want a definite
 * answer (status, report) rather than a fast one. Never used on a turn.
 */
export async function warmDecisionKey(): Promise<string | null> {
  const raw = (process.env[KEY_ENV] || process.env[KEY_ENV_ALT] || "").trim();
  if (!raw) return null;
  if (!raw.startsWith("op://")) return raw;
  if (!opCache.has(raw)) await warmOpReference(raw);
  return opCache.get(raw) ?? null;
}

/** Test seam, and a way to retry after unlocking 1Password. */
export function resetDecisionKeyCache(): void {
  opCache.clear();
  opInFlight.clear();
}

/**
 * Is the machine allowed to talk to a third-party decision service at all?
 *
 * A decision model is a network call carrying part of the user's request, so
 * Bunker Mode disables the entire layer. There is no local decision provider
 * to fall back to, and quietly sending the request to a cloud service because
 * "it is only routing" is exactly the kind of thing Bunker Mode exists to
 * prevent. This mirrors how provider keys are simply never injected under
 * Bunker rather than being injected and politely unused.
 */
export function decisionEgressAllowed(): boolean {
  return process.env.PREVAIL_BUNKER !== "1";
}

export interface ResolvedDecisionLayer {
  provider: DecisionProvider | null;
  /** True only when signals may actually change routing. */
  live: boolean;
  privacy: StatePrivacy;
  /** Why there is no provider. Null when there is one. */
  reason: string | null;
}

/**
 * Resolve the decision layer for this process. Cheap and side-effect free, so
 * it is fine to call per request; nothing here touches the network.
 */
export function resolveDecisionLayer(opts: { egressAllowed?: boolean } = {}): ResolvedDecisionLayer {
  const privacy = readDecisionPrivacy();
  const off = (reason: string): ResolvedDecisionLayer => ({ provider: null, live: false, privacy, reason });

  const egress = opts.egressAllowed ?? decisionEgressAllowed();
  if (!egress) return off("Bunker Mode: the decision layer is a cloud call");

  const id = readDecisionProvider();
  if (id === "off") return off("decision layer is off");

  const key = decisionApiKey();
  if (!key) return off(`no API key (set ${KEY_ENV})`);

  if (id === "typesafe") {
    return {
      provider: new TypeSafeProvider({
        apiKey: () => key,
        // Override for a self-hosted gateway, an enterprise proxy, or a stub
        // in tests. Unset in normal use, where the vendor's own URL applies.
        endpoint: process.env.PREVAIL_TYPESAFE_URL || undefined,
      }),
      // Shadow unless explicitly live. Checked here rather than at the call
      // site so no surface can accidentally run the layer in live mode.
      live: readDecisionMode() === "live",
      privacy,
      reason: null,
    };
  }
  return off(`unknown decision provider "${id}"`);
}

/**
 * Process-lifetime cache. The provider holds a circuit breaker, and a fresh
 * instance per request would forget that the service is currently down and
 * keep paying the timeout on every turn.
 */
let cached: { key: string; layer: ResolvedDecisionLayer } | null = null;

export function decisionLayer(opts: { egressAllowed?: boolean } = {}): ResolvedDecisionLayer {
  const egress = opts.egressAllowed ?? decisionEgressAllowed();
  // Cache key covers everything that would change the answer, so editing the
  // config file takes effect on the next turn instead of needing a restart.
  const k = `${egress}|${readDecisionProvider()}|${readDecisionMode()}|${readDecisionPrivacy()}|${decisionApiKey() ? "k" : "-"}`;
  if (cached && cached.key === k) return cached.layer;
  const layer = resolveDecisionLayer({ egressAllowed: egress });
  cached = { key: k, layer };
  return layer;
}

/** Test seam. */
export function resetDecisionLayerCache(): void {
  cached = null;
}
