// One-time scrub: mask credentials already in a vault (captured prompt
// streams, entity caches and pages, threads, domain memory, decisions, the scan
// corpus) with the same masker every write path now uses. Never prints a
// secret: it reports counts per file kind only.
//
//   bun src/scrub-secrets.ts --vault <copy> --expect <copy> [--dry-run]
//   bun src/scrub-secrets.ts --config --expect ~/vault --backup-dir ~/.prevail/backups
//
// --expect must equal the resolved vault (a guard against scrubbing the wrong
// folder). With --backup-dir, every file it changes is first copied into a
// dated tarball there (chmod 600); refuse a backup dir inside the vault.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { maskDeep, redactSecrets } from "./secret-redact.ts";

export type ScrubKind =
  | "prompt-streams" | "entity-caches" | "entity-pages" | "threads" | "project-prompts"
  | "decisions" | "domain-memory" | "scan-corpus" | "meta-derived";

const TEXT = /\.(jsonl|json|md|txt)$/i;

export function kindOf(rel: string): ScrubKind | null {
  const r = rel.split(sep).join("/");
  if (!TEXT.test(r) || /\/skills\//.test(`/${r}`) || r.endsWith(".lock")) return null;
  if (/^build\/_meta\/prompts(\/|\.)/.test(r)) return "prompt-streams";
  if (r.startsWith("build/_meta/entities/")) return "entity-caches";
  if (r.startsWith("build/_meta/")) return "meta-derived";
  if (r.startsWith("build/_scan/")) return "scan-corpus";
  if (r.startsWith("data/entities/")) return "entity-pages";
  if (!r.startsWith("data/domains/")) return null;
  if (/\/(memory\/threads|_threads)\//.test(r)) return "threads";
  if (/\/memory\/projects\//.test(r)) return "project-prompts";
  if (/\/decisions\//.test(r)) return "decisions";
  return "domain-memory";
}

/** Mask one file's text; JSON stays valid (strings masked in place), an
 *  unparseable JSON line is left as is. */
export function scrubText(path: string, body: string): { text: string; count: number } {
  if (body.includes("\u0000")) return { text: body, count: 0 };
  if (/\.jsonl$/i.test(path)) {
    let count = 0;
    const out = body.split("\n").map((line) => {
      if (!line.trim()) return line;
      try {
        const r = maskDeep(JSON.parse(line));
        count += r.count;
        return r.count ? JSON.stringify(r.value) : line;
      } catch { return line; }
    });
    return { text: out.join("\n"), count };
  }
  if (/\.json$/i.test(path)) {
    try {
      const r = maskDeep(JSON.parse(body));
      return r.count ? { text: `${JSON.stringify(r.value, null, 2)}\n`, count: r.count } : { text: body, count: 0 };
    } catch { return { text: body, count: 0 }; }
  }
  return redactSecrets(body);
}

function walk(dir: string, out: string[]) {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
}

export interface ScrubReport {
  vault: string;
  byKind: Record<string, { files: number; masked: number }>;
  changed: string[];
  backup?: string;
}

export function scrubVault(vault: string, o: { dryRun?: boolean; backupDir?: string; now?: Date } = {}): ScrubReport {
  const files: string[] = [];
  for (const top of ["build/_meta", "build/_scan", "data/entities", "data/domains"]) walk(join(vault, top), files);
  const byKind: ScrubReport["byKind"] = {};
  const pending: { path: string; text: string }[] = [];
  for (const f of files) {
    const kind = kindOf(relative(vault, f));
    if (!kind) continue;
    let body: string;
    try { body = readFileSync(f, "utf8"); } catch { continue; }
    const r = scrubText(f, body);
    if (!r.count || r.text === body) continue;
    const k = (byKind[kind] ??= { files: 0, masked: 0 });
    k.files++;
    k.masked += r.count;
    pending.push({ path: f, text: r.text });
  }
  const report: ScrubReport = { vault, byKind, changed: pending.map((p) => relative(vault, p.path)) };
  if (o.dryRun || !pending.length) return report;
  if (o.backupDir) {
    const dir = resolve(o.backupDir);
    if (dir === vault || dir.startsWith(`${vault}${sep}`)) throw new Error("the backup must live outside the vault");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = (o.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const tar = join(dir, `secret-scrub-${stamp}.tar.gz`);
    const list = join(dir, `.secret-scrub-${stamp}.list`);
    writeFileSync(list, report.changed.join("\n"), { mode: 0o600 });
    execFileSync("tar", ["-czf", tar, "-C", vault, "-T", list], { stdio: "ignore" });
    chmodSync(tar, 0o600);
    renameSync(list, `${tar}.files`);
    report.backup = tar;
  }
  for (const p of pending) {
    const mode = statSync(p.path).mode & 0o777;
    const tmp = `${p.path}.scrub-tmp`;
    writeFileSync(tmp, p.text, { mode });
    renameSync(tmp, p.path);
  }
  return report;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const tilde = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
  let vault = arg("--vault");
  if (process.argv.includes("--config")) {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".prevail", "config.json"), "utf8")) as { vaultPath?: string };
    vault = cfg.vaultPath;
  }
  const expect = arg("--expect");
  if (!vault || !expect) throw new Error("need --vault <path> or --config, and --expect <path>");
  const real = realpathSync(tilde(vault));
  if (real !== realpathSync(tilde(expect))) throw new Error(`resolved vault ${real} is not the expected one`);
  if (!existsSync(join(real, "build")) || !existsSync(join(real, "data"))) throw new Error(`${real} is not a vault`);
  const backupDir = arg("--backup-dir");
  const r = scrubVault(real, { dryRun: process.argv.includes("--dry-run"), backupDir: backupDir ? tilde(backupDir) : undefined });
  console.log(JSON.stringify({ vault: r.vault, dryRun: process.argv.includes("--dry-run"), byKind: r.byKind, filesChanged: r.changed.length, backup: r.backup }, null, 2));
}
