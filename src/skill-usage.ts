// Skill usage intelligence: a vault-wide ledger of WHICH skills actually get
// used, so the Skills surface can rank by real popularity and the user can
// archive dead weight instead of accumulating bloat. Three pieces:
//   - recordSkillUse: one cheap, lock-safe, never-throwing tick per use
//     (chat attach, council attach, connector sync run, agent run).
//   - skillUsageReport: joins the live skill scan with the ledger and issues a
//     verdict per skill (active / dormant / unused) plus archive candidates.
//     Computed on demand from current data - no stale precomputed analysis.
//   - archiveSkill / unarchiveSkill: move a skill dir to skills/_archive/<id>
//     (and back). Both scanners only match skills/<id>/SKILL.md, so archived
//     skills vanish from every surface without deleting anything.

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { withLock } from "./file-lock.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";
import { scanVault } from "./vault.ts";
import { resolveDomainDir, runtimePath } from "./path-safety.ts";

export type SkillUseSource = "chat" | "council" | "sync" | "loop" | "agent" | "other";

interface UsageEntry {
  uses: number;
  lastTs: number;
  firstTs: number;
  sources: Partial<Record<SkillUseSource, number>>;
}

interface UsageLedger {
  schema: 1;
  skills: Record<string, UsageEntry>; // key: "<domain>/<skillId>"
}

// Days without use after which a previously-used skill counts as dormant.
export const DORMANT_AFTER_DAYS = 45;

function ledgerPath(vaultPath: string): string {
  return join(runtimePath(resolve(vaultPath), "_meta"), "skill_usage.json");
}

function readLedger(vaultPath: string): UsageLedger {
  try {
    const parsed = JSON.parse(vreadFile(ledgerPath(vaultPath))) as UsageLedger;
    if (parsed && parsed.schema === 1 && parsed.skills && typeof parsed.skills === "object") return parsed;
  } catch { /* fresh ledger */ }
  return { schema: 1, skills: {} };
}

export function skillKey(domain: string, skillId: string): string {
  return `${domain.toLowerCase().trim()}/${skillId.toLowerCase().trim()}`;
}

// Tick one use. Best-effort by contract: usage accounting must never break the
// action that used the skill, so every failure path swallows.
export async function recordSkillUse(
  vaultPath: string,
  domain: string,
  skillId: string,
  source: SkillUseSource = "other",
): Promise<void> {
  const key = skillKey(domain, skillId);
  if (!key.includes("/") || key.startsWith("/") || key.endsWith("/")) return;
  try {
    const file = ledgerPath(vaultPath);
    mkdirSync(dirname(file), { recursive: true });
    // Lock a SIBLING path: tryAcquireLock creates the lock AT the given path
    // and release() unlinks it - locking the data file itself would delete the
    // ledger on release.
    await withLock(`${file}.lock`, async () => {
      const ledger = readLedger(vaultPath);
      const now = Date.now();
      const cur = ledger.skills[key] ?? { uses: 0, lastTs: 0, firstTs: now, sources: {} };
      cur.uses += 1;
      cur.lastTs = now;
      cur.sources[source] = (cur.sources[source] ?? 0) + 1;
      ledger.skills[key] = cur;
      vwriteFile(file, JSON.stringify(ledger, null, 2));
    });
  } catch { /* never break the caller over accounting */ }
}

export interface SkillUsageRow {
  domain: string;
  id: string;
  title: string;
  uses: number;
  lastTs: number | null;
  verdict: "active" | "dormant" | "unused";
}

export interface SkillUsageReport {
  total: number;
  unused: number;
  dormant: number;
  rows: SkillUsageRow[]; // sorted: most-used first, never-used last
}

// Join the LIVE skill scan with the ledger. A skill that exists but has no
// ledger entry has verifiably never been used since tracking began.
export function skillUsageReport(vaultPath: string, now = Date.now()): SkillUsageReport {
  const ledger = readLedger(vaultPath);
  const rows: SkillUsageRow[] = [];
  for (const d of scanVault(resolve(vaultPath))) {
    for (const s of d.skills) {
      const u = ledger.skills[skillKey(d.name, s.id)];
      const dormantCutoff = now - DORMANT_AFTER_DAYS * 86_400_000;
      const verdict: SkillUsageRow["verdict"] = !u || u.uses === 0
        ? "unused"
        : u.lastTs < dormantCutoff
          ? "dormant"
          : "active";
      rows.push({ domain: d.name, id: s.id, title: s.title, uses: u?.uses ?? 0, lastTs: u?.lastTs ?? null, verdict });
    }
  }
  rows.sort((a, b) => (b.uses - a.uses) || (b.lastTs ?? 0) - (a.lastTs ?? 0) || a.id.localeCompare(b.id));
  return {
    total: rows.length,
    unused: rows.filter((r) => r.verdict === "unused").length,
    dormant: rows.filter((r) => r.verdict === "dormant").length,
    rows,
  };
}

const ARCHIVE_DIR = "_archive";

function skillDirOf(vaultPath: string, domain: string, skillId: string): string {
  return join(resolveDomainDir(resolve(vaultPath), domain), "skills", skillId);
}

// Move a skill out of (or back into) the scanned set. Move-only - nothing is
// deleted, and the archive lives inside the same skills/ tree so it syncs with
// the vault and survives layout migrations untouched (scanners skip it because
// _archive has no SKILL.md of its own).
export function archiveSkill(vaultPath: string, domain: string, skillId: string): { ok: boolean; path?: string; error?: string } {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(skillId)) return { ok: false, error: "invalid skill id" };
  const src = skillDirOf(vaultPath, domain, skillId);
  if (!existsSync(join(src, "SKILL.md"))) return { ok: false, error: `no skill "${skillId}" in ${domain}` };
  const destDir = join(dirname(src), ARCHIVE_DIR);
  const dest = join(destDir, skillId);
  if (existsSync(dest)) return { ok: false, error: "an archived skill with this id already exists" };
  try {
    mkdirSync(destDir, { recursive: true });
    renameSync(src, dest);
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: `archive failed: ${e}` };
  }
}

export function unarchiveSkill(vaultPath: string, domain: string, skillId: string): { ok: boolean; path?: string; error?: string } {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(skillId)) return { ok: false, error: "invalid skill id" };
  const dest = skillDirOf(vaultPath, domain, skillId);
  const src = join(dirname(dest), ARCHIVE_DIR, skillId);
  if (!existsSync(join(src, "SKILL.md"))) return { ok: false, error: `no archived skill "${skillId}" in ${domain}` };
  if (existsSync(dest)) return { ok: false, error: "an active skill with this id already exists" };
  try {
    renameSync(src, dest);
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: `unarchive failed: ${e}` };
  }
}
