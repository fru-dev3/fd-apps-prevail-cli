// Work mode's assembly step: before a task is dispatched, the chief of staff
// brings in the specialists the work needs (by what it asks: a search, a
// draft, numbers, a plan) and gathers what the vault already knows that the
// work will need (the user's home city for "near me", a person's page, an
// app's connection, the destination's notes). It all goes into the brief, so
// the agent never has to ask for something the vault knows; the panel shows
// each item as one plain line ("Your home city, from your profile").

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { domainDir } from "./decisions.ts";
import { listPages } from "./entities.ts";
import { readProfile } from "./goals.ts";
import { appRecords } from "./ia.ts";
import { loadSpecialists } from "./specialists.ts";
import type { RoutedTask } from "./work-router.ts";

/** One thing the vault knows that the work needs: `label` is the plain line on the card, `text` goes in the brief. */
export interface ContextItem { label: string; text: string }

// What the task asks for, by its words, and the specialist who does that.
const NEEDS: [RegExp, string][] = [
  [/\b(find|search|look (?:up|for|into)|research|any good|recommend|best|compare|where (?:is|are|can)|options for)\b/i, "researcher"],
  [/\b(draft|reply|respond|write|email|letter|message|note to)\b/i, "writer"],
  [/\b(numbers?|budget|costs?|prices?|spend|how much|analy[sz]e|calculate|totals?)\b/i, "analyst"],
  [/\b(plan|schedule|itinerary|steps|roadmap)\b/i, "planner"],
];

/** The specialists the work needs, by what it asks, added to the router's (three at most, only ones that are on). */
export function neededSpecialists(vault: string, t: Pick<RoutedTask, "text" | "shape" | "flags" | "specialists">): string[] {
  const on = new Set(loadSpecialists(vault).filter((s) => s.on).map((s) => s.id));
  const want = [...t.specialists];
  for (const [re, id] of NEEDS) if (re.test(t.text)) want.push(id);
  if (t.shape === "find") want.push("researcher");
  if (t.flags.numbers || t.flags.money) want.push("analyst");
  return [...new Set(want)].filter((id) => on.has(id)).slice(0, 3);
}

const NEAR = /\b(near me|around me|nearby|close to me|close by|in my area|local(?:ly)?|around here|near here|where i live)\b/i;
const LOCATION_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:home city|location|city|hometown|lives? in|based in|home)(?:\*\*)?\s*[:=-]\s*(.{2,80}?)\s*$/im;
const LOCATION_SAID = /\b(?:I live in|I'm based in|I am based in|lives in|based in)\s+([A-Z][\w .,'-]{1,60}?)(?:[.;\n]|$)/;

/** Where the user lives, from their profile, then General's memory and notes. */
export function ownerLocation(vault: string): { text: string; from: string } | null {
  const read = (p: string) => { try { return existsSync(p) ? readFileSync(p, "utf8") : ""; } catch { return ""; } };
  const general = domainDir(vault, "general");
  const sources: [string, string][] = [
    [readProfile(vault), "your profile"],
    [read(join(general, "memory", "memory.md")), "your General memory"],
    [read(join(general, "memory", "state.md")), "your General notes"],
  ];
  for (const [text, from] of sources) {
    const m = LOCATION_LINE.exec(text) ?? LOCATION_SAID.exec(text);
    const place = m?.[1]?.replace(/[*_`]+/g, "").trim();
    if (place) return { text: place, from };
  }
  return null;
}

const body = (raw: string, n: number) => raw.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/\s+/g, " ").trim().slice(0, n);

/** What the vault knows that this task will need. Never throws; an empty list when nothing fits. */
export function gatherContext(vault: string, t: Pick<RoutedTask, "text" | "dest">): ContextItem[] {
  const out: ContextItem[] = [];
  try {
    if (NEAR.test(t.text)) {
      const loc = ownerLocation(vault);
      if (loc) out.push({ label: `Your home city, from ${loc.from}`, text: `The user's home city: ${loc.text}. "Near me" means near there.` });
    }
  } catch { /* no profile */ }
  const d = t.dest;
  try {
    if (d?.entity) {
      const p = listPages(vault).find((x) => x.id === d.entity);
      if (p) {
        const text = body(readFileSync(join(vault, p.path), "utf8"), 800);
        if (text) out.push({ label: `${p.doc.name}'s page`, text: `About ${p.doc.name}: ${text}` });
      }
    }
  } catch { /* no page */ }
  try {
    if (d?.kind === "app") {
      const a = appRecords(vault).find((x) => x.id === d.id);
      if (a) out.push({ label: `Your ${a.title} connection`, text: `The user's ${a.title} app is connected in Prevail${a.domains.length ? ` (${a.domains.join(", ")})` : ""}; its records are in data/apps/${a.id}/.` });
    }
  } catch { /* no apps */ }
  try {
    if (d?.kind === "domain" && d.id !== "general") {
      const state = body(readFileSync(join(domainDir(vault, d.id), "memory", "state.md"), "utf8"), 600);
      if (state) out.push({ label: `${d.label} notes`, text: `Where ${d.label} stands: ${state}` });
    }
  } catch { /* no notes */ }
  return out;
}
