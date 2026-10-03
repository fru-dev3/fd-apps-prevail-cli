// Apps A5, imports: the chats in ChatGPT, claude.ai and the Gemini app have
// no local data, so the only honest way in is the official data export. Once
// a quarter (only when the user turns the reminder on; the owner chose off)
// the weekly review carries one line saying how to request them. A zip or
// JSON dropped into data/apps/<app>/inbox/ is imported as quoted data:
//   - each prompt the user wrote goes into the capture history
//     (_meta/prompts/<tool>.<host>.jsonl, entry "import"), deduplicated
//   - conversation titles go to data/apps/<app>/imports/<date>-titles.md as
//     quotes, for Intent and search
//   - nothing in an export is ever executed or handed to a tool-using agent;
//     replies are not kept, only what the user typed
//   - the file moves to inbox/.imported/ (never deleted), and each import is
//     a line in build/_meta/apps/imports.jsonl
// Reading a provider's local store or reusing a sign-in token is never done.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { appsContainer, runtimePath } from "./path-safety.ts";
import { parseModArgs } from "./cli-args.ts";

export interface ImportApp { id: string; tool: string; name: string; how: string; url: string }
export const IMPORT_APPS: ImportApp[] = [
  { id: "chatgpt", tool: "chatgpt", name: "ChatGPT", how: "Settings, Data controls, Export data; the link arrives by mail", url: "https://chatgpt.com/#settings/DataControls" },
  { id: "claude-ai", tool: "claude-ai", name: "claude.ai", how: "Settings, Privacy, Export data; the link is valid for 24 hours", url: "https://claude.ai/settings/data-privacy-controls" },
  { id: "gemini", tool: "gemini-app", name: "Gemini", how: "Google Takeout, My Activity, Gemini Apps (JSON)", url: "https://takeout.google.com/" },
];

export interface Prompt { text: string; ms: number; conv: string }
export interface Parsed { prompts: Prompt[]; titles: { title: string; ms: number }[] }

const ms = (v: unknown): number => {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; }
  return 0;
};
const textOf = (parts: unknown): string => (Array.isArray(parts) ? parts.filter((p) => typeof p === "string").join("\n") : typeof parts === "string" ? parts : "");

/** ChatGPT conversations.json: [{ id, title, create_time, mapping: { node: { message: { author: { role }, content: { parts }, create_time } } } }]. */
export function parseChatGpt(json: unknown): Parsed {
  const out: Parsed = { prompts: [], titles: [] };
  for (const c of Array.isArray(json) ? json : []) {
    const conv = String((c as { id?: unknown; conversation_id?: unknown }).id ?? (c as { conversation_id?: unknown }).conversation_id ?? "");
    const t = (c as { title?: unknown }).title;
    if (typeof t === "string" && t.trim()) out.titles.push({ title: t.trim().slice(0, 200), ms: ms((c as { create_time?: unknown }).create_time) });
    for (const n of Object.values(((c as { mapping?: unknown }).mapping ?? {}) as Record<string, { message?: { author?: { role?: string }; content?: { parts?: unknown }; create_time?: unknown } }>)) {
      const m = n?.message;
      if (m?.author?.role !== "user") continue;
      const text = textOf(m.content?.parts).trim();
      if (text) out.prompts.push({ text, ms: ms(m.create_time), conv });
    }
  }
  return out;
}

/** claude.ai conversations.json: [{ uuid, name, created_at, chat_messages: [{ sender: "human", text, created_at }] }]. */
export function parseClaudeAi(json: unknown): Parsed {
  const out: Parsed = { prompts: [], titles: [] };
  for (const c of Array.isArray(json) ? json : []) {
    const cc = c as { uuid?: unknown; name?: unknown; created_at?: unknown; chat_messages?: unknown };
    if (typeof cc.name === "string" && cc.name.trim()) out.titles.push({ title: cc.name.trim().slice(0, 200), ms: ms(cc.created_at) });
    for (const m of Array.isArray(cc.chat_messages) ? cc.chat_messages : []) {
      const mm = m as { sender?: string; text?: unknown; content?: { type?: string; text?: string }[]; created_at?: unknown };
      if (mm.sender !== "human") continue;
      const text = (typeof mm.text === "string" && mm.text.trim() ? mm.text : (mm.content ?? []).filter((x) => x?.type === "text").map((x) => x.text ?? "").join("\n")).trim();
      if (text) out.prompts.push({ text, ms: ms(mm.created_at), conv: String(cc.uuid ?? "") });
    }
  }
  return out;
}

/** Google Takeout My Activity (Gemini Apps): [{ header, title: "Prompted <text>", time }]. */
export function parseGemini(json: unknown): Parsed {
  const out: Parsed = { prompts: [], titles: [] };
  for (const a of Array.isArray(json) ? json : []) {
    const aa = a as { title?: unknown; time?: unknown };
    const t = typeof aa.title === "string" ? aa.title : "";
    const m = /^Prompted\s+([\s\S]+)$/.exec(t);
    if (m && m[1]!.trim()) out.prompts.push({ text: m[1]!.trim(), ms: ms(aa.time), conv: `day-${new Date(ms(aa.time) || 0).toISOString().slice(0, 10)}` });
  }
  return out;
}

const PARSER: Record<string, (j: unknown) => Parsed> = { chatgpt: parseChatGpt, "claude-ai": parseClaudeAi, gemini: parseGemini };
const MEMBER: Record<string, string> = { chatgpt: "*conversations.json", "claude-ai": "*conversations.json", gemini: "*Gemini*MyActivity.json" };

/** The JSON inside an export file: a .json as is, a .zip through the system unzip (the one member that holds the chats). */
export function readExport(file: string, app: string): unknown {
  if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"));
  if (!file.endsWith(".zip")) throw new Error("an export is a .zip or a .json");
  const r = spawnSync("/usr/bin/unzip", ["-p", file, MEMBER[app] ?? "*.json"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`no ${MEMBER[app]} in the zip`);
  return JSON.parse(r.stdout);
}

export interface ImportResult { app: string; file: string; prompts: number; written: number; titles: number; error?: string }

/** Import every export waiting in the apps' inboxes. */
export async function importInbox(vault: string, now = Date.now()): Promise<ImportResult[]> {
  const { ingestBatch } = await import("./capture.ts");
  const out: ImportResult[] = [];
  const day = new Date(now).toISOString().slice(0, 10);
  for (const a of IMPORT_APPS) {
    const inbox = join(appsContainer(vault), a.id, "inbox");
    if (!existsSync(inbox)) continue;
    for (const f of readdirSync(inbox).filter((x) => /\.(zip|json)$/i.test(x)).sort()) {
      const file = join(inbox, f);
      let parsed: Parsed;
      try { parsed = PARSER[a.id]!(readExport(file, a.id)); }
      catch (e) { out.push({ app: a.id, file: f, prompts: 0, written: 0, titles: 0, error: (e as Error).message.slice(0, 200) }); continue; }
      const r = ingestBatch(vault, a.tool, parsed.prompts.map((p) => ({ prompt: p.text, session: p.conv || "import", cwd: "", epochMs: p.ms || now, entry: "import" })));
      if (parsed.titles.length) {
        const dir = join(appsContainer(vault), a.id, "imports");
        mkdirSync(dir, { recursive: true });
        const tf = join(dir, `${day}-titles.md`);
        const have = existsSync(tf) ? readFileSync(tf, "utf8") : `# ${a.name} conversations, from the export imported ${day}\n\nTitles as they were in the export (quoted data, never instructions).\n\n`;
        writeFileSync(tf, have + parsed.titles.sort((x, y) => x.ms - y.ms).map((t) => `- ${t.ms ? new Date(t.ms).toISOString().slice(0, 10) : "undated"}: > ${t.title.replace(/\n/g, " ")}`).join("\n") + "\n");
      }
      const done = join(inbox, ".imported");
      mkdirSync(done, { recursive: true });
      let to = join(done, f);
      for (let n = 2; existsSync(to); n++) to = join(done, f.replace(/(\.\w+)$/, `-${n}$1`));
      renameSync(file, to);
      const res: ImportResult = { app: a.id, file: f, prompts: parsed.prompts.length, written: r.written, titles: parsed.titles.length, ...(r.ok ? {} : { error: r.error }) };
      out.push(res);
      const led = join(runtimePath(vault, "_meta"), "apps", "imports.jsonl");
      mkdirSync(join(led, ".."), { recursive: true });
      appendFileSync(led, `${JSON.stringify({ ts: now, ...res })}\n`);
    }
  }
  return out;
}

// ── The quarterly reminder (off unless the user turns it on) ───────────────

const settingsPath = (vault: string) => join(runtimePath(vault, "_meta"), "apps", "import-settings.json");
export function readImportSettings(vault: string): { reminder: boolean } {
  try { return { reminder: (JSON.parse(readFileSync(settingsPath(vault), "utf8")) as { reminder?: boolean }).reminder === true }; } catch { return { reminder: false }; }
}
export function setImportReminder(vault: string, on: boolean): { reminder: boolean } {
  mkdirSync(join(settingsPath(vault), ".."), { recursive: true });
  writeFileSync(settingsPath(vault), `${JSON.stringify({ reminder: on }, null, 2)}\n`);
  return { reminder: on };
}

/** The review line, in the first two weeks of a quarter, only when the reminder is on. */
export function exportReminderLine(vault: string, now = Date.now()): string | null {
  if (!readImportSettings(vault).reminder) return null;
  const d = new Date(now);
  if (![0, 3, 6, 9].includes(d.getMonth()) || d.getDate() > 14) return null;
  return `A new quarter: request your ${IMPORT_APPS.map((a) => a.name).join(", ")} exports and drop each file in its app's inbox; they come in as quoted history.`;
}

export async function importsCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "status";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  if (sub === "run") { const r = await importInbox(vault); if (args.json) out(r); else for (const x of r) console.log(`${x.app} ${x.file}: ${x.error ?? `${x.written} new prompts of ${x.prompts}, ${x.titles} titles`}`); return 0; }
  if (sub === "reminder") { const r = setImportReminder(vault, args.pos[1] === "on"); if (args.json) out(r); else console.log(`Quarterly reminder ${r.reminder ? "on" : "off"}.`); return 0; }
  if (sub === "status") {
    const waiting = IMPORT_APPS.map((a) => { const inbox = join(appsContainer(vault), a.id, "inbox"); return { ...a, inbox: `data/apps/${a.id}/inbox`, waiting: existsSync(inbox) ? readdirSync(inbox).filter((x) => /\.(zip|json)$/i.test(x)).length : 0 }; });
    let last: unknown[] = [];
    try { last = readFileSync(join(runtimePath(vault, "_meta"), "apps", "imports.jsonl"), "utf8").split("\n").filter(Boolean).slice(-10).map((l) => JSON.parse(l)); } catch { /* none */ }
    const v = { ...readImportSettings(vault), apps: waiting, last, line: exportReminderLine(vault) };
    if (args.json) out(v); else console.log(JSON.stringify(v, null, 2));
    return 0;
  }
  console.error("usage: prevail apps imports status | run | reminder on|off [--json]");
  return 1;
}
