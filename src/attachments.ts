// Pasted-attachment intelligence. Layer 1: an index ledger
// (<vault>/build/_meta/attachments/index.jsonl, one JSON line per image) that
// records WHICH conversation each pasted image rode with (domain, thread,
// session, message snippet) using vault-RELATIVE paths so the records survive
// the vault living at different roots on different machines. Layer 2: a cheap
// captioning pass (Haiku) that looks at each new image once, writes a one-line
// caption into the index, and renames the file from pasted-<epoch>.png to
// YYYY-MM-DD_<semantic-slug>.png - so a year later both the filename and the
// metadata say what the image was.

import { existsSync, mkdirSync, readFileSync, renameSync, appendFileSync } from "node:fs";
import { join, dirname, resolve, extname } from "node:path";
import { withLock } from "./file-lock.ts";
import { vwriteFile } from "./vault-session.ts";
import { runChatTurn, detectClis } from "./cli-bridge.ts";

export interface AttachmentRecord {
  file: string; // vault-relative, e.g. build/_meta/attachments/pasted-123.png
  ts: number;
  domain?: string | null;
  thread?: string | null;
  session?: string | null;
  surface?: string | null; // chat | app-chat | council
  message?: string | null; // snippet of the user message it rode with
  caption?: string;
  original?: string; // pre-rename filename, kept for traceability
  captioned_ts?: number;
}

function indexPath(vaultPath: string): string {
  return join(resolve(vaultPath), "build", "_meta", "attachments", "index.jsonl");
}

export function readAttachmentIndex(vaultPath: string): AttachmentRecord[] {
  const p = indexPath(vaultPath);
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l) as AttachmentRecord; } catch { return null; }
      })
      .filter((r): r is AttachmentRecord => !!r && typeof r.file === "string");
  } catch {
    return [];
  }
}

// Append index lines (used by the CLI entry; the desktop appends via its own
// Rust command to the same file - one shared ledger).
export function appendAttachmentIndex(vaultPath: string, records: AttachmentRecord[]): number {
  if (!records.length) return 0;
  const p = indexPath(vaultPath);
  try {
    mkdirSync(dirname(p), { recursive: true });
    const lines = records
      .filter((r) => r && typeof r.file === "string" && r.file.trim())
      .map((r) => JSON.stringify(r))
      .join("\n");
    if (!lines) return 0;
    appendFileSync(p, `${lines}\n`, "utf8");
    return records.length;
  } catch {
    return 0;
  }
}

// One model look at one image -> { caption, slug }. Injectable for tests.
export type Captioner = (absImagePath: string) => Promise<{ caption: string; slug: string } | null>;

const CAPTION_MODEL = "claude-haiku-4-5";

async function haikuCaptioner(absImagePath: string): Promise<{ caption: string; slug: string } | null> {
  const clis = await detectClis();
  const claude = clis.find((c) => c.kind === "claude");
  if (!claude) return null;
  const prompt = [
    `Read the image file at ${absImagePath} and reply with EXACTLY one line in this format:`,
    `<caption> | <slug>`,
    `where <caption> is a specific one-line description (max 12 words) of what the image shows,`,
    `and <slug> is a 3-6 word lowercase-hyphenated filename slug capturing its subject.`,
    `No preamble, no quotes, no second line. NEVER use em dashes.`,
  ].join("\n");
  const out = (await runChatTurn({
    prompt,
    cwd: dirname(absImagePath),
    cli: claude,
    model: CAPTION_MODEL,
    isFirst: true,
    bare: true,
    maxOutputChars: 400,
    signal: AbortSignal.timeout(90_000),
  })).trim();
  return parseCaptionReply(out);
}

// Tolerant parse of "<caption> | <slug>". Exported for tests.
export function parseCaptionReply(out: string): { caption: string; slug: string } | null {
  const line = out.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  const bar = line.lastIndexOf("|");
  if (bar === -1) return null;
  const caption = line.slice(0, bar).trim().slice(0, 160);
  const slug = line.slice(bar + 1).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!caption || !slug) return null;
  return { caption, slug };
}

export interface CaptionResult {
  captioned: number;
  renamed: number;
  skipped: number;
  remaining: number;
}

// Caption up to `limit` uncaptioned index entries: look once with Haiku, store
// the caption, and rename the file to YYYY-MM-DD_<slug>.<ext> (collision-safe;
// the index keeps the original name). Missing files are marked skipped so they
// are not retried forever. Never throws; the whole pass is best-effort.
export async function captionPendingAttachments(
  vaultPath: string,
  limit = 4,
  captioner: Captioner = haikuCaptioner,
): Promise<CaptionResult> {
  const res: CaptionResult = { captioned: 0, renamed: 0, skipped: 0, remaining: 0 };
  const p = indexPath(vaultPath);
  const rows = readAttachmentIndex(vaultPath);
  const pending = rows.filter((r) => !r.caption);
  const batch = pending.slice(0, Math.max(0, limit));
  if (batch.length === 0) return res;
  const root = resolve(vaultPath);
  for (const row of batch) {
    const abs = join(root, row.file);
    if (!existsSync(abs)) {
      row.caption = "(file missing)";
      row.captioned_ts = Date.now();
      res.skipped += 1;
      continue;
    }
    let got: { caption: string; slug: string } | null = null;
    try { got = await captioner(abs); } catch { got = null; }
    if (!got) { res.skipped += 1; continue; } // transient - retry next pass
    row.caption = got.caption;
    row.captioned_ts = Date.now();
    res.captioned += 1;
    // Semantic rename: YYYY-MM-DD_<slug>.<ext>, collision-safe.
    try {
      const ext = extname(abs) || ".png";
      const day = new Date(row.ts || Date.now()).toISOString().slice(0, 10);
      const dir = dirname(abs);
      let base = `${day}_${got.slug}`;
      let dest = join(dir, `${base}${ext}`);
      let n = 2;
      while (existsSync(dest) && dest !== abs) {
        dest = join(dir, `${base}-${n}${ext}`);
        n += 1;
      }
      if (dest !== abs) {
        renameSync(abs, dest);
        row.original = row.file;
        row.file = row.file.slice(0, row.file.length - (abs.length - dir.length)) + dest.slice(dir.length);
        // Normalize separators: recompute relative cleanly.
        row.file = dest.slice(root.length + 1);
        res.renamed += 1;
      }
    } catch { /* rename is cosmetic - the caption already landed */ }
  }
  // Rewrite the whole index under a sibling lock (NEVER lock the data file
  // itself - the lock path is deleted on release).
  try {
    mkdirSync(dirname(p), { recursive: true });
    await withLock(`${p}.lock`, async () => {
      vwriteFile(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    });
  } catch { /* best effort */ }
  res.remaining = rows.filter((r) => !r.caption).length;
  return res;
}
