#!/usr/bin/env bun
// generate.ts — emit the demo vault from persona.ts.
//
//   bun run scripts/sample-gen/generate.ts <out-dir>
//
// Phase 1 (this file): the consistent markdown/jsonl backbone for every domain
// — soul.md, config.md, goals.md, _state.md, _tasks.jsonl — plus the standard
// empty subdirs. Data files (CSV/JSON/PDF/PNG) and chat threads are layered on
// by sibling generators. Everything derives from PERSONA, so it's consistent by
// construction and the cross-domain references are wired automatically.

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PERSONA as P } from "./persona.ts";

const OUT = process.argv[2] || join(import.meta.dir, "out-vault");
const TS = `${P.generatedAt}T09:00:00.000Z`;
const FM = `---\nderived_from:\n  data: "synthetic-sample"\n  ledger: 0\nat: "${TS}"\nby: "sample-author"\nschema: 2\n---\n\n`;

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Cross-domain "Open Items" — pulled from PERSONA.crossDomain so the same fact
// surfaces (phrased for the local domain) in every domain it links.
function crossItems(domain: string): string[] {
  return P.crossDomain
    .filter((t) => t.links.includes(domain))
    .map((t) => {
      const others = t.links.filter((d) => d !== domain);
      const see = others.length ? ` _(also: ${others.join(", ")})_` : "";
      return `- [ ] ${t.summary}${see}`;
    });
}

type DomainContent = { title: string; soul: string; goals: string[]; config: string; state: string };

const hh = P.household;
const j = hh.primary;
const W = P.wealth;
const A = W.accounts;
const homeEquity = W.home.marketValue - W.home.mortgage.balance;

// ── per-domain content, composed from PERSONA ─────────────────────────
const D: Record<string, DomainContent> = {
  chief: {
    title: "Chief",
    soul: "Your command center. Keep the whole of life in view, set one clear focus for the day, and make sure nothing important slips between the other domains.",
    goals: [
      "Run a weekly review every Sunday — metric: `weekly_reviews_done`, target: 4/month",
      "Keep the top 3 priorities visible every day",
      "Zero dropped commitments across domains",
    ],
    config: [
      "## Identity",
      `name: ${j.name}`,
      `household: ${j.name}, ${hh.partner.name} (partner), ${hh.child.name} (${hh.child.age})`,
      `location: ${hh.location.city}, ${hh.location.state}`,
      "",
      "## Operating rhythm",
      "weekly_review: Sunday evening",
      "daily_planning: each morning, pick ONE focus + top 3",
    ].join("\n"),
    state: [
      `**Focus today:** ${P.chief.focusToday}`,
      `**Top 3:** ${P.chief.top3.join(" · ")}`,
      "",
      "## Across life right now",
      ...P.chief.acrossLife.map((s) => `- ${s}`),
    ].join("\n"),
  },

  career: {
    title: "Career",
    soul: "Grow into leadership without losing the human touch — serve customers well, develop the team, and turn being bilingual and bicultural into a durable professional edge.",
    goals: [
      "Earn the Certified Branch Manager (CBM) credential this year — metric: `cbm_done`, target: yes",
      "Hit the branch's deposit-growth target — metric: `deposit_growth`, target: 0.08",
      "Be ready for the Area Manager conversation by the July review",
    ],
    config: [
      "## Role",
      `name: ${j.name}`,
      `title: ${j.job.title}`,
      `employer: ${j.job.employer}`,
      `tenure: ${j.job.yearsAtBank} yrs at the bank, ${j.job.yearsInRole} in the role`,
      `base_salary: ${usd(j.job.baseSalary)}`,
      `rsu_grant: ${usd(j.job.rsu.unvestedTotal)} unvested · next vest ${j.job.rsu.nextVestDate} (${usd(j.job.rsu.nextVestGross)} gross)`,
      "",
      "## Edge",
      ...P.career.strengths.map((s) => `- ${s}`),
    ].join("\n"),
    state: [
      `**Role:** ${P.career.role}`,
      `**Aiming for:** ${P.career.aiming}`,
      `**In progress:** ${P.career.cert}`,
      "",
      "## Where things stand",
      `${j.name} runs a Frontera Bank branch in ${hh.location.city} and is on a fast track — teller to branch manager in five years. Being bilingual is a real asset: a large share of the branch's customers are Spanish-speaking, and ${j.name.split(" ")[0]} is often the reason they stay. The ${P.career.review}.`,
      "",
      "## Open Items",
      ...crossItems("career"),
      "- [ ] Finish the CBM coursework (see learning)",
      "- [ ] Pull deposit-growth numbers for the July review",
    ].join("\n"),
  },

  wealth: {
    title: "Wealth",
    soul: "Build durable financial freedom for the family — live below our means, invest steadily, support the people we love (here and in Lima), and never be forced to sell.",
    goals: [
      "Reach $200k net worth by 2028 — metric: `net_worth`, target: 200000",
      "Keep the savings rate at or above 18% — metric: `savings_rate`, target: 0.18",
      "Hold a 6-month emergency fund",
    ],
    config: [
      "## Identity",
      `name: ${j.name}`,
      `household_income_w2: ${usd(W.householdW2Income)} (${j.name.split(" ")[0]} ${usd(j.job.baseSalary)} + ${hh.partner.name.split(" ")[0]} ${usd(hh.partner.job.baseSalary)})`,
      `monthly_savings: ${usd(W.monthlySavings)}`,
      "",
      "## Accounts",
      `checking: ${A.checking.institution} — ${usd(A.checking.balance)}`,
      `emergency_fund: ${A.emergencyFund.institution} (${(A.emergencyFund.apy * 100).toFixed(2)}% APY) — ${usd(A.emergencyFund.balance)}`,
      `taxable_brokerage: ${A.brokerageTaxable.institution} — ${usd(A.brokerageTaxable.balance)}`,
      `roth_ira: ${usd(A.roth.jordan)} (${j.name.split(" ")[0]}) + ${usd(A.roth.sam)} (${hh.partner.name.split(" ")[0]})`,
      `retirement: 401k ${usd(A.retirement.jordan401k)} (${A.retirement.jordanMatch}) + 403b ${usd(A.retirement.sam403b)}`,
      `hsa: ${usd(A.hsa)}`,
      `college_529: ${usd(A.college529.balance)} (${A.college529.beneficiary})`,
      "",
      "## Property & debt",
      `homestead: ${usd(W.home.marketValue)} (mortgage ${usd(W.home.mortgage.balance)} @ ${(W.home.mortgage.rate * 100).toFixed(2)}%, ${W.home.mortgage.lender})`,
      `auto_loan: ${W.vehicles[0].desc} — ${usd(W.vehicles[0].loanBalance)} @ ${(W.vehicles[0].rate! * 100).toFixed(1)}%`,
      "",
      "## International",
      `peru_account: ${P.international.peruSavingsAccount.institution} — ${usd(P.international.peruSavingsAccount.balanceUSD)} (FBAR-reportable)`,
      `peru_property: ${P.international.inheritedPropertyShare.what} — ~${usd(P.international.inheritedPropertyShare.estValueUSD)}`,
      `remittances: ${usd(hh.familyAbroad.remittanceMonthly)}/mo to ${hh.familyAbroad.who}`,
      "",
      "## Strategy",
      `allocation_current: ${W.allocation.current}`,
      `allocation_target: ${W.allocation.target}`,
      `fire_number: ${usd(W.fireTargetNumber)}`,
    ].join("\n"),
    state: [
      `**Net worth:** ${usd(133_980)}`,
      `**Savings rate:** 18%`,
      `**Emergency fund:** ${usd(A.emergencyFund.balance)} (about 3 months)`,
      "",
      "## Where things stand",
      `Two incomes (${usd(W.householdW2Income)} W2), a starter house in ${hh.location.city}, and the early innings of investing. Most of the net worth is retirement (${usd(A.retirement.jordan401k + A.retirement.sam403b)}) plus ${usd(homeEquity)} of home equity. About ${usd(P.international.inheritedPropertyShare.estValueUSD + P.international.peruSavingsAccount.balanceUSD)} sits in Lima — an inherited 1/3 share of the family home and a BCP savings account. ${usd(hh.familyAbroad.remittanceMonthly)}/mo goes to ${hh.familyAbroad.who.split("(")[0].trim()}, which is non-negotiable and built into the budget.`,
      "",
      "## The capital question",
      `The summer's main decision is the HVAC (${usd(P.home.hvac.replacementQuote)}). The emergency fund (${usd(A.emergencyFund.balance)}) can float it without touching investments, so it's replace-now versus wait — not whether it's affordable. Replacing the 2016 unit before peak Texas summer beats an emergency failure in July.`,
      "",
      "## Open Items",
      ...crossItems("wealth"),
      "- [ ] Earmark the net RSU proceeds after the Aug 15 vest (tax-aware)",
      "- [ ] Nudge new contributions toward bonds to drift back to 75/20/5",
    ].join("\n"),
  },

  tax: {
    title: "Tax",
    soul: "Stay ahead of every obligation — federal and the cross-border pieces — keep clean records all year, and never scramble at the deadline.",
    goals: [
      "File by April 15 — metric: `filed_on_time`, target: yes",
      "File the FBAR for the Peru account on time — metric: `fbar_filed`, target: yes",
      "Capture every eligible credit (Child Tax Credit, etc.)",
    ],
    config: [
      "## Filing",
      `tax_year: ${P.tax.year}`,
      `filing_status: ${P.tax.filingStatus}`,
      `state: ${P.tax.state}`,
      "",
      "## Forms expected",
      ...P.tax.forms.map((f) => `- ${f}`),
      "",
      "## Foreign reporting",
      `fbar_required: yes — ${P.tax.foreignReporting.fbar.reason}`,
      `fbar_deadline: ${P.tax.foreignReporting.fbar.deadline}`,
      `foreign_interest: ${P.tax.foreignReporting.foreignInterest}`,
      "",
      "## Credits",
      ...P.tax.credits.map((c) => `- ${c}`),
    ].join("\n"),
    state: [
      `**Tax year:** ${P.tax.year}`,
      `**Filing:** ${P.tax.filingStatus} · ${P.tax.state}`,
      `**Foreign:** FBAR required (BCP account ${usd(P.international.peruSavingsAccount.balanceUSD)})`,
      "",
      "## Where things stand",
      `Mostly a clean W2 return, with two wrinkles. First, the RSU vest on ${j.job.rsu.nextVestDate} (${usd(j.job.rsu.nextVestGross)} gross) is supplementally withheld at a flat rate and may slightly under-withhold — worth a check before April. Second, the cross-border piece: the BCP account in Lima crosses the $10,000 FBAR threshold, so FinCEN 114 is required, and the interest it earns is US-reportable. Remittances to ${hh.familyAbroad.who.split("(")[0].trim().toLowerCase()} aren't deductible and stay well under the gift-tax exclusion.`,
      "",
      "## Open Items",
      ...crossItems("tax"),
      "- [ ] Gather BCP year-end statement for FBAR + interest",
      "- [ ] Confirm RSU withholding won't leave an April balance",
    ].join("\n"),
  },

  health: {
    title: "Health",
    soul: "Energy and longevity to build the life we want — move daily, protect sleep, and treat the early signals seriously rather than waiting.",
    goals: P.health.goals.map((g, i) =>
      i === 0 ? `${g} — metric: \`wellness_score\`, target: 80`
      : i === 1 ? `${g} — metric: \`workouts_per_week\`, target: 4`
      : g),
    config: [
      "## Profile",
      `name: ${j.name}`,
      `pcp: ${P.health.jordan.pcp}`,
      `last_physical: ${P.health.jordan.lastPhysical}`,
      `resting_hr: ${P.health.jordan.restingHR}`,
      `avg_sleep: ${P.health.jordan.avgSleepHours}h`,
      "",
      "## Recent labs (flagged)",
      ...P.health.jordan.labFlags.map((f) => `- ${f}`),
    ].join("\n"),
    state: [
      `**Wellness score:** ${P.health.jordan.wellnessScore}/100`,
      `**Workouts this week:** ${P.health.jordan.workoutsPerWeek}`,
      `**Avg sleep:** ${P.health.jordan.avgSleepHours}h`,
      `**Resting HR:** ${P.health.jordan.restingHR}`,
      "",
      "## Where things stand",
      `The May physical was mostly good, but two early flags came back: LDL at 138 (borderline high — notable at 29) and low vitamin D. Dr. ${P.health.jordan.pcp.split(" ").slice(-1)} suggested diet + activity before anything else, plus a vitamin D supplement. The training plan (see fitness) is the lever here; the cholesterol number also matters for the term-life picture (see insurance).`,
      "",
      "## Open Items",
      ...crossItems("health"),
      "- [ ] Recheck LDL in 3 months after the diet/training changes",
      "- [ ] Start vitamin D supplement; re-test in fall",
    ].join("\n"),
  },

  fitness: {
    title: "Fitness",
    soul: "Train for capability and a long runway — consistency over intensity, and a goal on the calendar to keep it honest.",
    goals: [
      "Run the Austin half-marathon in November — metric: `half_marathon_done`, target: yes",
      "Train 4 sessions a week — metric: `sessions_per_week`, target: 4",
      "Bring resting HR under 55",
    ],
    config: [
      "## Plan",
      `weekly: ${P.fitness.plan}`,
      `event_goal: ${P.fitness.goal}`,
      `recent: ${P.fitness.recent}`,
      `hrv_trend: ${P.fitness.hrvTrend}`,
    ].join("\n"),
    state: [
      `**This week:** ${P.health.jordan.workoutsPerWeek} of 4 sessions`,
      `**Training for:** ${P.fitness.goal}`,
      `**Recent:** ${P.fitness.recent}`,
      "",
      "## Where things stand",
      `Three solid sessions most weeks, building toward a 4th. The half-marathon in November is the anchor; the zone-2 work doubles as the answer to the borderline cholesterol (see health). Bouldering on weekends has been the fun part and is quietly helping grip and core.`,
      "",
      "## Open Items",
      ...crossItems("fitness"),
      "- [ ] Add the 4th weekly session (short zone-2)",
      "- [ ] Book the November half-marathon before prices rise",
    ].join("\n"),
  },

  insurance: {
    title: "Insurance",
    soul: "The right coverage so a bad day never becomes a catastrophe — protect the downside, leave no gaps, and don't overpay.",
    goals: [
      "Carry no coverage gaps — metric: `coverage_gaps`, target: 0",
      "Add the umbrella policy this quarter — metric: `umbrella_added`, target: yes",
      "Handle every renewal 30 days early",
    ],
    config: [
      "## Policies",
      ...P.insurance.policies.map((p) => {
        const extra = [
          p.coverage ? `${usd(p.coverage)} coverage` : "",
          p.premiumMonthly ? `${usd(p.premiumMonthly)}/mo` : "",
          p.premiumAnnual ? `${usd(p.premiumAnnual)}/yr` : "",
          p.premiumSixMonth ? `${usd(p.premiumSixMonth)}/6mo` : "",
          p.renewal ? `renews ${p.renewal}` : "",
        ].filter(Boolean).join(" · ");
        return `- ${p.type} — ${p.carrier}${extra ? ` (${extra})` : ""}`;
      }),
      "",
      "## Gap",
      `- ${P.insurance.gap}`,
    ].join("\n"),
    state: [
      `**Policies:** home, auto, health, two term-life, employer LTD`,
      `**Next renewal:** auto in 22 days; home in September`,
      `**Gap flagged:** umbrella policy`,
      "",
      "## Where things stand",
      `Coverage is solid for a young family: ${usd(500_000)} term on ${j.name.split(" ")[0]}, ${usd(350_000)} on ${hh.partner.name.split(" ")[0]}, both cheap at this age, with ${hh.child.name.split(" ")[0]} as the reason they exist. Two threads to watch: the aging HVAC (see home) is the kind of thing the homeowner's carrier asks about at the September renewal, and there's still no umbrella — a $1M policy is roughly $180/yr and protects the home and savings.`,
      "",
      "## Open Items",
      ...crossItems("insurance"),
      "- [ ] Add the $1M umbrella before the auto renewal",
      "- [ ] Confirm HVAC replacement won't change the home renewal quote",
    ].join("\n"),
  },

  homestead: {
    title: "Home",
    soul: "A calm, well-run home base — small upkeep over big repairs, and decisions made before things break, not after.",
    goals: [
      "Replace the HVAC before peak summer — metric: `hvac_replaced`, target: yes",
      "Complete the monthly maintenance checklist — metric: `maintenance_done`, target: yes",
      "Keep one improvement project moving",
    ],
    config: [
      "## The house",
      `address: ${hh.location.address}, ${hh.location.city}, ${hh.location.state} ${hh.location.zip}`,
      `bought: 2024`,
      "",
      "## HVAC",
      `unit: ${P.home.hvac.unit}`,
      `status: ${P.home.hvac.status}`,
      `replacement_quote: ${usd(P.home.hvac.replacementQuote)}`,
      "",
      "## Maintenance",
      ...P.home.maintenance.map((m) => `- ${m}`),
    ].join("\n"),
    state: [
      `**HVAC:** ${P.home.hvac.unit} — ${P.home.hvac.status} (${usd(P.home.hvac.replacementQuote)} to replace)`,
      `**Projects:** repaint home office (in progress)`,
      `**Maintenance:** furnace filter due`,
      "",
      "## Where things stand",
      `The house came with a ${P.home.hvac.unit} that's near the end of its life. A ${usd(P.home.hvac.replacementQuote)} quote is in hand. The call is replace-now versus wait — and it ripples outward: it's the summer's main capital decision (see wealth) and the kind of thing the homeowner's carrier cares about at the September renewal (see insurance).`,
      "",
      "## Open Items",
      ...crossItems("homestead"),
      "- [ ] Get a second HVAC quote to compare",
      "- [ ] Finish the office repaint this month",
    ].join("\n"),
  },

  travel: {
    title: "Travel",
    soul: "A life rich with people and places — keep the family connected to Lima, and make room for new adventures together.",
    goals: [
      "Take the December Lima trip — metric: `lima_trip_done`, target: yes",
      "Keep travel inside the annual budget — metric: `travel_on_budget`, target: yes",
      "Try one new place a year",
    ],
    config: [
      "## Trips",
      `next: ${P.travel.next.place} (${P.travel.next.when}) — ${P.travel.next.who}, budget ${usd(P.travel.next.budget)}`,
      `planned: ${P.travel.planned.place} (${P.travel.planned.when}) — ${P.travel.planned.who}`,
      "",
      "## Wishlist",
      ...P.travel.wishlist.map((w) => `- ${w}`),
    ].join("\n"),
    state: [
      `**Next trip:** ${P.travel.next.place} — ${P.travel.next.when}`,
      `**Planned:** ${P.travel.planned.place} in ${P.travel.planned.when}`,
      `**Wishlist:** ${P.travel.wishlist.join(", ")}`,
      "",
      "## Where things stand",
      `A Portland long weekend is three weeks out (${usd(P.travel.next.budget)} budget). The big one is December: the annual trip to Lima to see ${hh.familyAbroad.who.split("(")[1]?.replace(")", "") || "family"} — and to ${P.travel.planned.note}. Booking early keeps the holiday fares sane (see calendar), and the trip is already penciled into the wealth budget.`,
      "",
      "## Open Items",
      ...crossItems("travel"),
      "- [ ] Book Lima flights before holiday fares climb",
      "- [ ] Renew Maya's passport ahead of December",
    ].join("\n"),
  },

  calendar: {
    title: "Calendar",
    soul: "Protect time for what counts — the people we love, focused work, and rest. Plan the week, and keep the immovable dates visible early.",
    goals: [
      "Plan the week every Monday — metric: `weekly_plan_done`, target: yes",
      "Protect family evenings — metric: `protected_evenings`, target: 4",
      "No surprise deadlines",
    ],
    config: [
      "## Standing",
      "weekly_plan: Monday morning",
      "family_evenings: protected",
      "",
      "## Key dates",
      `- ${P.tax.foreignReporting.fbar.deadline.split(" ")[0]} — tax / FBAR season`,
      `- ${j.job.rsu.nextVestDate} — RSU vest`,
      "- 2026-09 — homeowner's renewal",
      "- December — Lima trip",
    ].join("\n"),
    state: [
      `**This week:** dentist Thu 2pm · branch district call Fri · ${hh.child.name.split(" ")[0]}'s preschool recital Sat`,
      `**Coming up:** RSU vest ${j.job.rsu.nextVestDate} · auto renewal in 22 days`,
      `**Open evenings:** 4 of 5`,
      "",
      "## Where things stand",
      `A normal week with one immovable: ${hh.child.name.split(" ")[0]}'s recital Saturday. The dates that matter are further out and easy to forget — the RSU vest in August, the September home renewal, and the December Lima trip whose fares climb if booking slips (see travel).`,
      "",
      "## Open Items",
      ...crossItems("calendar"),
      "- [ ] Block focus time around the July review prep",
      "- [ ] Add the FBAR deadline as a reminder",
    ].join("\n"),
  },

  learning: {
    title: "Learning",
    soul: "Keep growing — the credential that opens the next role, and the small daily things, like reading in Spanish with Maya.",
    goals: [
      "Finish the CBM credential — metric: `cbm_done`, target: yes",
      `Read ${P.learning.books.target} books this year — metric: \`books_read\`, target: ${P.learning.books.target}`,
      "Keep up weekend Spanish with Maya",
    ],
    config: [
      "## In progress",
      ...P.learning.inProgress.map((l) => `- ${l}`),
      "",
      "## Reading",
      `books_this_year: ${P.learning.books.readThisYear} of ${P.learning.books.target}`,
      "",
      "## Personal",
      `- ${P.learning.personal}`,
    ].join("\n"),
    state: [
      `**Currently:** CBM coursework`,
      `**Books this year:** ${P.learning.books.readThisYear} of ${P.learning.books.target}`,
      `**At homestead:** ${P.learning.personal}`,
      "",
      "## Where things stand",
      `The CBM credential is the work-relevant one — it's the box to check before the Area Manager conversation (see career), and the coursework is about 60% done. On the lighter side, ${P.learning.books.readThisYear} of ${P.learning.books.target} books, and weekend Spanish reading with ${hh.child.name.split(" ")[0]} that's as much about keeping Lima close as it is about literacy.`,
      "",
      "## Open Items",
      ...crossItems("learning"),
      "- [ ] Finish the last CBM module before the July review",
      "- [ ] Pick the next book (target: 12)",
    ].join("\n"),
  },
};

// ── write the vault ───────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const SUBDIRS = ["data", "_threads", "_log", "_artifacts", "_skills", "_meta"];

for (const key of P.domains) {
  const d = D[key];
  if (!d) { console.warn(`! no content for domain ${key}`); continue; }
  const dir = join(OUT, key);
  mkdirSync(dir, { recursive: true });
  for (const s of SUBDIRS) mkdirSync(join(dir, s), { recursive: true });

  writeFileSync(join(dir, "soul.md"), `# ${d.title}\n\n> Why this domain exists — your north star here.\n\n${d.soul}\n`);
  writeFileSync(join(dir, "goals.md"), `# ${d.title} — Goals\n\n> Objectives and the metric each one is measured by.\n\n${d.goals.map((g) => `- [ ] ${g}`).join("\n")}\n`);
  writeFileSync(join(dir, "config.md"), `# ${d.title} — Config\n\n> Skills read this file to personalize their output.\n\n${d.config}\n`);
  writeFileSync(join(dir, "_state.md"), `${FM}# ${d.title}\n\n**Last updated:** ${P.generatedAt}\n\n${d.state}\n`);
  writeFileSync(join(dir, "_tasks.jsonl"), "");
}

// vault-level profile so the whole thing reads as one person
mkdirSync(join(OUT, "_meta"), { recursive: true });
writeFileSync(
  join(OUT, "_meta", "profile.md"),
  [
    "# Profile",
    "",
    `**${j.name}** — ${j.age}, ${j.job.title} at ${j.job.employer}, ${hh.location.city}, ${hh.location.state}.`,
    `Born in ${j.birthplace}; immigrated ${j.immigratedYear} (age ${j.immigratedAge}), naturalized ${j.naturalizedYear}. Bilingual ${j.languages.join(" / ")}.`,
    `Household: ${hh.partner.name} (${hh.partner.age}, ${hh.partner.job.title}) and ${hh.child.name} (${hh.child.age}).`,
    `Net worth ${usd(133_980)} · filing ${hh.filingStatus} · ${hh.location.state}.`,
    "",
    "_Synthetic demo data — one consistent household across every domain._",
  ].join("\n"),
);

console.log(`✓ wrote ${P.domains.length} domains to ${OUT}`);
