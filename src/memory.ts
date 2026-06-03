import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { OLLAMA_BASE_URL } from "./cli-bridge.ts";

// Markdown-native vault memory.
//
// Every chat/council log entry can optionally carry an embedding vector
// inlined as a single comment line right under its time header:
//
//   ## 14:32  ·  ⚖ council
//   <!-- prevail-meta: id=... | gut=... | retro_due=... -->
//   <!-- prevail-embed: 0.012,-0.0473,0.214,...  (384 dims, base96-ish) -->
//
//   **Q:** ...
//
// At retrieval time we walk every _log/*.md under the user's vault, parse
// the embed lines, score by dot product against the query embedding, and
// return the top-k entries. At personal-vault scale (low thousands of
// entries) this is single-digit milliseconds on local CPU — no DB, no
// migration risk, the vault stays portable.
//
// Embedder: tries Ollama's /api/embeddings with the standard
// nomic-embed-text model first. If Ollama isn't reachable or the model
// isn't pulled, returns null and the caller falls back to FTS5 (already
// in session.ts) for keyword retrieval.

export const EMBED_PREFIX = "<!-- prevail-embed:";
export const EMBED_SUFFIX = "-->";
export const EMBED_MODEL = process.env.PREVAIL_EMBED_MODEL || "nomic-embed-text";

// Compact text encoding for a vector — 6 decimal digits per float, comma
// separated. A 384-dim vector encodes to ~3KB. We deliberately don't use
// base64-of-Float32Array because then the vector isn't human-readable in
// the log file, which violates the all-markdown principle.
export function encodeEmbedding(vec: number[]): string {
  return `${EMBED_PREFIX} ${vec.map((v) => v.toFixed(6)).join(",")} ${EMBED_SUFFIX}`;
}

export function decodeEmbedding(line: string): number[] | null {
  const t = line.trim();
  if (!t.startsWith(EMBED_PREFIX) || !t.endsWith(EMBED_SUFFIX)) return null;
  const body = t.slice(EMBED_PREFIX.length, -EMBED_SUFFIX.length).trim();
  const parts = body.split(",");
  if (parts.length < 8) return null;
  const out: number[] = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

// Ask the configured embedder for a single vector. Returns null when no
// embedder is available (Ollama down, model not pulled, etc.) so callers
// can fall back gracefully to keyword retrieval.
export async function embedText(text: string, signal?: AbortSignal): Promise<number[] | null> {
  const url = `${OLLAMA_BASE_URL.replace(/\/+$/, "")}/api/embeddings`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(j.embedding) || j.embedding.length === 0) return null;
    return j.embedding;
  } catch {
    return null;
  }
}

// Dot product on equal-length vectors. Both should already be normalized
// (Ollama embeddings are L2-normalized by default), so this is cosine
// similarity in disguise — no normalization step needed at query time.
export function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export interface MemoryHit {
  domain: string;
  file: string;
  excerpt: string;     // the Q/A text under the header
  score: number;
  ts: number | null;   // entry timestamp if parseable from the header
}

// Walk every _log/*.md across every domain in the vault and find the top-k
// most semantically similar entries to the query. Pure linear scan; at
// personal-vault scale this is fast enough not to need an index.
export async function recall(args: {
  vaultPath: string;
  query: string;
  k?: number;
  domainFilter?: string;  // restrict to one domain when set
  signal?: AbortSignal;
}): Promise<MemoryHit[]> {
  const qvec = await embedText(args.query, args.signal);
  if (!qvec) return [];
  const k = args.k ?? 3;
  const hits: MemoryHit[] = [];
  let domains: string[];
  try {
    domains = readdirSync(args.vaultPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
  for (const domain of domains) {
    if (args.domainFilter && domain.toLowerCase() !== args.domainFilter.toLowerCase()) continue;
    const logDir = join(args.vaultPath, domain, "_log");
    if (!existsSync(logDir)) continue;
    let files: string[];
    try {
      files = readdirSync(logDir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(logDir, f);
      let content: string;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      // Sections within a daily log are demarcated by "## HH:MM" headers.
      // Walk forward, accumulate header → meta → embed → body, score the
      // embed against qvec.
      const lines = content.split("\n");
      let i = 0;
      while (i < lines.length) {
        const headerMatch = lines[i]!.match(/^##\s+(\d{2}:\d{2})/);
        if (!headerMatch) {
          i++;
          continue;
        }
        const startLine = i;
        let embed: number[] | null = null;
        let bodyEnd = startLine + 1;
        for (let j = startLine + 1; j < lines.length; j++) {
          if (j > startLine + 1 && /^##\s/.test(lines[j]!)) {
            bodyEnd = j;
            break;
          }
          if (!embed) {
            const dec = decodeEmbedding(lines[j]!);
            if (dec) embed = dec;
          }
          bodyEnd = j + 1;
        }
        if (embed && embed.length === qvec.length) {
          const score = dot(qvec, embed);
          const excerpt = lines.slice(startLine, bodyEnd).join("\n").trim();
          hits.push({
            domain,
            file: path,
            excerpt,
            score,
            ts: parseHeaderDate(f, headerMatch[1]!),
          });
        }
        i = bodyEnd;
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

function parseHeaderDate(file: string, hhmm: string): number | null {
  const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  if (!dateMatch) return null;
  const ts = Date.parse(`${dateMatch[1]}T${hhmm}:00`);
  return Number.isFinite(ts) ? ts : null;
}

// Add an embedding line to a log entry IF Ollama is reachable. Idempotent:
// if the entry already has an embed line, skip. Used by writeTurnSummary
// AFTER the entry is written — caller passes the appended text + the path.
export async function indexEntry(args: {
  filePath: string;
  text: string;          // the Q+A body to embed
  headerLine: string;    // "## HH:MM  ·  ..." — used to find the section
  signal?: AbortSignal;
}): Promise<boolean> {
  const vec = await embedText(args.text, args.signal);
  if (!vec) return false;
  let content: string;
  try {
    content = readFileSync(args.filePath, "utf8");
  } catch {
    return false;
  }
  const lines = content.split("\n");
  // Find the LAST occurrence of the header line — writeTurnSummary just
  // appended this entry, so the latest match is the one to annotate.
  let headerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() === args.headerLine.trim()) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return false;
  // If an embed already exists in the next 4 lines, skip (idempotent).
  for (let i = headerIdx + 1; i < Math.min(lines.length, headerIdx + 5); i++) {
    if (lines[i]!.trim().startsWith(EMBED_PREFIX)) return true;
  }
  // Find insertion point — right after any prevail-meta line, otherwise
  // immediately after the header.
  let insertAt = headerIdx + 1;
  if (insertAt < lines.length && lines[insertAt]!.trim().startsWith("<!-- prevail-meta:")) {
    insertAt++;
  }
  lines.splice(insertAt, 0, encodeEmbedding(vec));
  writeFileSync(args.filePath, lines.join("\n"));
  return true;
}

// Format a list of recall hits as a <context> block to prepend to a council
// prompt. Each hit shows the score so the user can see why it was included.
export function formatRecallContext(hits: MemoryHit[]): string {
  if (hits.length === 0) return "";
  const lines = [
    "<context source=\"vault memory\">",
    "Relevant prior decisions from your vault (most similar first):",
    "",
  ];
  for (const h of hits) {
    const when = h.ts ? new Date(h.ts).toISOString().slice(0, 10) : "(?)";
    lines.push(`### ${h.domain} · ${when} · score ${h.score.toFixed(2)}`);
    lines.push(h.excerpt.split("\n").slice(0, 8).join("\n"));
    lines.push("");
  }
  lines.push("</context>");
  return lines.join("\n");
}
