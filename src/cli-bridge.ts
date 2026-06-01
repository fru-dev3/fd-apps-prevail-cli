import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { Domain, ViewKey } from "./vault.ts";

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
  { kind: "gemini", bins: ["gemini"], label: "Gemini CLI" },
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

export async function runChatTurn({ prompt, cwd, cli, model, isFirst }: ChatTurn): Promise<string> {
  const m = model.trim();
  // cwd is <vault>/<domain>; the operating manual lives one level up at <vault>/AGENTS-operating.md
  const vaultPath = resolve(cwd, "..");
  const manual = findOperatingManual(vaultPath);

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
    const args = m ? ["exec", "-m", m, augmentedPrompt] : ["exec", augmentedPrompt];
    return runCapture(cli.bin, args, cwd);
  }
  if (cli.kind === "gemini") {
    const args = m ? ["-m", m, "-p", augmentedPrompt] : ["-p", augmentedPrompt];
    return runCapture(cli.bin, args, cwd);
  }
  return `(no handler for ${cli.kind})`;
}

function runCapture(bin: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(bin, args, { cwd, env: process.env });
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
