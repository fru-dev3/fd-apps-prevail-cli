import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { Domain, ViewKey } from "./vault.ts";
import { readWebAccess } from "./config.ts";

const OPERATING_MANUAL_FILE = "AGENTS-operating.md";
let operatingManualCache: { vaultPath: string; content: string | null } | null = null;

function findOperatingManual(vaultPath: string): string | null {
  if (operatingManualCache && operatingManualCache.vaultPath === vaultPath) {
    return operatingManualCache.content;
  }
  const candidates: string[] = [
    join(vaultPath, OPERATING_MANUAL_FILE),
    join(homedir(), ".aireadyu", OPERATING_MANUAL_FILE),
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

export type CliKind = "claude" | "codex" | "gemini";

export interface AvailableCli {
  kind: CliKind;
  bin: string;
  label: string;
}

const CANDIDATES: { kind: CliKind; bins: string[]; label: string }[] = [
  { kind: "claude", bins: ["claude"], label: "Claude Code" },
  { kind: "codex", bins: ["codex"], label: "Codex" },
  { kind: "gemini", bins: ["gemini"], label: "Gemini" },
];

export const CLI_MODEL_HINT: Record<CliKind, string> = {
  claude: "e.g. opus, sonnet, haiku, or full id like claude-opus-4-7",
  codex: "e.g. gpt-5, gpt-5.4, o3 (whatever your codex install accepts)",
  gemini: "e.g. gemini-2.5-pro, gemini-2.0-flash",
};

// Small curated short-list per CLI for the clickable picker. Not exhaustive — the
// user can always type `/model <anything>` to pass a custom name straight through.
export const MODEL_QUICKPICKS: Record<CliKind, string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-5", "gpt-5.4", "o3"],
  gemini: ["gemini-2.5-pro", "gemini-2.0-flash"],
};

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
  if (cli === "gemini") {
    if (o.includes("agent execution blocked") || o.includes("hook(s)") || o.includes("hook execution")) {
      return "gemini's BeforeAgent/AfterAgent hooks are blocking execution. Check ~/.gemini/settings.json and either fix the hook script path or remove the broken `hooks` entries.";
    }
    if (o.includes("not running in a trusted") || o.includes("trusted")) {
      return "gemini blocked an untrusted folder. The wrapper passes `--skip-trust`; if you still see this, the workspace sandbox in ~/.gemini/settings.json may be restricting reach.";
    }
    if (o.includes("quota") || o.includes("rate")) {
      return "gemini hit a quota or rate limit.";
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
        env: process.env,
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

export function detectClis(): AvailableCli[] {
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
      env: process.env,
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

export async function runChatTurn({ prompt, cwd, cli, model, isFirst }: ChatTurn): Promise<string> {
  const m = model.trim();
  // cwd is <vault>/<domain>; the operating manual lives one level up at <vault>/AGENTS-operating.md
  const vaultPath = resolve(cwd, "..");
  const manual = augmentManualWithWebGate(findOperatingManual(vaultPath));

  if (cli.kind === "claude") {
    const head = isFirst ? ["-p", prompt] : ["--continue", "-p", prompt];
    const args: string[] = [];
    if (m) args.push("--model", m);
    // --append-system-prompt is only meaningful on the first turn; --continue inherits it
    if (manual && isFirst) args.push("--append-system-prompt", manual);
    args.push(...head);
    return runCapture(cli.bin, args, cwd);
  }
  // codex + gemini don't have session continuation in our wrapper — prepend manual every turn
  const augmentedPrompt = manual
    ? `<operating-manual>\n${manual}\n</operating-manual>\n\n${prompt}`
    : prompt;
  if (cli.kind === "codex") {
    // --skip-git-repo-check: vault dirs aren't git repos; without this codex
    // refuses to run with 'Not inside a trusted directory'.
    const base = ["exec", "--skip-git-repo-check"];
    const args = m ? [...base, "-m", m, augmentedPrompt] : [...base, augmentedPrompt];
    return runCapture(cli.bin, args, cwd);
  }
  if (cli.kind === "gemini") {
    // --skip-trust: vault dirs aren't on gemini's trusted-folders list;
    // without this gemini refuses to run with a 'not running in a trusted
    // directory' error.
    const base = ["--skip-trust"];
    const args = m
      ? [...base, "-m", m, "-p", augmentedPrompt]
      : [...base, "-p", augmentedPrompt];
    return runCapture(cli.bin, args, cwd);
  }
  return `(no handler for ${cli.kind})`;
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
  const augmented = manual
    ? `<operating-manual>\n${manual}\n</operating-manual>\n\n${prompt}`
    : prompt;
  if (cli === "codex") {
    const base = ["exec", "--skip-git-repo-check"];
    return m ? [...base, "-m", m, augmented] : [...base, augmented];
  }
  if (cli === "gemini") {
    const base = ["--skip-trust"];
    return m ? [...base, "-m", m, "-p", augmented] : [...base, "-p", augmented];
  }
  return [];
}

function runCapture(bin: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      // stdin: "ignore" — same reason as probeCli. Without this, codex exec
      // hangs indefinitely from inside a spawn (no TTY, pipe never closes).
      child = spawn(bin, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve(`(error spawning ${bin}: ${(err as Error).message})`);
      return;
    }
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("close", (code) => {
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
      resolve(`(error running ${bin}: ${err.message})`);
    });
  });
}
