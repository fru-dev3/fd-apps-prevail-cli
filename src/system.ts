import { spawn } from "node:child_process";
import { homedir } from "node:os";

export function openInFinder(path: string): { ok: boolean; message: string } {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  try {
    const child = spawn(opener, [path], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, message: `opened ${shortenHome(path)}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export function shortenHome(p: string): string {
  const home = homedir();
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
