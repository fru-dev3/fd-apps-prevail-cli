// The chief of staff: the one the user talks to. Every user names their own;
// the name and persona live in the vault (build/chief-of-staff.md), never in
// code. General is the chief of staff's home: the general chat is where they
// answer, and the coordinator domains (chief, vision, intel) fold into it
// (fold.ts).
//
//   ---
//   name: <the user's choice>
//   voice: plain and short; an advisor, not a cheerleader
//   ---
//   ## Limits
//   - usd: 1
//   - minutes: 10
//   ## Never pull in
//   - health
//   ## What I've learned
//   - <one line per lesson>
//
// Unknown lines are kept when the file is written back.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRoot } from "./path-safety.ts";
import { vreadFile } from "./vault-session.ts";
import { writeVersioned } from "./goals.ts";
import { parseModArgs } from "./cli-args.ts";

export interface ChiefOfStaff {
  name: string | null;
  voice: string;
  limits: { usd: number; minutes: number };
  neverRead: string[];
  learned: string[];
  /** Jobs the chief of staff judges from chat: auto (start within limits), offer (always ask), off (only @ by hand). */
  handoff: "off" | "offer" | "auto";
  exists: boolean;
}

export const DEFAULT_LIMITS = { usd: 1, minutes: 10 };
export const DEFAULT_VOICE = "plain and short; an advisor who names misalignment, not a cheerleader";

export function chiefOfStaffPath(vault: string): string {
  return join(buildRoot(vault), "chief-of-staff.md");
}

function readText(p: string): string {
  if (!existsSync(p)) return "";
  try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } }
}

// A name is a short label shown in the sidebar and spoken in chat: letters,
// digits, spaces, dots, apostrophes and hyphens, up to 40 characters.
export function cleanName(raw: string): string | null {
  const n = raw.replace(/\s+/g, " ").trim();
  if (!n || n.length > 40 || !/^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u.test(n)) return null;
  return n;
}

function section(body: string, heading: string): string[] {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "im");
  const m = re.exec(body);
  if (!m) return [];
  const rest = body.slice(m.index + m[0].length);
  const next = /^##\s+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).split("\n").map((l) => l.match(/^\s*-\s+(.*\S)\s*$/)?.[1] ?? "").filter(Boolean);
}

export function parseChiefOfStaff(text: string): ChiefOfStaff {
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const field = (k: string) => fm?.[1]?.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
  const body = fm ? text.slice(fm[0].length) : text;
  const limits = { ...DEFAULT_LIMITS };
  for (const l of section(body, "Limits")) {
    const m = l.match(/^(usd|minutes):\s*([\d.]+)/i);
    if (m) limits[m[1]!.toLowerCase() as "usd" | "minutes"] = Number(m[2]);
  }
  return {
    name: cleanName(field("name")),
    voice: field("voice") || DEFAULT_VOICE,
    limits,
    neverRead: section(body, "Never pull in").map((s) => s.toLowerCase()),
    learned: section(body, "What I've learned"),
    handoff: (["off", "offer", "auto"] as const).find((h) => h === field("handoff")) ?? "auto",
    exists: !!text.trim(),
  };
}

export function readChiefOfStaff(vault: string): ChiefOfStaff {
  return parseChiefOfStaff(readText(chiefOfStaffPath(vault)));
}

function render(c: ChiefOfStaff): string {
  const lines = ["---", `name: ${c.name ?? ""}`, `voice: ${c.voice}`, "---", "",
    "## Limits", `- usd: ${c.limits.usd}`, `- minutes: ${c.limits.minutes}`, "",
    "## Never pull in", ...c.neverRead.map((d) => `- ${d}`), "",
    "## What I've learned", ...c.learned.map((l) => `- ${l}`), ""];
  return lines.join("\n");
}

/** Set the name, keeping every other line of the file (and the prior text as a version). */
export function setChiefOfStaffName(vault: string, raw: string): ChiefOfStaff {
  const name = cleanName(raw);
  if (!name) throw new Error("a name is 1 to 40 letters, digits, spaces, dots, apostrophes or hyphens");
  const p = chiefOfStaffPath(vault);
  const text = readText(p);
  let next: string;
  if (!text.trim()) next = render({ ...parseChiefOfStaff(""), name });
  else if (/^---\n[\s\S]*?^name:.*$/m.test(text)) next = text.replace(/^name:.*$/m, `name: ${name}`);
  else if (text.startsWith("---\n")) next = text.replace(/^---\n/, `---\nname: ${name}\n`);
  else next = `---\nname: ${name}\n---\n\n${text}`;
  writeVersioned(p, next);
  return parseChiefOfStaff(next);
}

/** Set the handoff mode, the limits or the never-read list, keeping every other line. */
export function setChiefSetting(vault: string, key: "handoff" | "usd" | "minutes" | "never", value: string): ChiefOfStaff {
  const p = chiefOfStaffPath(vault);
  let text = readText(p) || render(parseChiefOfStaff(""));
  if (key === "handoff") {
    if (!["off", "offer", "auto"].includes(value)) throw new Error("handoff is off, offer or auto");
    if (/^---\n[\s\S]*?^handoff:.*$/m.test(text)) text = text.replace(/^handoff:.*$/m, `handoff: ${value}`);
    else if (text.startsWith("---\n")) text = text.replace(/^---\n/, `---\nhandoff: ${value}\n`);
    else text = `---\nhandoff: ${value}\n---\n\n${text}`;
  } else if (key === "usd" || key === "minutes") {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > (key === "usd" ? 100 : 240)) throw new Error(`${key} must be a positive number (at most ${key === "usd" ? 100 : 240})`);
    const line = `- ${key}: ${n}`;
    if (new RegExp(`^-\\s+${key}:.*$`, "m").test(text)) text = text.replace(new RegExp(`^-\\s+${key}:.*$`, "m"), line);
    else if (/^##\s+Limits\s*$/m.test(text)) text = text.replace(/^(##\s+Limits\s*\n)/m, `$1${line}\n`);
    else text = `${text.replace(/\s*$/, "")}\n\n## Limits\n${line}\n`;
  } else {
    const list = value.split(",").map((d) => d.trim().toLowerCase()).filter((d) => /^[a-z0-9-]{1,40}$/.test(d));
    const block = `## Never pull in\n${list.map((d) => `- ${d}`).join("\n")}${list.length ? "\n" : ""}`;
    if (/^##\s+Never pull in\s*$/m.test(text)) text = text.replace(/^##\s+Never pull in\s*\n(?:-\s+.*\n?)*/m, `${block}\n`);
    else text = `${text.replace(/\s*$/, "")}\n\n${block}`;
  }
  writeVersioned(p, text);
  return parseChiefOfStaff(text);
}

export const CHIEF_HEADER = "# YOUR CHIEF OF STAFF";

/**
 * The persona line for a General turn: the general chat is the chief of
 * staff's. Empty when the user has not named one (General then speaks as the
 * app, as before).
 */
export function chiefOfStaffBlock(vault: string): string {
  const c = readChiefOfStaff(vault);
  if (!c.name) return "";
  return [
    `${CHIEF_HEADER}: in this chat you are ${c.name}, the user's chief of staff.`,
    "Answer directly when you can. For anything that belongs to one area of the user's life, say which domain owns it.",
    `Voice: ${c.voice}.`,
  ].join("\n");
}

export async function chiefCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "show";
  const json = args.json;
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  if (sub === "show") {
    const c = readChiefOfStaff(vault);
    if (json) out({ ...c, path: chiefOfStaffPath(vault) });
    else console.log(c.name ? `${c.name} (limits $${c.limits.usd}, ${c.limits.minutes} min)` : "Not named yet: prevail chief set-name <name>");
    return 0;
  }
  if (sub === "set-name") {
    const name = args.pos.slice(1).join(" ");
    try {
      const c = setChiefOfStaffName(vault, name);
      if (json) out({ ok: true, ...c });
      else console.log(`Named ${c.name}.`);
      return 0;
    } catch (e) {
      if (json) out({ ok: false, error: (e as Error).message });
      else console.error((e as Error).message);
      return 1;
    }
  }
  if (sub === "set") {
    const key = args.pos[1] as "handoff" | "usd" | "minutes" | "never";
    try {
      if (!["handoff", "usd", "minutes", "never"].includes(key)) throw new Error("usage: prevail chief set handoff|usd|minutes|never <value>");
      const c = setChiefSetting(vault, key, args.pos.slice(2).join(" "));
      if (json) out({ ok: true, ...c }); else console.log("Saved.");
      return 0;
    } catch (e) {
      if (json) out({ ok: false, error: (e as Error).message }); else console.error((e as Error).message);
      return 1;
    }
  }
  console.error("usage: prevail chief show|set-name <name>|set handoff|usd|minutes|never <value> [--json]");
  return 1;
}
