import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export interface UserConfig {
  vaultPath: string;
  createdAt: string;
}

export function configDir(): string {
  return join(homedir(), ".aireadyu");
}

export function configFile(): string {
  return join(configDir(), "config.json");
}

export function readConfig(): UserConfig | null {
  const file = configFile();
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    return JSON.parse(raw) as UserConfig;
  } catch {
    return null;
  }
}

export function writeConfig(cfg: UserConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}

export function bundledDemoVaultPath(): string {
  // Two cases:
  // 1. source run (`bun run src/index.tsx`) — vault-demo is one level up from src/
  // 2. compiled binary (`./aireadyu`) — vault-demo ships in the same dir as the binary
  const candidates: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(resolve(here, "..", "vault-demo"));
    candidates.push(resolve(here, "vault-demo"));
  } catch {}
  try {
    const execDir = dirname(process.execPath);
    candidates.push(resolve(execDir, "vault-demo"));
  } catch {}
  if (process.argv[1]) {
    try {
      candidates.push(resolve(dirname(process.argv[1]), "vault-demo"));
    } catch {}
  }
  candidates.push(resolve(process.cwd(), "vault-demo"));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to the most likely path even if it doesn't exist, so error
  // messages are informative.
  return candidates[0] ?? resolve(process.cwd(), "vault-demo");
}

export interface VaultCandidate {
  kind: "demo" | "existing" | "ai-folder" | "current-dir" | "default-home";
  label: string;
  path: string;
  exists: boolean;
}

export function detectVaultCandidates(): VaultCandidate[] {
  const cwd = process.cwd();
  const home = homedir();
  const cwdVault = join(cwd, "vault");
  const aiVault = join(home, ".ai", "vault");
  const aireadyuVault = join(home, ".aireadyu", "vault");
  const demo = bundledDemoVaultPath();
  return [
    {
      kind: "demo",
      label: "bundled demo (Alex Rivera, synthetic — safe to explore)",
      path: demo,
      exists: existsSync(demo),
    },
    {
      kind: "ai-folder",
      label: "~/.ai/vault (existing AIReadyU-style folder)",
      path: aiVault,
      exists: existsSync(aiVault),
    },
    {
      kind: "current-dir",
      label: `./vault (relative to ${shorten(cwd)})`,
      path: cwdVault,
      exists: existsSync(cwdVault),
    },
    {
      kind: "default-home",
      label: "~/.aireadyu/vault (fresh start — scaffold 22 default domains)",
      path: aireadyuVault,
      exists: existsSync(aireadyuVault),
    },
  ];
}

function shorten(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
