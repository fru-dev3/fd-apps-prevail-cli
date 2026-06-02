import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

// Reuse the existing SQLite store written by session.ts. Open read-only.
const DB_PATH = join(homedir(), ".prevail", "sessions.db");

let dbInstance: Database | null = null;
function db(): Database | null {
  if (dbInstance) return dbInstance;
  try {
    dbInstance = new Database(DB_PATH, { readonly: true });
    return dbInstance;
  } catch {
    return null;
  }
}

export interface DomainHeatRow {
  domain: string;
  perDay: number[]; // length = days
  total: number;
  lastTs: number | null;
}

// Return per-day user-message counts per domain, oldest-first, for the last
// `days` calendar days (UTC bucketing). Domains with zero activity are
// omitted; pass `requireDomains` to include them with all-zero rows.
export function buildDomainHeatmap(
  days: number = 30,
  requireDomains: string[] = [],
): DomainHeatRow[] {
  const handle = db();
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const startTs = now - (days - 1) * dayMs;
  const startOfDay = (ts: number) => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const dayIndex = (ts: number) =>
    Math.floor((startOfDay(ts) - startOfDay(startTs)) / dayMs);

  const rows = new Map<string, DomainHeatRow>();
  const ensure = (name: string): DomainHeatRow => {
    let r = rows.get(name);
    if (!r) {
      r = { domain: name, perDay: new Array(days).fill(0), total: 0, lastTs: null };
      rows.set(name, r);
    }
    return r;
  };
  for (const d of requireDomains) ensure(d);

  if (handle) {
    try {
      const minTs = startOfDay(startTs);
      const queryRows = handle
        .query<{ domain: string; ts: number }, [number]>(
          `SELECT domain, ts FROM messages
           WHERE role = 'user' AND ts >= ?`,
        )
        .all(minTs);
      for (const q of queryRows) {
        const idx = dayIndex(q.ts);
        if (idx < 0 || idx >= days) continue;
        const r = ensure(q.domain);
        r.perDay[idx]! += 1;
        r.total += 1;
        if (r.lastTs === null || q.ts > r.lastTs) r.lastTs = q.ts;
      }
    } catch {
      // fall through with required-only rows
    }
  }

  const out = Array.from(rows.values());
  out.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.domain.localeCompare(b.domain);
  });
  return out;
}

// Eight-step block-element sparkline. Cells with zero render as " " so the
// emptiness is visually obvious; cells with > 0 render as ▁..█ by quantile.
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export function renderHeatmapText(rows: DomainHeatRow[], days: number): string {
  if (rows.length === 0) {
    return "no chat activity recorded yet — start chatting and run /heatmap again.";
  }
  const peak = Math.max(1, ...rows.flatMap((r) => r.perDay));
  const lines: string[] = [];
  lines.push(`domain activity · last ${days} days (older → newer)`);
  lines.push("");
  const nameWidth = Math.max(...rows.map((r) => r.domain.length), 8);
  for (const r of rows) {
    const cells = r.perDay
      .map((n) => {
        if (n === 0) return "·";
        const idx = Math.min(
          BLOCKS.length - 1,
          Math.max(0, Math.floor((n / peak) * (BLOCKS.length - 1))),
        );
        return BLOCKS[idx];
      })
      .join("");
    const lastSeen = r.lastTs ? formatDayDelta(r.lastTs) : "never";
    const padded = r.domain.padEnd(nameWidth, " ");
    lines.push(
      `${padded}  ${cells}  ${r.total.toString().padStart(4, " ")} msgs · last ${lastSeen}`,
    );
  }
  return lines.join("\n");
}

function formatDayDelta(ts: number): string {
  const diff = Date.now() - ts;
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return "today";
  if (diff < 2 * day) return "1d ago";
  return `${Math.floor(diff / day)}d ago`;
}
