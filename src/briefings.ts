import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanVault, type Domain } from "./vault.ts";
import { detectClis, runChatTurn } from "./cli-bridge.ts";
import { buildCouncilPanel, runCouncilOneShot } from "./council-runner.ts";
import { writeTurnSummary } from "./auto-summary.ts";
import { isCronDue } from "./schedule.ts";

// A briefing = a scheduled question routed to one specific life domain. It
// runs on the same cron primitives as ad-hoc schedules but the result path
// is structured: vault log writeback + optional Telegram delivery.
//
// This is what turns prevail from "tool I open" into "system that updates
// me" — the headline ask in the competitive analysis. A briefing fires while
// you sleep, the panel debates, the verdict lands in your phone at 7am.
export interface BriefingEntry {
  id: string;
  name: string;
  cron: string;
  domain: string; // domain name (matched against scanVault)
  prompt: string;
  mode: "single" | "council";
  // Where to deliver the result. "log" is always written; "telegram" pushes
  // the verdict to every allow-listed chat_id (so a family-shared bot can
  // ping multiple people). "both" does both.
  deliver: "log" | "telegram" | "both";
  enabled: boolean;
  last_run: number | null;
  created_at: number;
}

interface BriefingFile {
  briefings: BriefingEntry[];
}

function briefingsFilePath(vaultPath: string): string {
  return join(vaultPath, ".briefings.json");
}

export function loadBriefings(vaultPath: string): BriefingEntry[] {
  const f = briefingsFilePath(vaultPath);
  if (!existsSync(f)) return [];
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8")) as BriefingFile;
    return Array.isArray(parsed.briefings) ? parsed.briefings : [];
  } catch {
    return [];
  }
}

export function saveBriefings(vaultPath: string, briefings: BriefingEntry[]): void {
  writeFileSync(briefingsFilePath(vaultPath), JSON.stringify({ briefings }, null, 2));
}

export function makeBriefingId(): string {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export interface BriefingResult {
  id: string;
  ts: number;
  domain: string;
  output: string; // verdict (council) or reply (single)
  delivered: { log: boolean; telegram: number };
  error?: string;
}

// Optional Telegram delivery hook — passed in by the daemon so briefings
// can fan out to allow-listed chats. Returns count of successful sends.
// Decoupled from telegram.ts so the briefing layer doesn't import the
// daemon (and so the CLI's `briefing run` doesn't need a telegram config).
export type TelegramDelivery = (text: string) => Promise<number>;

export async function runBriefing(
  entry: BriefingEntry,
  vaultPath: string,
  deliverTelegram?: TelegramDelivery,
): Promise<BriefingResult> {
  const ts = Date.now();
  const domains = scanVault(vaultPath);
  const domain = domains.find((d) => d.name === entry.domain);
  if (!domain) {
    return {
      id: entry.id,
      ts,
      domain: entry.domain,
      output: "",
      delivered: { log: false, telegram: 0 },
      error: `domain "${entry.domain}" not found in vault ${vaultPath}`,
    };
  }
  const clis = await detectClis();
  if (clis.length === 0) {
    return {
      id: entry.id,
      ts,
      domain: entry.domain,
      output: "",
      delivered: { log: false, telegram: 0 },
      error: "no CLIs detected",
    };
  }

  let output: string;
  let cliLabel: string;
  try {
    if (entry.mode === "council") {
      const panel = buildCouncilPanel(clis);
      if (panel.length === 0) {
        return {
          id: entry.id,
          ts,
          domain: entry.domain,
          output: "",
          delivered: { log: false, telegram: 0 },
          error: "council panel empty (check /council config in TUI)",
        };
      }
      const result = await runCouncilOneShot({
        prompt: entry.prompt,
        cwd: domain.path,
        panelists: panel,
      });
      output = result.verdict;
      cliLabel = `Council ⚖ ${result.chairLabel} (briefing)`;
    } else {
      const cli = clis.find((c) => c.kind === "claude") ?? clis[0]!;
      output = await runChatTurn({
        prompt: entry.prompt,
        cwd: domain.path,
        cli,
        model: "",
        isFirst: true,
        bare: true,
      });
      cliLabel = `${cli.label} (briefing)`;
    }
  } catch (err) {
    return {
      id: entry.id,
      ts,
      domain: entry.domain,
      output: "",
      delivered: { log: false, telegram: 0 },
      error: (err as Error).message,
    };
  }

  const delivered = { log: false, telegram: 0 };
  if (entry.deliver === "log" || entry.deliver === "both") {
    writeTurnSummary({
      domainPath: domain.path,
      userPrompt: `[scheduled briefing · ${entry.name}] ${entry.prompt}`,
      assistantReply: output,
      cliLabel,
      ts,
      kind: entry.mode === "council" ? "council-verdict" : "chat",
    });
    delivered.log = true;
  }
  if ((entry.deliver === "telegram" || entry.deliver === "both") && deliverTelegram) {
    const header = `🔔 ${entry.name}  ·  ${entry.domain}\n\n`;
    try {
      delivered.telegram = await deliverTelegram(header + output);
    } catch {
      // Logged elsewhere; never fail the briefing just because Telegram
      // is unreachable.
    }
  }

  return { id: entry.id, ts, domain: entry.domain, output, delivered };
}

// Fire any briefing whose cron is due. Returns the entries that ran so the
// caller can log / display them. Mutates last_run + persists to disk to
// dedupe per-minute (same pattern as schedule.tickAndRunDue).
export async function tickBriefings(
  vaultPath: string,
  deliverTelegram?: TelegramDelivery,
  now: Date = new Date(),
): Promise<BriefingResult[]> {
  const briefings = loadBriefings(vaultPath);
  const minuteStart = Math.floor(now.getTime() / 60000) * 60000;
  const due = briefings.filter(
    (b) =>
      b.enabled &&
      (!b.last_run || b.last_run < minuteStart) &&
      isCronDue(b.cron, now),
  );
  const results: BriefingResult[] = [];
  for (const b of due) {
    const r = await runBriefing(b, vaultPath, deliverTelegram);
    results.push(r);
    b.last_run = now.getTime();
  }
  if (due.length > 0) saveBriefings(vaultPath, briefings);
  return results;
}

export function findDomain(vaultPath: string, name: string): Domain | null {
  const domains = scanVault(vaultPath);
  return domains.find((d) => d.name.toLowerCase() === name.toLowerCase()) ?? null;
}
