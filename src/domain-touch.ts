// Domains, routed as you chat (owner feedback round 1, 2026-10-02: "if I'm
// making a YouTube video, pass it into the content domain... real estate to
// real estate"). Code first: each domain's own name and its manifest's
// routing keywords are matched against the user's own words. Two or more
// distinct hits (or the domain's own name), or the only domain named at all,
// make a touch by code, with the sentence that said it as the dated line.
// Single hits beside others are ties the model breaks, only inside a daily
// ceiling per machine; with no hit at all no model is asked.
//
// Each touch also lands, quietly, as one dated line in the domain's
// memory.md under "## Noted from conversations" with the thread it came
// from, so the domain's context grows from every chat. The thread shows
// "Noted in Content, Real Estate" with Undo, which takes back exactly the
// lines that turn wrote (memory.md line and update line), nothing else.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDomainDir, runtimePath } from "./path-safety.ts";
import { v4ContentPath } from "./vault-layout-v4.ts";
import { vreadFile, vwriteFile } from "./vault-session.ts";

/** Hits a domain needs to be touched by code alone. */
export const STRONG = 2;
/** Model tie-breaks per machine per day, at most. */
export const MODEL_PER_DAY = 40;
export const NOTED_HEADING = "## Noted from conversations";
/** Lines kept under the heading; older ones stay in updates.jsonl. */
export const NOTED_MAX = 60;

export interface CodeHit { slug: string; score: number; fact: string; matched: string[] }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

/** Score each candidate domain against the user's own words. Pure but for reading manifests. */
export function scoreDomains(vault: string, text: string, slugs: string[]): CodeHit[] {
  const said = text.slice(0, 4000);
  const lower = said.toLowerCase();
  const out: CodeHit[] = [];
  for (const slug of slugs) {
    let kws: string[] = [];
    let name = "";
    try {
      // The manifest as written (routing.keywords, identity.name); read directly so a test vault anywhere works.
      const m = JSON.parse(readFileSync(join(resolveDomainDir(vault, slug), "manifest.json"), "utf8")) as { routing?: { keywords?: unknown }; identity?: { name?: unknown } };
      kws = Array.isArray(m.routing?.keywords) ? m.routing.keywords.filter((k): k is string => typeof k === "string") : [];
      name = typeof m.identity?.name === "string" ? m.identity.name : "";
    } catch { /* no manifest */ }
    const own = [...new Set([slug.replace(/[-_]/g, " "), slug, name.toLowerCase()].filter((x) => x && x.length >= 3))];
    const words = [...new Set(kws.map((k) => k.toLowerCase().trim()).filter((k) => k.length >= 2 && !own.includes(k)))];
    const hit = (k: string) => new RegExp(`(^|[^a-z0-9])${esc(k)}(?=$|[^a-z0-9])`, "i").test(lower);
    const ownHit = own.filter(hit);
    const kwHit = words.filter(hit);
    const score = (ownHit.length ? 2 : 0) + kwHit.length;
    if (!score) continue;
    const first = [...ownHit, ...kwHit][0]!;
    const sentence = sentences(said).find((s) => new RegExp(`(^|[^a-z0-9])${esc(first)}(?=$|[^a-z0-9])`, "i").test(s)) ?? said;
    const fact = sentence.replace(/\s+/g, " ").trim();
    out.push({ slug, score, fact: fact.length > 180 ? `${fact.slice(0, 177)}...` : fact, matched: [...ownHit, ...kwHit] });
  }
  return out.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
}

// ── The daily ceiling on model tie-breaks (per machine) ───────────────────

const budgetPath = (vault: string) => runtimePath(vault, join("_meta", "linking", "model-budget.json"));
const today = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Take one model call from today's allowance; false when it is spent. */
export function spendModelCall(vault: string, now = Date.now(), cap = MODEL_PER_DAY): boolean {
  const p = budgetPath(vault);
  let b = { day: today(now), n: 0 };
  try { const x = JSON.parse(readFileSync(p, "utf8")); if (x?.day === b.day && Number.isFinite(x.n)) b = x; } catch { /* first call today */ }
  if (b.n >= cap) return false;
  b.n++;
  try { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(b)); } catch { /* the call still counts as allowed */ }
  return true;
}

// ── Noted in the domain's memory ─────────────────────────────────────────

export function memoryPath(vault: string, slug: string): string {
  const dir = resolveDomainDir(vault, slug);
  return v4ContentPath(dir, "memory/memory.md", "_memory.md");
}
const label = (s: string) => s === "general" ? "General" : s.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
// The user's own calendar day, not UTC.
const day = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const notedLine = (o: { ts: number; from: string; thread: string; fact: string }) =>
  `- ${day(o.ts)}: ${o.fact.replace(/\s+/g, " ").trim()} (from ${label(o.from)}, thread ${o.thread})`;

/** Add one dated line under "## Noted from conversations" in the domain's memory.md. Returns the line. */
export function noteInMemory(vault: string, slug: string, o: { ts: number; from: string; thread: string; fact: string }): string {
  const p = memoryPath(vault, slug);
  let md = "";
  try { md = vreadFile(p); } catch { md = existsSync(p) ? readFileSync(p, "utf8") : ""; }
  const line = notedLine(o);
  if (md.includes(line)) return line;
  const lines = md.split("\n");
  const at = lines.findIndex((l) => l.trim() === NOTED_HEADING);
  if (at < 0) {
    const body = md.replace(/\s*$/, "");
    md = `${body}${body ? "\n\n" : ""}${NOTED_HEADING}\n${line}\n`;
  } else {
    let end = at + 1;
    while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++;
    const section = lines.slice(at + 1, end).filter((l) => l.trim());
    const kept = [...section, line].slice(-NOTED_MAX);
    md = [...lines.slice(0, at + 1), ...kept, ...(end < lines.length ? ["", ...lines.slice(end)] : [""])].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  mkdirSync(dirname(p), { recursive: true });
  vwriteFile(p, md);
  return line;
}

/** Undo: take back exactly the line a turn wrote, in memory.md and in updates.jsonl. */
export function unnote(vault: string, slug: string, o: { ts: number; thread: string; line?: string }): boolean {
  let changed = false;
  const p = memoryPath(vault, slug);
  if (existsSync(p) && o.line) {
    const md = vreadFile(p);
    const next = md.split("\n").filter((l) => l !== o.line).join("\n");
    if (next !== md) { vwriteFile(p, next); changed = true; }
  }
  const u = join(resolveDomainDir(vault, slug), "memory", "updates.jsonl");
  if (existsSync(u)) {
    const rows = readFileSync(u, "utf8").split("\n");
    const keep = rows.filter((l) => { try { const r = JSON.parse(l); return !(r.ts === o.ts && r.thread === o.thread); } catch { return true; } });
    if (keep.length !== rows.length) { writeFileSync(u, keep.join("\n")); changed = true; }
  }
  return changed;
}
