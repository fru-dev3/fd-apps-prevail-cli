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
  // Resolve in priority order:
  // 1. ~/.aireadyu/vault-demo — where the installer drops it
  // 2. AIREADYU_DATA_DIR/vault-demo if env var is set
  // 3. next to the binary (unpacked tarball before install)
  // 4. relative to argv[1] (script-mode)
  // 5. relative to import.meta.url (source run via bun)
  // 6. cwd
  const candidates: string[] = [];
  candidates.push(join(homedir(), ".aireadyu", "vault-demo"));
  if (process.env.AIREADYU_DATA_DIR) {
    candidates.push(join(process.env.AIREADYU_DATA_DIR, "vault-demo"));
  }
  try {
    const execDir = dirname(process.execPath);
    candidates.push(resolve(execDir, "vault-demo"));
  } catch {}
  if (process.argv[1]) {
    try {
      candidates.push(resolve(dirname(process.argv[1]), "vault-demo"));
    } catch {}
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(resolve(here, "..", "vault-demo"));
    candidates.push(resolve(here, "vault-demo"));
  } catch {}
  candidates.push(resolve(process.cwd(), "vault-demo"));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
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
