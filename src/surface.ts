// surface — `prevail surface [<domain>] --json [--force]`.
//
// Proactive insights: the engine looks at a domain's distilled memory, state,
// recent decisions, and journal, then asks a cheap model to surface the sharp
// questions worth resolving + concrete next actions. The result is cached at
// `<domain>/_surface.json` (6h TTL) and regenerated on demand or with --force.
//
// This is the engine twin of the desktop's surface.rs (domain_surface): same
// prompt, same JSON shape, same cache file — so the desktop, the TUI, and the
// CLI all read/write one cache interchangeably. Under Bunker / --local-only the
// generation transparently runs on a local model (insights are useful offline);
// it only hard-fails when no local engine is up.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { detectClis, runChatTurn, type AvailableCli } from "./cli-bridge.ts";
import { domainDir } from "./decisions.ts";
import { scanVault } from "./vault.ts";

const TTL_MS = 6 * 60 * 60 * 1000; // 6h, matches surface.rs

export interface SurfaceResult {
  questions: string[];
  actions: string[];
  generated_at: number; // epoch ms
  stale: boolean;
}

// Pull the head of a file (if present) under a labeled section.
function readHead(path: string, label: string, max: number): string {
  try {
    if (!existsSync(path)) return "";
    const s = readFileSync(path, "utf8").trim();
    if (!s) return "";
    return `## ${label}\n${s.slice(0, max)}\n\n`;
  } catch {
    return "";
  }
}

// Compact context blob: distilled memory + state + recent decisions/journal.
function gatherContext(dir: string): string {
  let out = "";
  out += readHead(join(dir, "_memory.md"), "Long-term memory", 2400);
  out += readHead(join(dir, "state.md"), "Current state", 2400);
  out += readHead(join(dir, "_journal", "decisions.md"), "Recent decisions", 1600);
  out += readHead(join(dir, "_journal", "facts.md"), "Known facts", 1600);
  return out.trim();
}

function buildPrompt(domain: string, context: string): string {
  return (
    `You are an expert ${domain} coach reviewing this person's "${domain}" space. ` +
    `Talk like a sharp, practical human advisor — never like a system reporting file ` +
    `status. Based ONLY on the context below, return STRICT JSON (no prose, no code ` +
    `fence): {"questions": [3-5 sharp, specific questions worth resolving that ` +
    `reference their actual situation], "actions": [3-5 concrete, high-leverage next ` +
    `steps]}.\n` +
    `RULES for actions: each must be specific and doable — name the exact document to ` +
    `add, the data to gather, the decision to make, or the task to schedule. If ` +
    `something important is MISSING, turn it into a concrete fetch/add step. Build on ` +
    `decisions already made; never re-ask a settled question. Keep each item under ~110 ` +
    `chars.\n\n--- CONTEXT ---\n${context}`
  );
}

// Tolerant parse — extract the first {...} block and read questions/actions.
function parseSurface(output: string): { questions: string[]; actions: string[] } {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  const empty = { questions: [] as string[], actions: [] as string[] };
  if (start === -1 || end <= start) return empty;
  try {
    const v = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
    const arr = (k: string): string[] =>
      Array.isArray(v[k])
        ? (v[k] as unknown[]).map((x) => String(x).trim()).filter((s) => s.length > 0)
        : [];
    return { questions: arr("questions"), actions: arr("actions") };
  } catch {
    return empty;
  }
}

function cachePath(dir: string): string {
  return join(dir, "_surface.json");
}

// Pick the engine for surface generation. Under local-only we require a local
// CLI; otherwise prefer the first detected CLI (cheap, single call).
function pickCli(available: AvailableCli[], localOnly: boolean): AvailableCli | null {
  const pool = localOnly ? available.filter((c) => c.kind === "ollama") : available;
  return pool[0] ?? null;
}

export interface SurfaceOptions {
  vaultPath: string;
  domain: string;
  force?: boolean;
  localOnly?: boolean;
  signal?: AbortSignal;
}

export async function runSurface(opts: SurfaceOptions): Promise<SurfaceResult> {
  const vaultPath = resolve(opts.vaultPath);
  const general = !opts.domain || opts.domain === "general" || opts.domain === "__general__";
  const dir = domainDir(vaultPath, general ? null : opts.domain);
  const cache = cachePath(dir);

  // Serve fresh cache unless forced.
  if (!opts.force && existsSync(cache)) {
    try {
      const r = JSON.parse(readFileSync(cache, "utf8")) as SurfaceResult;
      if (Date.now() - (r.generated_at ?? 0) < TTL_MS) {
        return { ...r, stale: false };
      }
    } catch {
      /* fall through and regenerate */
    }
  }

  const context = gatherContext(dir);
  const prompt = buildPrompt(general ? "general" : opts.domain, context);
  const localOnly = opts.localOnly ?? process.env.PREVAIL_BUNKER === "1";
  const cli = pickCli(await detectClis(), localOnly);
  if (!cli) {
    throw new Error(
      localOnly ? "no local engine available (start Ollama to surface insights in Bunker Mode)" : "no AI CLI detected",
    );
  }

  const raw = await runChatTurn({
    prompt,
    cwd: dir,
    cli,
    model: "",
    isFirst: true,
    bare: true,
    signal: opts.signal,
    maxOutputChars: 4000,
  });
  const parsed = parseSurface(raw);
  if (parsed.questions.length === 0 && parsed.actions.length === 0) {
    throw new Error("could not parse a surface from the model output");
  }
  const result: SurfaceResult = { ...parsed, generated_at: Date.now(), stale: false };
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cache, JSON.stringify(result, null, 2));
  } catch {
    /* cache write best-effort */
  }
  return result;
}

// argv handler for `prevail surface [<domain>] --json [--force]`.
export async function surfaceCommand(args: string[], vaultOverride: string | null): Promise<number> {
  let domain = "";
  let force = false;
  let localOnly = false;
  let json = false;
  let vaultPath = vaultOverride;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--force") force = true;
    else if (a === "--local-only") localOnly = true;
    else if (a === "--vault" || a === "-d") {
      const next = args[i + 1];
      if (next) {
        vaultPath = resolve(process.cwd(), next);
        i++;
      }
    } else if (a.startsWith("--vault=")) vaultPath = resolve(process.cwd(), a.slice("--vault=".length));
    else if (!a.startsWith("-")) domain = a;
  }
  const { readConfig, bundledDemoVaultPath } = await import("./config.ts");
  const vault = vaultPath ?? readConfig()?.vaultPath ?? bundledDemoVaultPath();
  const emitErr = (msg: string, code: string): number => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: msg, code })}\n`);
    return 1;
  };
  if (!json) {
    console.error("prevail surface is a machine-only command — pass --json.");
    return 1;
  }
  if (!existsSync(vault)) return emitErr(`vault path not found: ${vault}`, "VAULT_NOT_FOUND");
  if (domain && !general(domain)) {
    const found = scanVault(vault).find((d) => d.name === domain);
    if (!found) return emitErr(`unknown domain: ${domain}`, "UNKNOWN_DOMAIN");
  }
  try {
    const result = await runSurface({ vaultPath: vault, domain, force, localOnly });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    return emitErr((err as Error).message, "SURFACE_FAILED");
  }
}

function general(domain: string): boolean {
  return !domain || domain === "general" || domain === "__general__";
}
