#!/usr/bin/env bun
// curate-sample.ts — shape a migrated v2 vault into the shippable 10-domain
// sample. Deletes domains not in KEEP, writes real soul.md/goals.md for each
// kept domain (replacing migration TODO stubs), and scaffolds a new `mail`
// domain with synthetic content. Demo data only.
//
//   bun run scripts/curate-sample.ts <vault-path>

import {
  existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync,
} from "node:fs";
import { join } from "node:path";

const vault = process.argv[2];
if (!vault || !existsSync(vault)) { console.error("usage: curate-sample.ts <vault>"); process.exit(1); }

const TS = new Date().toISOString();
const fm = `---\nderived_from:\n  data: "synthetic-sample"\n  ledger: 0\nat: "${TS}"\nby: "sample-author"\nschema: 2\n---\n\n`;

type Domain = { title: string; soul: string; goals: string; state?: string; tasks?: object[] };

const KEEP: Record<string, Domain> = {
  chief: {
    title: "Chief",
    soul: "Your command center. The job here is to keep the whole of life in view, set one clear focus for the day, and make sure nothing important slips between the other domains.",
    goals: [
      "Run a weekly review every Sunday — metric: `weekly_reviews_done`, target: 4/month",
      "Keep the top 3 priorities visible every day",
      "Zero dropped commitments",
    ].join("\n"),
    state: "**Focus today:** ship the sample vault\n**Top 3:** finalize domains · review wealth · plan the week\n**Across life:** 2 items need a reply (Mail), insurance renewal in 22 days",
  },
  tax: {
    title: "Tax",
    soul: "Stay ahead of every tax obligation, keep more of what you earn, and never scramble at the deadline. Track deductions year-round and keep clean records.",
    goals: [
      "File by April 15 — metric: `filed_on_time`, target: yes",
      "Pay quarterly estimates on time",
      "Capture every eligible deduction",
    ].join("\n"),
    state: "**Tax year:** 2026\n**Status:** Q2 estimate due Jun 15\n**Deductions logged:** home office, 1099 expenses\n**Docs on hand:** W-2, two 1099s",
  },
  wealth: {
    title: "Wealth",
    soul: "Build durable, generational financial freedom — freedom over status, sleep-at-night risk, never forced to sell. Live below your means, invest consistently, and resist lifestyle creep.",
    goals: [
      "Reach $500k net worth by 2027 — metric: `net_worth`, target: 500000",
      "Keep savings rate at or above 30% — metric: `savings_rate`, target: 0.30",
      "Hold a 6-month emergency fund",
    ].join("\n"),
    state: "**Net worth:** $189,400\n**Savings rate:** 28%\n**Emergency fund:** 4.2 months\n**This quarter:** rebalance to 70/30, up 3.1%",
  },
  calendar: {
    title: "Calendar",
    soul: "Protect time for what counts — deep work, the people you love, and rest. Time-block the week, default to saying no, and avoid back-to-back meetings.",
    goals: [
      "Protect 15+ hours of focused work each week — metric: `focus_hours`, target: 15",
      "Plan the week every Monday morning",
      "Keep evenings unscheduled",
    ].join("\n"),
    state: "**This week:** 12 focus hours blocked\n**Upcoming:** dentist Thu 2pm, 1:1 Fri\n**Conflicts:** none\n**Open evenings:** 4 of 5",
  },
  health: {
    title: "Health",
    soul: "Energy and longevity to build and enjoy the life you want — fitness for capability, not aesthetics. Move daily, protect sleep above all, and choose consistency over intensity.",
    goals: [
      "Keep wellness score at or above 80 — metric: `wellness_score`, target: 80",
      "Train 4 times a week — metric: `workouts_per_week`, target: 4",
      "Average 7.5 hours of sleep",
    ].join("\n"),
    state: "**Wellness score:** 74/100\n**Workouts this week:** 3\n**Avg sleep:** 7.1h\n**Resting HR:** 58",
  },
  home: {
    title: "Home",
    soul: "A calm, well-run home base that supports the life you want. A place for everything, small upkeep over big repairs, cozy over fancy.",
    goals: [
      "Complete the monthly maintenance checklist — metric: `maintenance_done`, target: yes",
      "Declutter one area each month",
      "Keep home projects on schedule",
    ].join("\n"),
    state: "**Maintenance:** furnace filter due\n**Projects:** repaint office (in progress)\n**Recent:** fixed kitchen faucet\n**Supplies low:** air filters",
  },
  insurance: {
    title: "Insurance",
    soul: "The right coverage so a bad day never becomes a catastrophe — protect the downside, leave no gaps, and don't overpay. Review annually and close gaps fast.",
    goals: [
      "Carry no coverage gaps — metric: `coverage_gaps`, target: 0",
      "Review every policy once a year",
      "Handle renewals 30 days early",
    ].join("\n"),
    state: "**Policies:** auto, renter's, health, term life\n**Next renewal:** auto in 22 days\n**Gaps flagged:** umbrella policy worth considering\n**Last review:** Apr 2026",
  },
  learning: {
    title: "Learning",
    soul: "Keep growing — skills, ideas, and curiosity compounding over a lifetime. Learn in public, choose depth over breadth, and apply what you learn.",
    goals: [
      "Finish one course each quarter — metric: `courses_completed`, target: 4/yr",
      "Read 12 books this year — metric: `books_read`, target: 12",
      "Pick up one new skill this year",
    ].join("\n"),
    state: "**Currently learning:** Rust\n**Books this year:** 5 of 12\n**Course in progress:** systems design (60%)\n**Next up:** a writing course",
  },
  explore: {
    title: "Explore",
    soul: "A life rich with fun, adventure, and new experiences — not all work. Say yes to novelty, plan trips ahead, and make memories worth keeping.",
    goals: [
      "Take one trip each quarter — metric: `trips`, target: 4/yr",
      "Try one new activity each month",
      "Keep weekends open for adventure",
    ].join("\n"),
    state: "**Next trip:** Portland (3 weeks out)\n**Tried recently:** bouldering\n**Wishlist:** Japan, learn to surf\n**This weekend:** farmers market + hike",
  },
  mail: {
    title: "Mail",
    soul: "Stay on top of the inbox without living in it — important threads handled, noise filtered, nothing dropped. Treat the inbox as a to-do queue, not a filing cabinet: reply or defer, and unsubscribe ruthlessly.",
    goals: [
      "Keep the inbox under 10 by Friday — metric: `inbox_count`, target: 10",
      "Reply to key threads within 24 hours — metric: `reply_within_24h`, target: 0.9",
      "Drop nothing that was actually asked of you",
    ].join("\n"),
    state: "**Inbox:** 23 unread · 3 need a reply · 5 newsletters\n\n**Needs a reply:**\n- Landlord — lease renewal terms (2 days)\n- Recruiter @ Stripe — interview times (4 days)\n- Mom — call this weekend\n\n**Recently handled:**\n- Paid electricity bill\n- Confirmed dentist appointment",
    tasks: [
      { id: "t_1", title: "Reply to landlord about lease renewal", status: "open", priority: "high", due: "2026-06-09", goal: "reply_within_24h", source: "thread:inbox", created: TS, updated: TS },
      { id: "t_2", title: "Send interview availability to recruiter", status: "open", priority: "normal", source: "thread:inbox", created: TS, updated: TS },
      { id: "t_3", title: "Unsubscribe from 5 newsletters", status: "open", priority: "low", source: "thread:inbox", created: TS, updated: TS },
    ],
  },
};

// Mail gets a couple of starter skills so it doesn't look empty.
const MAIL_SKILLS: Record<string, string> = {
  "mail-flow-triage-inbox":
    "---\nname: mail-flow-triage-inbox\ntype: flow\n---\n\n# Triage the inbox\n\nSort unread mail into: needs-reply, defer, read-later, unsubscribe. Append a\ntask to `_tasks.jsonl` for anything that needs a reply, and log newsletters to\nunsubscribe. Leave the inbox with only what truly needs you.\n",
  "mail-task-draft-reply":
    "---\nname: mail-task-draft-reply\ntype: task\n---\n\n# Draft a reply\n\nGiven a thread, draft a concise reply in the user's voice. Keep it short, lead\nwith the answer, and end with a clear next step. Never send — present the draft\nfor approval.\n",
};

function write(p: string, c: string) { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, c); }
function gitkeep(d: string) { mkdirSync(d, { recursive: true }); if (readdirSync(d).length === 0) writeFileSync(join(d, ".gitkeep"), ""); }

// 1. delete domains not in KEEP (+ stray root junk)
let deleted = 0;
for (const e of readdirSync(vault, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const reserved = ["apps", "benchmark", "core", "complete"].includes(e.name);
  if (reserved) continue;
  if (e.name.startsWith("_") || (!KEEP[e.name] && e.name !== "mail")) {
    rmSync(join(vault, e.name), { recursive: true, force: true });
    console.log(`  deleted: ${e.name}`);
    deleted++;
  }
}

// 2. write real soul.md + goals.md + _state.md for each kept/new domain
let written = 0;
for (const [name, d] of Object.entries(KEEP)) {
  const dir = join(vault, name);
  const isNew = !existsSync(dir);
  if (isNew) { // scaffold the full v2 skeleton for `mail`
    for (const sub of ["data", "_meta", "_artifacts", "_skills", "_log", "_threads"]) gitkeep(join(dir, sub));
    write(join(dir, "config.md"), `# ${d.title} — Config\n\nsensitivity: sensitive\n`);
  }
  write(join(dir, "soul.md"), `# ${d.title}\n\n> Why this domain exists — your north star here.\n\n${d.soul}\n`);
  write(join(dir, "goals.md"), `# ${d.title} — Goals\n\n> Objectives and the metric each one is measured by.\n\n${d.goals.split("\n").map((g) => `- [ ] ${g}`).join("\n")}\n`);
  if (d.state) write(join(dir, "_state.md"), `${fm}# ${d.title}\n\n**Last updated:** 2026-06-06\n\n${d.state}\n`);
  if (d.tasks) writeFileSync(join(dir, "_tasks.jsonl"), d.tasks.map((t) => JSON.stringify(t)).join("\n") + "\n");
  written++;
}

// 3. mail skills
for (const [slug, body] of Object.entries(MAIL_SKILLS)) write(join(vault, "mail", "_skills", slug, "SKILL.md"), body);

console.log(`\ndone — ${deleted} deleted, ${written} domains written (incl. new mail). Final set: ${Object.keys(KEEP).sort().join(", ")}`);
