import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { Domain, ViewKey } from "./vault.ts";
import { readResponseFramework, readWebAccess } from "./config.ts";
import { buildFrameworkPreamble, getFramework } from "./framework.ts";
import { resolveModelForDomain } from "./privacy.ts";
import {
  type BudgetCaps,
  checkBudget,
  estimateTurnCost,
  recordSpend,
} from "./budget.ts";

const OPERATING_MANUAL_FILE = "AGENTS-operating.md";
let operatingManualCache: { vaultPath: string; content: string | null } | null = null;

function findOperatingManual(vaultPath: string): string | null {
  if (operatingManualCache && operatingManualCache.vaultPath === vaultPath) {
    return operatingManualCache.content;
  }
  const candidates: string[] = [
    join(vaultPath, OPERATING_MANUAL_FILE),
    join(homedir(), ".prevail", OPERATING_MANUAL_FILE),
  ];
  try {
    candidates.push(resolve(dirname(process.execPath), OPERATING_MANUAL_FILE));
  } catch {}
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(resolve(here, "..", OPERATING_MANUAL_FILE));
  } catch {}
  let content: string | null = null;
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        content = readFileSync(c, "utf8");
        break;
      } catch {}
    }
  }
  operatingManualCache = { vaultPath, content };
  return content;
}

export function refreshOperatingManualCache(): void {
  operatingManualCache = null;
}

// "ollama" is an OpenAI-compatible HTTP endpoint (default
// http://localhost:11434/v1) — covers Ollama, LM Studio, llama.cpp
// server, vLLM, anything that speaks OpenAI's /chat/completions schema.
// Treated as a 4th "engine" alongside the three subprocess CLIs so the
// rest of the code can fan out to it through the same runChatTurn path.
// CliKind — the canonical id for each AI engine prevAIl talks to.
//
// 2026-06-04: Google replaced their `gemini` CLI with `agy` (Antigravity).
// Gemini CLI shuts down on 2026-06-18, so prevAIl now ships with
// "antigravity" as the canonical kind. The `agy` binary is preferred at
// detection time; the legacy `gemini` binary still works as a fallback
// during the transition window. Old configs that still say `"gemini"`
// are silently migrated to `"antigravity"` on first read (see
// migrateLegacyCliKind in src/config.ts).
// CliKind is single-sourced in config.ts; imported for local use and re-exported
// so existing `import { CliKind } from "./cli-bridge"` sites keep working.
import type { CliKind } from "./config.ts";
export type { CliKind };

// Legacy CliKind values from earlier versions of prevAIl. Listed here as
// a string union (NOT part of the live CliKind type) so config-migration
// code can spell them without losing type-safety on the consumer side.
export type LegacyCliKind = "gemini";

// SECURITY: env vars that look like provider/operator secrets are stripped
// when spawning subprocess CLIs. The CLIs read their own auth files
// (~/.claude/, ~/.codex/, ~/.config/gcloud/) so they don't NEED these in the
// env, but inheriting them creates a prompt-injection exfiltration channel —
// a tool-using panelist that runs `env | grep TOKEN` would dump the
// operator's Telegram bot token and any API keys into a reply that lands in
// the vault log and ships to Telegram. Belt-and-suspenders: even if a
// model never voluntarily ran `env`, prompt injection inside vault content
// could trick it.
const SECRET_ENV_PREFIXES = [
  "PREVAIL_TELEGRAM_",
  "ANTHROPIC_API_",
  "OPENAI_API_",
  "GOOGLE_API_",
  "GEMINI_API_",
  "TELEGRAM_BOT_",
  "AWS_",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OP_SERVICE_ACCOUNT_TOKEN",
];
const SECRET_ENV_SUBSTRINGS = ["_SECRET", "_PRIVATE_KEY", "_PASSWORD"];

export function scrubbedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (SECRET_ENV_SUBSTRINGS.some((s) => k.includes(s))) continue;
    out[k] = v;
  }
  return out;
}

export interface AvailableCli {
  kind: CliKind;
  bin: string;
  label: string;
}

const CANDIDATES: { kind: CliKind; bins: string[]; label: string }[] = [
  { kind: "claude", bins: ["claude"], label: "Claude" },
  { kind: "codex", bins: ["codex"], label: "Codex" },
  // The first detected binary wins. `agy` (Antigravity, Google's
  // 2026-05-19 successor to Gemini CLI) is preferred; `gemini` is kept
  // as a fallback during the transition window (Google shuts the
  // legacy CLI down 2026-06-18). Drop `gemini` from this list after
  // that date.
  { kind: "antigravity", bins: ["agy", "gemini"], label: "Antigravity" },
];

// Ollama / OpenAI-compatible local-model endpoint. Override via env var.
// Probed at launch and treated as available iff GET /api/tags responds.
export const OLLAMA_BASE_URL = process.env.PREVAIL_OLLAMA_URL || "http://localhost:11434";
export const OLLAMA_DEFAULT_MODEL = process.env.PREVAIL_OLLAMA_MODEL || "llama3.1";

export const CLI_MODEL_HINT: Record<CliKind, string> = {
  claude: "e.g. opus, sonnet, haiku, or full id like claude-opus-4-7",
  codex: "e.g. gpt-5, gpt-5.4, o3 (whatever your codex install accepts)",
  ollama: "e.g. llama3.1, mistral, qwen2.5 — must be already pulled locally (`ollama pull <name>`)",
  antigravity: 'e.g. "Gemini 3.1 Pro (High)", "Gemini 3.5 Flash (Medium)" — run `agy models` for the full list (Antigravity now uses display names, not short ids)',
  openrouter: "e.g. anthropic/claude-opus-4.1, openai/gpt-5.1, google/gemini-2.5-pro — any model id from openrouter.ai/models",
};

// Quick-pick chips shown in the council config bubble. Two tiers:
//
// 1. ALIASES — the short names the CLI resolves to its latest version
//    ("opus" → latest claude opus). Useful when you don't care about pinning.
//
// 2. VERSIONS — specific full model IDs so you can compare e.g. claude-opus-4-7
//    vs claude-opus-4-8 in the same council run. THIS is what makes
//    cross-model compare actually possible from the UI. We can't query the
//    CLIs for these (none of them expose a models list endpoint — verified),
//    so the list is hand-maintained per provider. Slash command
//    `/council model <cli> add <name>` still works for anything missing.
//
// Add new versions here when providers ship them. Stale entries are
// harmless — the CLI rejects them and the panelist returns an error bubble.
const CLAUDE_ALIASES = ["opus", "sonnet", "haiku"];
const CLAUDE_VERSIONS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];
const CODEX_VERSIONS = ["gpt-5.4", "gpt-5", "gpt-5-codex", "o3"];
// Antigravity (`agy`) uses display-style model names that include
// thinking-budget suffixes — verified via `agy models`. These are passed
// to `--model` verbatim. The list will need updating as Google ships new
// Gemini generations through Antigravity. To refresh against your local
// install: `agy models`.
const ANTIGRAVITY_VERSIONS = [
  "Gemini 3.1 Pro (High)",
  "Gemini 3.1 Pro (Low)",
  "Gemini 3.5 Flash (High)",
  "Gemini 3.5 Flash (Medium)",
  "Gemini 3.5 Flash (Low)",
  // Antigravity also exposes other providers through the same launcher:
  "Claude Sonnet 4.6 (Thinking)",
  "Claude Opus 4.6 (Thinking)",
  "GPT-OSS 120B (Medium)",
];

// Common Ollama tags — covers the models most users have already pulled.
// Replaced at runtime by the real list from /api/tags when ollama is detected.
const OLLAMA_VERSIONS = ["llama3.1", "llama3.2", "mistral", "qwen2.5", "phi3", "gemma2"];

// Each CLI's default model — what the CLI runs when we DON'T pass an
// explicit --model arg. We can't query the CLIs for this (none expose a
// "what's your default" endpoint), so the list is hand-maintained from
// the same first-entry rule as the version lists above. Used by the
// per-bubble badge in the chat transcript so EVERY council panelist
// shows a complete `<cli> · <model>` label — without this, panelists
// running on default models showed just `claude` / `codex` and the
// user reported "the rest don't tell me which model is responding."
// OpenRouter routed model ids (provider/model). One key, every model.
export const OPENROUTER_MODELS: string[] = [
  "anthropic/claude-opus-4.1",
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-5.1",
  "google/gemini-2.5-pro",
  "x-ai/grok-4",
  "deepseek/deepseek-chat",
  "qwen/qwen-2.5-72b-instruct",
  "meta-llama/llama-3.3-70b-instruct",
];

const CLI_DEFAULT_MODELS: Record<CliKind, string> = {
  claude: CLAUDE_VERSIONS[0]!,
  codex: CODEX_VERSIONS[0]!,
  antigravity: ANTIGRAVITY_VERSIONS[0]!,
  ollama: OLLAMA_DEFAULT_MODEL,
  openrouter: OPENROUTER_MODELS[0]!,
};

export function defaultModelFor(kind: CliKind): string {
  return CLI_DEFAULT_MODELS[kind];
}

// Versioned IDs come FIRST so the picker always shows real version numbers
// at a glance (claude-opus-4-7, not just "opus"). Naked aliases live at the
// end as a fallback for users who don't care which generation runs — the
// CLI itself resolves "opus" → its current default. This was a long-standing
// UX bug: with aliases first, the picker visually read as "opus / sonnet /
// haiku ..." and users couldn't tell which version of each they'd actually
// get without typing /model.
export const MODEL_QUICKPICKS_FALLBACK: Record<CliKind, string[]> = {
  claude: [...CLAUDE_VERSIONS, ...CLAUDE_ALIASES],
  codex: CODEX_VERSIONS,
  antigravity: ANTIGRAVITY_VERSIONS,
  ollama: OLLAMA_VERSIONS,
  openrouter: OPENROUTER_MODELS,
};

// Run `<bin> --help` and pull every quoted token that looks like a model
// alias or full id. None of the three CLIs ship a real `models list`
// endpoint, so this is the closest we get to "what does THIS install
// actually know about" — it picks up new aliases as the CLI's own docs
// update. Codex/Gemini hint less than Claude; the fallback fills the gap.
export async function discoverModelHints(cli: AvailableCli, timeoutMs = 4000): Promise<string[]> {
  const help = await new Promise<string>((resolve) => {
    let out = "";
    let settled = false;
    let child;
    try {
      child = spawn(cli.bin, ["--help"], {
        env: scrubbedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child!.kill(); } catch {}
      resolve(out);
    }, timeoutMs);
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (out += b.toString()));
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    });
  });
  if (!help) return [];
  // Grab any single- or double-quoted token that looks model-ish: kebab/
  // dot/digit + letters. Tightly scoped so we don't pull random words.
  const re = /['"]([a-zA-Z][a-zA-Z0-9._-]{2,40})['"]/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(help)) !== null) {
    const tok = m[1]!;
    if (looksLikeModel(cli.kind, tok)) found.add(tok);
  }
  return Array.from(found);
}

function looksLikeModel(kind: CliKind, t: string): boolean {
  const low = t.toLowerCase();
  if (kind === "claude") {
    return (
      low === "opus" ||
      low === "sonnet" ||
      low === "haiku" ||
      low.startsWith("claude-")
    );
  }
  if (kind === "codex") {
    return /^(gpt|o\d|chatgpt)/.test(low);
  }
  if (kind === "antigravity") {
    return low.startsWith("gemini") || low.startsWith("gemma");
  }
  if (kind === "ollama") {
    // Ollama tags come from /api/tags at runtime — looksLikeModel is only
    // used by the --help scraper which doesn't apply to ollama.
    return true;
  }
  return false;
}

// Back-compat: callers that read MODEL_QUICKPICKS still work but only see
// the fallback. App.tsx replaces this at runtime with the discovered list
// once probes complete.
export const MODEL_QUICKPICKS: Record<CliKind, string[]> = MODEL_QUICKPICKS_FALLBACK;

export function formatModelBadge(model: string | null | undefined): string {
  if (!model || !model.trim()) return "default";
  return model.trim();
}

export interface CliHealth {
  ok: boolean;
  message: string;
  hint?: string;
}

// Recognize common provider/environment errors and turn them into actionable
// remediation hints. The error strings are matched conservatively; if no rule
// matches the user just sees the raw stderr, which is still useful.
function classifyProbeError(cli: CliKind, output: string): string | undefined {
  const o = output.toLowerCase();
  if (cli === "codex") {
    if (o.includes("not supported when using codex with a chatgpt account")) {
      return "your ChatGPT-account auth doesn't allow this model. Either run `codex login` to switch to an OpenAI API key, or set a model your subscription supports via `/council model codex <name>` (or codex's interactive picker).";
    }
    if (o.includes("not inside a trusted directory")) {
      return "codex blocked an untrusted directory. The wrapper passes `--skip-git-repo-check`; if you see this, check ~/.codex/config.toml for restrictive `[projects]` rules.";
    }
    if (o.includes("rate limit") || o.includes("quota")) {
      return "codex hit a rate limit or quota cap on your account.";
    }
  }
  if (cli === "antigravity") {
    // Antigravity inherits a lot of Gemini's CLI surface — hook errors,
    // trust gates, quota errors all look similar. Some legacy strings
    // still mention `gemini` because Antigravity's error text shows
    // through unchanged on certain code paths.
    if (o.includes("agent execution blocked") || o.includes("hook(s)") || o.includes("hook execution")) {
      return "Antigravity's BeforeAgent/AfterAgent hooks are blocking execution. Check ~/.gemini/settings.json (or wherever agy stores its hooks) and either fix the hook script path or remove the broken `hooks` entries.";
    }
    if (o.includes("not running in a trusted") || o.includes("trusted")) {
      return "Antigravity blocked an untrusted folder. The wrapper passes `--skip-trust`; if you still see this, the workspace sandbox in agy's settings may be restricting reach.";
    }
    if (o.includes("quota") || o.includes("rate")) {
      return "Antigravity hit a quota or rate limit.";
    }
  }
  return undefined;
}

// Smoke-test a CLI by running a real one-shot prompt through the same args
// path the council uses (no operating manual, no model — keeps it cheap).
// `--version` would only catch a totally broken install; the actual failure
// modes we see in council mode (ChatGPT-subscription model gating for codex,
// stale hooks for gemini, missing auth) only surface when the model is hit.
// Timeout is generous because cold cli startup + a small model call can take
// 15-20s on slow networks.
export function probeCli(cli: AvailableCli, timeoutMs = 45000): Promise<CliHealth> {
  const probePrompt = "Reply with the single word: ready";
  // Ollama is an HTTP endpoint, not a subprocess — probe it by running a
  // tiny chat completion via the same path runChatTurn uses. Short timeout
  // since we already know the daemon is up (detectOllama confirmed) and a
  // 6B model should reply to "say ready" in well under 5s.
  if (cli.kind === "ollama") {
    return runOllamaChat({
      baseUrl: cli.bin,
      model: OLLAMA_DEFAULT_MODEL,
      prompt: probePrompt,
    }).then((reply) => {
      if (reply.startsWith("(ollama:")) {
        // Model-not-pulled is the overwhelmingly common error; surface a
        // friendly hint instead of the raw HTTP body.
        const hint = /model.*not.*found|not.*available|pull/i.test(reply)
          ? `model "${OLLAMA_DEFAULT_MODEL}" isn't pulled. Run \`ollama pull ${OLLAMA_DEFAULT_MODEL}\` or set PREVAIL_OLLAMA_MODEL to one you already have.`
          : undefined;
        return { ok: false, message: reply.slice(0, 220), hint };
      }
      return { ok: true, message: `ready (${OLLAMA_DEFAULT_MODEL})` };
    });
  }
  // Build the exact same argv shape runChatTurn would for a manual-less,
  // model-default, fresh-session turn. Reusing buildCliArgs guarantees the
  // probe exercises the real codepath.
  const args = buildCliArgs({
    cli: cli.kind,
    prompt: probePrompt,
    model: "",
    isFirst: true,
    manual: null,
  });
  return new Promise((resolveProbe) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    try {
      // stdin MUST be "ignore" — with the default "pipe", codex exec blocks
      // forever waiting for input from the (open) stdin pipe and never starts
      // the model call. Spent half a day on this; do not "fix" back to pipe.
      child = spawn(cli.bin, args, {
        env: scrubbedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolveProbe({ ok: false, message: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child!.kill();
      } catch {}
      resolveProbe({
        ok: false,
        message: `probe timed out after ${timeoutMs / 1000}s`,
        hint:
          cli.kind === "codex"
            ? "codex cold-start can be slow; if it works in /council later, this is just startup latency."
            : undefined,
      });
    }, timeoutMs);
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe({ ok: false, message: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = (stdout + "\n" + stderr).trim();
      // Treat as ok only if exit was clean AND output contains *something*
      // resembling a model reply. Codex/gemini sometimes exit 0 even after
      // an ERROR line, so look for "ready" in stdout to confirm a real call.
      const looksReady = stdout.toLowerCase().includes("ready");
      if (code === 0 && looksReady) {
        resolveProbe({ ok: true, message: "real prompt succeeded" });
        return;
      }
      // Pull the first error-ish line to keep the message short.
      const firstErrLine =
        combined
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.toLowerCase().includes("error") || l.toLowerCase().includes("blocked") || l.toLowerCase().includes("not supported")) ||
        combined.split("\n")[combined.split("\n").length - 1] ||
        `exited ${code}`;
      const hint = classifyProbeError(cli.kind, combined);
      resolveProbe({
        ok: false,
        message: firstErrLine.slice(0, 220),
        hint,
      });
    });
  });
}

// Synchronous half — finds the three subprocess CLIs on $PATH. Split out so
// callers that need a fast "what binaries do we have" answer don't pay the
// HTTP roundtrip cost of probing Ollama. detectClis() composes this with the
// async Ollama probe.
export function detectSubprocessClis(): AvailableCli[] {
  const paths = (process.env.PATH ?? "").split(":");
  const out: AvailableCli[] = [];
  for (const c of CANDIDATES) {
    for (const bin of c.bins) {
      const found = paths
        .map((p) => join(p, bin))
        .find((full) => {
          try {
            return existsSync(full);
          } catch {
            return false;
          }
        });
      if (found) {
        out.push({ kind: c.kind, bin: found, label: c.label });
        break;
      }
    }
  }
  return out;
}

// Quick health check for Ollama / any OpenAI-compatible endpoint. GET /api/tags
// is the native Ollama endpoint and 200's instantly if the daemon is up.
// For non-Ollama OpenAI-compatibles (LM Studio, llama.cpp server), /api/tags
// returns 404 — we fall back to /v1/models which every OpenAI-compat
// implementation exposes. A 200 from either is enough to call it available.
// Returns null if nothing's listening. 1.5s timeout — local should be instant.
export async function detectOllama(): Promise<AvailableCli | null> {
  const base = OLLAMA_BASE_URL.replace(/\/+$/, "");
  const tryUrls = [`${base}/api/tags`, `${base}/v1/models`];
  for (const url of tryUrls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        return {
          kind: "ollama",
          bin: base,
          label: base.includes("11434") ? "Ollama" : "Local",
        };
      }
    } catch {
      // network error / timeout — try next URL
    }
  }
  return null;
}

// Async detection — subprocess CLIs (sync) + Ollama (HTTP probe in parallel).
// Used at app launch and by `prevail daemon`. Callers that don't care about
// Ollama can use detectSubprocessClis() directly.
export async function detectClis(): Promise<AvailableCli[]> {
  const subprocess = detectSubprocessClis();
  const ollama = await detectOllama();
  const out = ollama ? [...subprocess, ollama] : subprocess;
  // OpenRouter is "available" iff a key is present (it's an HTTP gateway, not
  // a binary). The desktop injects PREVAIL_OPENROUTER_KEY from the Keychain.
  if (process.env.PREVAIL_OPENROUTER_KEY) {
    out.push({ kind: "openrouter", bin: "https://openrouter.ai/api/v1", label: "OpenRouter" });
  }
  return out;
}

// Pull the actually-installed Ollama models so the model picker can offer
// real options instead of the static fallback. Returns null if Ollama isn't
// reachable or the response can't be parsed. Used by the model-discovery
// pass in app.tsx the same way --help is scraped for claude/codex/gemini.
export async function discoverOllamaModels(): Promise<string[] | null> {
  try {
    const base = OLLAMA_BASE_URL.replace(/\/+$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${base}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    if (!Array.isArray(body.models)) return null;
    const names = body.models
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    return names.length > 0 ? names : null;
  } catch {
    return null;
  }
}

export interface SpawnResult {
  ok: boolean;
  message: string;
}

export function runExternal(
  bin: string,
  args: string[],
  cwd: string,
): SpawnResult {
  try {
    const r = spawnSync(bin, args, {
      stdio: "inherit",
      cwd,
      env: scrubbedEnv(),
    });
    if (r.error) return { ok: false, message: r.error.message };
    if (r.status !== 0 && r.status !== null) {
      return { ok: true, message: `exited with code ${r.status}` };
    }
    return { ok: true, message: "" };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export function buildChatPrompt(domain: Domain, view: ViewKey): string {
  const angles: Record<ViewKey, string> = {
    state: "Walk me through the current state. What stands out, and what should I act on first?",
    loops: "Look at the unchecked items in state.md's Open Items section. What's the right order, what should I drop, and is anything missing?",
    quickstart: "I'm new to this domain — give me a 60-second tour using QUICKSTART.md.",
    prompts: "Use the prompts in PROMPTS.md to interview me on what's changed since last update.",
    skills: "List the skills available for this domain and offer to run any that look most useful right now.",
  };
  return `You are helping with the "${domain.name}" life domain. The vault lives at ${domain.path}. Start by reading state.md.\n\n${angles[view]}`;
}

export interface ChatTurn {
  prompt: string;
  cwd: string;
  cli: AvailableCli;
  model: string;
  isFirst: boolean;
  // Council Q&A calls pass bare=true to suppress the operating-manual
  // preamble. The manual is multi-kB of agent-onboarding text — useful for
  // normal chat sessions where the panelist takes follow-up actions, but
  // pure noise for a one-shot question/answer/synthesize. It also caused
  // codex to echo the manual verbatim back into the response bubble when it
  // exited non-zero, polluting the transcript.
  bare?: boolean;
  // Optional cancellation. Aborting the signal SIGTERMs the child process so
  // Escape in the cockpit can drop an in-flight prompt without waiting for
  // the model to finish. runCapture resolves with "(cancelled)" on abort.
  signal?: AbortSignal;
  // Optional incremental-output callback. When set, the runner emits
  // partial text as it arrives from the CLI (chunks streamed from claude
  // --output-format stream-json, codex stdout, gemini stdout, ollama SSE).
  // The final return value is still the complete reply — onChunk just
  // gives the UI something to render while the model is still talking.
  // Each call receives a string delta (NOT the cumulative buffer); the
  // caller does its own accumulation if needed.
  onChunk?: (delta: string) => void;
  // Truncate the cumulative reply at this many characters. When the
  // stream crosses the cap, the child process is SIGKILL'd (same
  // pgroup trick used by abort) and the reply returned to the caller
  // is sliced to maxOutputChars + " (truncated at cap)". Useful for
  // lightweight callers — distillation, classifiers, serendipity —
  // that have no business returning 50KB. Undefined = no cap (today's
  // behavior).
  maxOutputChars?: number;
  // Optional privacy + cost guard (Track E7). Entirely opt-in: when omitted
  // (or with both fields unset) runChatTurn behaves exactly as before. When
  // present it gates the turn BEFORE spawning the model:
  //   - privacy.resolveModelForDomain may redirect a cloud CLI to the local
  //     ollama engine if the domain is localOnly or globalLocalOnly is set.
  //   - budget.checkBudget throws BudgetExceeded if the estimated cost would
  //     breach a per-run / per-day cap; on success the spend is recorded.
  guard?: {
    // Global `--local-only` switch (same convention as src/chat-json.ts).
    localOnly?: boolean;
    // Cost caps. No caps set => budget guard is a no-op.
    budget?: BudgetCaps;
  };
}

const WEB_DENY_NOTE = [
  "<web-access>",
  "The user has globally disabled web access for this cockpit session.",
  "Do NOT use WebSearch, WebFetch, fetch(), curl, or any other tool that",
  "makes outbound HTTP requests. Work only from the vault and local files.",
  "If a question genuinely requires the web, say so plainly and stop —",
  "do not silently proceed without web access.",
  "</web-access>",
].join("\n");

function augmentManualWithWebGate(manual: string | null): string | null {
  const mode = readWebAccess();
  if (mode === "allow") return manual;
  if (!manual) return WEB_DENY_NOTE;
  return `${manual}\n\n${WEB_DENY_NOTE}`;
}

export async function runChatTurn({ prompt, cwd, cli, model, isFirst, bare, signal, onChunk, maxOutputChars, guard }: ChatTurn): Promise<string> {
  // cwd is <vault>/<domain>; the operating manual lives one level up at <vault>/AGENTS-operating.md
  const vaultPath = resolve(cwd, "..");
  const domainKeyForGuard = basename(cwd);

  // --- Track E7: privacy + cost guard (opt-in) -----------------------------
  // Runs BEFORE the model is spawned. With no guard set, both checks are
  // no-ops and the requested engine/model pass through unchanged — preserving
  // the exact behavior every existing caller relies on.
  //
  // 1. Privacy: if the domain is privacy.localOnly (manifest) OR the global
  //    --local-only switch is on, a cloud CLI request is redirected to the
  //    local ollama engine. We mutate `cli`/`model` so the rest of this
  //    function (arg building, spawn, reply extraction) runs against the
  //    resolved engine without further branching.
  // 2. Budget: estimate the turn's cost and checkBudget(); a breach throws
  //    BudgetExceeded out of runChatTurn (callers already catch and surface
  //    runner errors). The spend is recorded after the call completes.
  let budgetEstimate: ReturnType<typeof estimateTurnCost> | null = null;
  if (guard) {
    // Privacy resolution always runs when a guard is present so manifest
    // privacy.localOnly is honored even when the global flag is off.
    const resolved = resolveModelForDomain(
      vaultPath,
      domainKeyForGuard,
      { cli: cli.kind, model },
      { globalLocalOnly: guard.localOnly ?? false },
    );
    if (resolved.cli !== cli.kind) {
      // Redirect to the local engine. The ollama path in runChatTurn keys
      // off cli.bin as the base URL, so swap in the ollama endpoint.
      cli = { kind: resolved.cli, bin: OLLAMA_BASE_URL, label: "Local" };
    }
    model = resolved.model;
    budgetEstimate = estimateTurnCost({ cli: cli.kind, promptChars: prompt.length });
    // Throws BudgetExceeded if this turn would breach a per-run/per-day cap.
    checkBudget(budgetEstimate, guard.budget);
  }

  const m = model.trim();
  // Only claude gets the manual — it has a real --append-system-prompt
  // channel that the model treats as system context (not echoed in output).
  // codex and gemini have no system-prompt flag in their CLIs, so the manual
  // would have to be prepended to the user prompt — and both (codex
  // especially) echo it verbatim into the response bubble, eating screen
  // space. Better to send them a clean prompt.
  const manualForClaude =
    bare || cli.kind !== "claude"
      ? null
      : augmentManualWithWebGate(findOperatingManual(vaultPath));
  // Response framework preamble (BLUF, WIN, SCQA, ...). When set, prepend
  // a bracketed instruction so the model structures its answer in that
  // style. Applies to every CLI and to both single-chat + council. Short
  // enough that even codex (which would otherwise echo) renders cleanly.
  //
  // Resolution: cwd is <vault>/<domain>, so basename(cwd) is the domain
  // key. The lookup checks for a per-domain override first and falls
  // back to the global default. Per-domain overrides are set by the
  // workspace bar chip on a domain workspace.
  const domainKey = basename(cwd);
  const framework = getFramework(readResponseFramework(domainKey));
  const framedPrompt = buildFrameworkPreamble(framework) + prompt;

  // Run the dispatch, then (Track E7) commit the estimated spend to the
  // run/day ledgers. recordSpend is a no-op for free local turns and when no
  // guard was supplied, so this preserves existing behavior. We record AFTER
  // the call resolves so a cancelled / failed-to-spawn turn that never billed
  // still adds to the ledger conservatively (the estimate is pre-flight; exact
  // billing isn't available from the CLIs). Recording on the estimate keeps
  // the per-day wall honest against a runaway loop.
  const reply = await dispatchTurn();
  if (budgetEstimate && guard) recordSpend(budgetEstimate, guard.budget);
  return reply;

  async function dispatchTurn(): Promise<string> {
  if (cli.kind === "claude") {
    const head = isFirst ? ["-p", framedPrompt] : ["--continue", "-p", framedPrompt];
    const args: string[] = [];
    if (m) args.push("--model", m);
    // --append-system-prompt is only meaningful on the first turn; --continue inherits it
    if (manualForClaude && isFirst) args.push("--append-system-prompt", manualForClaude);
    args.push(...head);
    return runCapture(cli.bin, args, cwd, signal, onChunk, maxOutputChars);
  }
  if (cli.kind === "codex") {
    // --skip-git-repo-check: vault dirs aren't git repos; without this codex
    // refuses to run with 'Not inside a trusted directory'.
    const base = ["exec", "--skip-git-repo-check"];
    // Codex's built-in system prompt frames it as a software engineering
    // agent — it refuses non-coding asks with "I'm a coding agent, I can't
    // help with that." For council Q&A (bare=true) this is wrong: the user
    // is asking life-domain advisory questions, not requesting code. Codex
    // doesn't expose a system-prompt override flag, but if the user prompt
    // opens with framing it generally cooperates. Kept short so it doesn't
    // dominate the prompt or leak noticeably in the reply.
    const codexPrompt = bare
      ? `(This is a general advisory question — not a software/coding task. Engage with it directly and give your real opinion.)\n\n${framedPrompt}`
      : framedPrompt;
    const args = m ? [...base, "-m", m, codexPrompt] : [...base, codexPrompt];
    const raw = await runCapture(cli.bin, args, cwd, signal, onChunk, maxOutputChars);
    return extractCodexReply(raw);
  }
  if (cli.kind === "antigravity") {
    // Antigravity (`agy`) and the legacy Gemini CLI (`gemini`) have
    // DIFFERENT flag surfaces, even though prevAIl exposes them as the
    // same panelist:
    //
    //   agy:    --dangerously-skip-permissions    --model <name>   -p
    //   gemini: --skip-trust                      -m <name>        -p
    //
    // Dispatch on the resolved binary basename so the args are right
    // either way. Both invocations produce stdout in the same shape, so
    // extractGeminiReply is reused for both. After 2026-06-18 when
    // Google sunsets the legacy binary, drop the gemini branch.
    const isAgy = /(^|\/)agy$/.test(cli.bin);
    const args: string[] = [];
    if (isAgy) {
      args.push("--dangerously-skip-permissions");
      if (m) args.push("--model", m);
      args.push("-p", framedPrompt);
    } else {
      args.push("--skip-trust");
      if (m) args.push("-m", m);
      args.push("-p", framedPrompt);
    }
    const raw = await runCapture(cli.bin, args, cwd, signal, onChunk, maxOutputChars);
    return extractGeminiReply(raw);
  }
  if (cli.kind === "ollama") {
    return runOllamaChat({
      baseUrl: cli.bin,
      model: m || OLLAMA_DEFAULT_MODEL,
      prompt: framedPrompt,
      signal,
      onChunk,
      maxOutputChars,
    });
  }
  if (cli.kind === "openrouter") {
    // OpenRouter is an OpenAI-compatible HTTP gateway — one key, every model.
    // The key arrives via PREVAIL_OPENROUTER_KEY (set by the desktop on the
    // child; named to avoid scrubbedEnv's OPENAI_/ANTHROPIC_ strip list).
    return runOpenAICompatChat({
      label: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: process.env.PREVAIL_OPENROUTER_KEY ?? "",
      model: m || OPENROUTER_MODELS[0]!,
      prompt: framedPrompt,
      signal,
      onChunk,
      maxOutputChars,
      extraHeaders: { "HTTP-Referer": "https://prevail.sh", "X-Title": "Prevail" },
    });
  }
  return `(no handler for ${cli.kind})`;
  }
}

interface OllamaChatArgs {
  baseUrl: string;
  model: string;
  prompt: string;
  signal?: AbortSignal;
  onChunk?: (delta: string) => void;
  // Same semantics as the runCapture cap — abort the in-flight fetch
  // once the cumulative reply crosses the threshold and return the
  // sliced reply with a " ... (truncated at N chars)" suffix.
  maxOutputChars?: number;
}

// One-shot chat completion against an OpenAI-compatible endpoint (Ollama,
// LM Studio, llama.cpp server, vLLM — all speak the same /v1/chat/completions
// schema). When onChunk is set, uses SSE streaming so the UI can render
// tokens as they arrive; otherwise falls back to the simpler non-stream
// path. Errors are returned as the reply string (prefixed `(ollama: ...)`)
// instead of thrown, so a single panelist failure doesn't blow up the
// whole council fanout.
export async function runOllamaChat(args: OllamaChatArgs): Promise<string> {
  const { baseUrl, model, prompt, signal, onChunk, maxOutputChars } = args;
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  const stream = !!onChunk;
  const body = {
    model,
    stream,
    messages: [{ role: "user", content: prompt }],
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `(ollama: HTTP ${res.status} — ${truncate(text, 200)})`;
    }
    if (!stream) {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      if (data.error?.message) return `(ollama: ${data.error.message})`;
      const content = data.choices?.[0]?.message?.content;
      if (!content) return "(ollama: empty reply)";
      if (typeof maxOutputChars === "number" && content.length > maxOutputChars) {
        return content.slice(0, maxOutputChars) + " ... (truncated at " + maxOutputChars + " chars)";
      }
      return content.trim();
    }
    // SSE stream — each event is `data: { ... }\n\n`, terminated by
    // `data: [DONE]`. Concatenate every choices[0].delta.content into the
    // full reply, emitting each delta as it arrives.
    if (!res.body) return "(ollama: response had no body)";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Process complete SSE events (delimited by \n\n).
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
              error?: { message?: string };
            };
            if (j.error?.message) return `(ollama: ${j.error.message})`;
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) {
              full += delta;
              onChunk!(delta);
            }
          } catch {
            /* malformed event — skip */
          }
        }
      }
      // Output cap. Abort the SSE read once cumulative reply crosses
      // the threshold — same intent as the runCapture pgroup-kill, but
      // for the fetch path. cancel() rejects the reader; we exit cleanly
      // via the truncated-return below.
      if (typeof maxOutputChars === "number" && full.length > maxOutputChars) {
        try { await reader.cancel(); } catch { /* already closed */ }
        return full.slice(0, maxOutputChars) + " ... (truncated at " + maxOutputChars + " chars)";
      }
    }
    return full.trim() || "(ollama: empty reply)";
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name === "AbortError") return "(cancelled)";
    return `(ollama: ${e?.message ?? "request failed"})`;
  }
}

// Generalized OpenAI-compatible chat (OpenRouter + future direct providers).
// Same SSE handling as runOllamaChat, plus an Authorization header and a
// configurable label/base URL. Keeping one implementation means adding the
// direct providers later is just a base-URL + key-account entry.
interface OpenAICompatArgs {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  signal?: AbortSignal;
  onChunk?: (delta: string) => void;
  maxOutputChars?: number;
  extraHeaders?: Record<string, string>;
}
export async function runOpenAICompatChat(args: OpenAICompatArgs): Promise<string> {
  const { label, baseUrl, apiKey, model, prompt, signal, onChunk, maxOutputChars, extraHeaders } = args;
  if (!apiKey) return `(${label}: no API key configured — add it in Settings → Providers)`;
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const stream = !!onChunk;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    ...(extraHeaders ?? {}),
  };
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model, stream, messages: [{ role: "user", content: prompt }] }), signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `(${label}: HTTP ${res.status} — ${truncate(text, 200)})`;
    }
    if (!stream) {
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      if (data.error?.message) return `(${label}: ${data.error.message})`;
      const content = data.choices?.[0]?.message?.content;
      if (!content) return `(${label}: empty reply)`;
      return typeof maxOutputChars === "number" && content.length > maxOutputChars
        ? content.slice(0, maxOutputChars) + " ... (truncated at " + maxOutputChars + " chars)"
        : content.trim();
    }
    if (!res.body) return `(${label}: response had no body)`;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }>; error?: { message?: string } };
            if (j.error?.message) return `(${label}: ${j.error.message})`;
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) { full += delta; onChunk!(delta); }
          } catch { /* malformed event — skip */ }
        }
      }
      if (typeof maxOutputChars === "number" && full.length > maxOutputChars) {
        try { await reader.cancel(); } catch { /* already closed */ }
        return full.slice(0, maxOutputChars) + " ... (truncated at " + maxOutputChars + " chars)";
      }
    }
    return full.trim() || `(${label}: empty reply)`;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name === "AbortError") return "(cancelled)";
    return `(${label}: ${e?.message ?? "request failed"})`;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Codex's `exec` mode wraps every reply in a noisy envelope:
//
//   reasoning effort: xhigh
//   reasoning summaries: none
//   session id: 019e889d-…
//   --------
//   user
//   <our prompt — including the entire operating-manual block>
//   codex
//   <the actual model reply, possibly multi-line>
//   tokens used
//   1,985
//
// Returning that whole thing as the panelist's "answer" is what the user is
// seeing as "codex talking about don't-do-this preamble" — the preamble is
// our manual being echoed back. Strip everything except the model's reply:
// the section between the line "codex" and the next envelope keyword (or
// EOF). If the markers aren't present (unusual output, an error case),
// return the raw output as a fallback so we never silently drop content.
export function extractCodexReply(raw: string): string {
  if (!raw) return raw;
  // Detect the runCapture exit-code prefix — if codex exited non-zero,
  // runCapture wraps the stderr in `(<bin> exited <code>)\n<stderr>` and
  // gives us that. The envelope below is just noise; surface the actual
  // error line instead.
  const exitPrefix = raw.match(/^\((?:\S+\s+)?exited\s+\d+\)/);
  if (exitPrefix) {
    const errLine = extractCodexErrorLine(raw);
    return errLine ?? raw.split("\n")[0]!;
  }
  const lines = raw.split("\n");
  // Find the "codex" line — must be on its own line, possibly with trailing
  // whitespace. Walk from the bottom so we get the LAST one (in case codex
  // ever interleaves intermediate "codex" markers).
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() === "codex") {
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    // No "codex" marker line. Two cases:
    //
    // 1. Codex 0.136+ split the streams: the model reply goes to stdout,
    //    the envelope (workdir / model / session id / the "codex" marker
    //    itself / "tokens used") goes to stderr. runCapture only feeds us
    //    stdout when it's non-empty, so `raw` here is just the bare reply.
    //    Returning a no-reply fallback would discard the actual answer.
    //
    // 2. Codex failed silently and dumped only the envelope. In that case
    //    `raw` will contain envelope markers like "workdir:" or "session
    //    id:" or the "--------" separator.
    //
    // Distinguish by checking for envelope tells. If none are present, the
    // stdout we received IS the reply — pass it through.
    const looksLikeEnvelope = /\b(workdir|provider|sandbox|session id|reasoning effort)\s*:|^-{4,}$/m.test(raw);
    if (!looksLikeEnvelope) return raw.trim();
    // Otherwise it's the failure case — surface a real error line if
    // present, else a concise placeholder so we don't dump the envelope.
    const errLine = extractCodexErrorLine(raw);
    return errLine ?? "(codex produced no reply)";
  }
  // Stop at the next envelope keyword we know about. The colon-suffixed keys
  // come from codex's startup envelope; matching them protects against the
  // rare case where codex re-prints envelope info after the reply. We require
  // the colon (and an `^`) so a reply that mentions "model: gpt-5" in prose
  // doesn't get truncated.
  const stopRe = /^(tokens used\s*$|-{4,}\s*$|(?:session id|reasoning effort|reasoning summaries|workdir|model|provider|approval|sandbox):)/i;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (stopRe.test(lines[i]!.trim())) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start, end).join("\n").trim();
  return body || "(codex produced no reply)";
}

function extractCodexErrorLine(raw: string): string | null {
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (/^error[:\s]/i.test(t)) return t;
    if (/not supported when using codex/i.test(t)) return t;
    if (/^stream error[:\s]/i.test(t)) return t;
  }
  return null;
}

// Gemini CLI dumps a full Node.js stack trace on any API error: 30 lines of
// "at classifyGoogleError (file:///opt/homebrew/Cellar/gemini-cli/.../...)"
// frames after the actual human-readable error. The signal we want is
// usually one line like "TerminalQuotaError: You have exhausted your
// capacity...". This function pulls that out and drops the stack.
//
// On success (no error), Gemini's `-p` mode just prints the reply text — no
// envelope to strip — so we return it unchanged.
export function extractGeminiReply(raw: string): string {
  if (!raw) return raw;
  // runCapture prefixes non-zero exits with "(<bin> exited <code>)". When
  // present, dig out the meaningful error line instead of the whole dump.
  const exitPrefix = raw.match(/^\((?:\S+\s+)?exited\s+\d+\)/);
  // Stack-trace markers — once we hit one, stop including the rest.
  const stackRe = /^\s*at\s+[\w.<>$]+\s*\(/;
  const lines = raw.split("\n");
  const kept: string[] = [];
  let sawError = false;
  for (const line of lines) {
    if (stackRe.test(line)) break;
    // Strip Gemini's "Full report available at: /var/folders/...json"
    // breadcrumb — points at a temp file the user can't read in context.
    const cleaned = line.replace(/\s*Full report available at:\s*\S+/g, "").trimEnd();
    if (!cleaned.trim()) continue;
    kept.push(cleaned);
    if (/error\b|exhausted|quota|429/i.test(cleaned)) sawError = true;
  }
  const body = kept.join("\n").trim();
  if (exitPrefix && sawError) {
    // Promote the most specific error line. Prefer a *Error: pattern.
    const errLine = kept.find((l) =>
      /^\s*\w*Error:|^\s*Error\b|exhausted/i.test(l),
    );
    if (errLine) {
      // Often the prefix and the error line are concatenated on one line
      // from gemini; if so, just return the error portion.
      const idx = errLine.search(/\w*Error:|Error\b/);
      return idx > 0 ? errLine.slice(idx).trim() : errLine.trim();
    }
  }
  return body || raw;
}

// Exposed for tests: returns the exact argv we would pass to spawn for a
// given CLI. Lets us assert the command shape (skip-git-repo-check flag,
// --skip-trust flag, -m model passing, etc) without actually spawning.
export function buildCliArgs({
  cli,
  prompt,
  model,
  isFirst,
  manual,
}: {
  cli: CliKind;
  prompt: string;
  model: string;
  isFirst: boolean;
  manual: string | null;
}): string[] {
  const m = model.trim();
  if (cli === "claude") {
    const args: string[] = [];
    if (m) args.push("--model", m);
    if (manual && isFirst) args.push("--append-system-prompt", manual);
    if (isFirst) args.push("-p", prompt);
    else args.push("--continue", "-p", prompt);
    return args;
  }
  // codex and gemini have no system-prompt channel; manual is intentionally
  // dropped (it would otherwise be echoed back into the response bubble).
  if (cli === "codex") {
    const base = ["exec", "--skip-git-repo-check"];
    return m ? [...base, "-m", m, prompt] : [...base, prompt];
  }
  if (cli === "antigravity") {
    // Probe path can't easily detect which binary is in use here (this
    // function only sees the kind). Default to the agy flag set since
    // that's the post-2026-06-18 reality. The probe is only used to
    // build display hints — actual invocation in runChatTurn dispatches
    // on the resolved binary correctly.
    const base = ["--dangerously-skip-permissions"];
    return m ? [...base, "--model", m, "-p", prompt] : [...base, "-p", prompt];
  }
  return [];
}

function runCapture(
  bin: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  onChunk?: (delta: string) => void,
  maxOutputChars?: number,
): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    let truncated = false;
    if (signal?.aborted) {
      resolve("(cancelled)");
      return;
    }
    try {
      child = spawn(bin, args, {
        cwd,
        env: scrubbedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        // Run the child as its OWN process-group leader so abort can
        // signal the entire tree, not just the launcher. Required for
        // `gemini`: its CLI is a shell wrapper that installs no-op
        // handlers for SIGTERM/SIGINT/SIGHUP and spawns the real
        // worker as a separate PID with inherited stdio. A plain
        // child.kill("SIGTERM") hits the wrapper, gets swallowed, and
        // the worker runs to the 120s timeout — so ESC in the TUI
        // visibly cancels claude/codex/ollama but Gemini keeps going.
        //
        // We do NOT call child.unref() here: detached only creates a
        // new pgroup, it does not background the process.
        detached: true,
      });
    } catch (err) {
      resolve(`(error spawning ${bin}: ${(err as Error).message})`);
      return;
    }
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      try {
        // Negative pid = signal the whole process group (the wrapper
        // AND its real worker). SIGKILL because gemini's wrapper
        // ignores SIGTERM. If for some reason we don't have a pid,
        // fall back to direct SIGKILL on the handle.
        if (typeof child!.pid === "number") {
          process.kill(-child!.pid, "SIGKILL");
        } else {
          child!.kill("SIGKILL");
        }
      } catch {
        try { child!.kill("SIGKILL"); } catch {}
      }
    };
    signal?.addEventListener("abort", onAbort);
    child.stdout.on("data", (b) => {
      const chunk = b.toString();
      stdout += chunk;
      // Streaming: emit raw stdout chunks to the caller. Per-CLI parsers
      // (extractCodexReply, extractGeminiReply, claude stream-json) still
      // run on the FINAL aggregate — that's how we strip envelopes /
      // stack traces from the returned reply. The streamed bubble shows
      // the same text the user would have seen in a terminal, which is
      // good enough for the "feels live" UX.
      if (onChunk) onChunk(chunk);
      // Output cap. Once the cumulative stdout crosses maxOutputChars,
      // SIGKILL the whole pgroup (same trick as the abort path — gemini's
      // wrapper ignores SIGTERM). Distinct from abort: not a user cancel,
      // just a "this caller has no business returning 50KB" guard.
      if (
        !truncated &&
        typeof maxOutputChars === "number" &&
        stdout.length > maxOutputChars
      ) {
        truncated = true;
        try {
          if (typeof child!.pid === "number") {
            process.kill(-child!.pid, "SIGKILL");
          } else {
            child!.kill("SIGKILL");
          }
        } catch {
          try { child!.kill("SIGKILL"); } catch {}
        }
      }
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (cancelled) {
        resolve("(cancelled)");
        return;
      }
      if (truncated && typeof maxOutputChars === "number") {
        resolve(stdout.slice(0, maxOutputChars) + " ... (truncated at " + maxOutputChars + " chars)");
        return;
      }
      const out = stdout.trim();
      if (out.length > 0) {
        resolve(out);
      } else if (code !== 0) {
        resolve(`(${bin} exited ${code})\n${stderr.trim()}`);
      } else {
        resolve("(no output)");
      }
    });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      if (cancelled) {
        resolve("(cancelled)");
      } else if (truncated && typeof maxOutputChars === "number") {
        resolve(stdout.slice(0, maxOutputChars) + " ... (truncated at " + maxOutputChars + " chars)");
      } else {
        resolve(`(error running ${bin}: ${err.message})`);
      }
    });
  });
}
