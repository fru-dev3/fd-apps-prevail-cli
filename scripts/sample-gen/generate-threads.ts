#!/usr/bin/env bun
// generate-threads.ts — emit per-domain _threads/ chat history for the demo vault.
//
//   bun run scripts/sample-gen/generate-threads.ts <out-dir>
//
// Writes .jsonl + .md pairs into <out-dir>/<domain>/_threads/.
// Each thread is a realistic multi-turn conversation referencing Jordan Smith's
// exact numbers from persona.ts.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] || join(import.meta.dir, "out-vault");

// ── ID / timestamp helpers ────────────────────────────────────────────────────

// Deterministic IDs: t-demo<3digits>-<domain3><turn>
let idCounter = 0;
function makeId(domain: string, n: number): string {
  return `t-demo${String(++idCounter).padStart(3, "0")}-${domain.slice(0, 3)}${n}`;
}

// Base timestamps — each thread offset by different amounts from June 1 2026
const BASE_TS = 1748736000000; // 2026-06-01 00:00:00 UTC

interface Turn {
  role: "user" | "assistant";
  content: string;
}

interface ThreadDef {
  id: string;   // file slug e.g. "2026-06-08_hvac-decision"
  title: string;
  domain: string;
  created: string;  // ISO
  updated: string;
  turns: Turn[];
}

// ── thread writer ─────────────────────────────────────────────────────────────

function writeThread(t: ThreadDef): void {
  idCounter = 0; // reset per thread

  const dir = join(OUT, t.domain, "_threads");
  const slug = t.id;
  let ts = new Date(t.created).getTime();

  // Build jsonl
  const lines: string[] = [];
  let prevId: string | null = null;
  for (let i = 0; i < t.turns.length; i++) {
    const turn = t.turns[i];
    const id = makeId(t.domain, i);
    lines.push(
      JSON.stringify({
        id,
        parentId: prevId,
        role: turn.role,
        cli: "claude",
        model: "",
        content: turn.content,
        ts,
      }),
    );
    ts += 15_000 + i * 5_000; // stagger by 15-20s per turn
    prevId = id;
  }

  writeFileSync(join(dir, `${slug}.jsonl`), lines.join("\n") + "\n");

  // Build md
  const md = [
    "---",
    `title: ${t.title}`,
    `domain: ${t.domain}`,
    `created: ${t.created}`,
    `updated: ${t.updated}`,
    `turns: ${t.turns.length}`,
    "---",
    "",
    ...t.turns.map((turn) =>
      turn.role === "user"
        ? `## You\n\n${stripAutoHeader(turn.content)}`
        : `## claude · opus-4\n\n${turn.content}`,
    ),
    "",
  ].join("\n\n");

  writeFileSync(join(dir, `${slug}.md`), md);
}

function stripAutoHeader(content: string): string {
  // Remove the "--- auto: Domain/state.md ---\n...\n\n" prefix if present
  const idx = content.indexOf("\n\n");
  if (content.startsWith("---")) return content.slice(idx + 2).trim();
  return content;
}

// ── threads ───────────────────────────────────────────────────────────────────

// WEALTH
writeThread({
  id: "2026-06-08_hvac-capital-decision",
  title: "Can we afford to replace the HVAC this summer?",
  domain: "wealth",
  created: "2026-06-08T14:00:00Z",
  updated: "2026-06-08T14:22:00Z",
  turns: [
    {
      role: "user",
      content:
        "The HVAC at the house is a 2016 Carrier and the tech says it's near end of life. Got a quote for $6,850. Can we replace it this summer without wrecking the rest of the plan?",
    },
    {
      role: "assistant",
      content: `Short answer: yes, and I'd do it now rather than wait.

Here's the picture from your numbers:

- Emergency fund (Ally): **$10,240** — about 3 months of expenses. Paying $6,850 drops you to ~$3,400, which is thin. That's the main tension.
- Monthly savings: **$850/mo** ($650 brokerage auto-invest + $200 to Maya's 529). Pausing the brokerage invest for 10 months refills the fund completely without touching anything else.
- Household income: $168k W2 — the cash flow is there; this is a timing question, not an affordability question.

Two clean ways to fund it:

1. **Pay from the emergency fund + refill over 10 months** by pausing the $650/mo brokerage auto-invest. The 529 keeps running. The fund is back to $10k by April.
2. **Keep the emergency fund intact and use the next two paychecks** — both Jordan and Sam get paid mid-June and end-of-June; combined net is ~$10,760, enough to cover $6,850 and replenish checking.

I'd lean toward option 2 — keeps the emergency fund as a true emergency cushion and uses predictable payroll timing.

What I wouldn't do: raid the Roth IRAs or the 529.`,
    },
    {
      role: "user",
      content: "Why not just wait a year and keep the $6,850 in the emergency fund?",
    },
    {
      role: "assistant",
      content: `The expected value tilts toward replacing now for three reasons:

**1. Peak-summer failure risk is real.** It's a 10-year-old unit already flagged near end of life, in Austin, TX. A July or August failure means emergency replacement pricing (often 20–30% premium) and days without cooling with Maya at home. That scenario costs more and happens at the worst time.

**2. There's a cross-domain reason.** Your Texas Farm Bureau homeowner's policy renews in September. The HVAC age (2016) and its condition are exactly what carriers ask about at renewal. Replacing the unit before that renewal removes a red flag and may actually help rather than hurt the premium.

**3. The opportunity cost is small.** $6,850 in the emergency fund earns ~$280 in a year at 4.1% APY. That's the "upside" of waiting. It doesn't move the needle against the downside scenarios above.

Verdict: replace before July. Finance it with option 2 (use the June paychecks). Get a second quote first — $6,850 is reasonable but worth confirming.`,
    },
  ],
});

writeThread({
  id: "2026-06-05_rsu-vest-august",
  title: "RSU vest in August — what do I do with $6,180?",
  domain: "wealth",
  created: "2026-06-05T09:30:00Z",
  updated: "2026-06-05T09:48:00Z",
  turns: [
    {
      role: "user",
      content: "The next RSU vest is August 15 — 120 shares, ~$6,180 gross. What should I do with it after taxes?",
    },
    {
      role: "assistant",
      content: `At the 22% supplemental withholding rate, you'd net roughly **$4,820** after federal withholding. (Texas has no state income tax, which helps.)

Here's how I'd think about it in priority order:

**1. Emergency fund first (if HVAC happened).** If you used June paychecks for the HVAC, the emergency fund stayed intact. If instead you dipped into the Ally account, use part of the RSU proceeds to top it back toward $10,240.

**2. Earmark the RSU shares themselves** — sell on vest day, don't hold. You already have $168k of income tied to Frontera Bank. Holding the RSU shares adds concentration risk: your paycheck *and* your equity would decline together if the bank has a bad year. Sell and diversify.

**3. Where the ~$4,820 goes:**
   - If emergency fund is whole: put $3,000 into the taxable brokerage (VTI/BND per your current allocation), $1,820 to the Ally HYSA to pad the emergency fund to a fuller 4-month cushion.
   - If any HVAC reimbursement still pending: prioritize refilling the emergency fund to $10,240 first, then invest the remainder.

**One tax note:** the 22% supplemental withholding is a flat rate and often under-withholds relative to your actual marginal rate (likely 22–24%). Worth running the numbers in November to see if a Q4 estimated payment is needed.`,
    },
    {
      role: "user",
      content: "Should I put the brokerage money into the same VTI/BND split I already have?",
    },
    {
      role: "assistant",
      content: `Yes, same split makes sense — VTI 80% / BND 20% keeps you on track toward the 75/20/5 target allocation.

One small nudge: your current allocation is 80% equities / 13% bonds / 7% cash. You're slightly over-weight equities and slightly under-weight bonds. Routing new brokerage contributions toward BND (or its equivalent, BNDX if you want international bond exposure) is the low-friction way to drift back toward target without selling anything.

So for the ~$3,000 RSU brokerage allocation: **$900 into BND, $2,100 into VTI** (70/30 split for this tranche) would gently pull the overall toward 75/20 without rebalancing.

Don't overthink it — at your current net worth ($133,980), the allocation drift matters less than keeping the savings habit. The important thing is that the RSU gets reinvested rather than spent.`,
    },
  ],
});

// CAREER
writeThread({
  id: "2026-06-07_july-review-prep",
  title: "How do I prepare for the mid-year review?",
  domain: "career",
  created: "2026-06-07T11:00:00Z",
  updated: "2026-06-07T11:25:00Z",
  turns: [
    {
      role: "user",
      content:
        "My mid-year review is July 11. I want the comp conversation to go well and I want my district manager to start thinking of me for the Area Manager role. How do I set that up?",
    },
    {
      role: "assistant",
      content: `You have five weeks. Here's what I'd prepare:

**Lead with deposit growth numbers.** That's the metric your district manager runs on. Pull your branch's YTD deposit growth vs. the same period last year and vs. district average. If you're above average — and you should know this number cold — that's your opening. If you're not, frame what changed and what you've done about it.

**Make the Area Manager intention explicit.** Don't hint at it. "I'm targeting the Area Manager role and I want to understand what the path looks like from your perspective." District managers respect directness, and ambiguity about your ambition doesn't serve you. The CBM credential (you're 62% through) gives you concrete evidence you're investing in that trajectory.

**Bring one cross-branch insight.** Area Managers think across branches, not just within one. Come with an observation about a pattern you've noticed: customer segment, service issue, or staffing approach that you've solved at your branch and think could help the district. It signals you're already thinking at the next level.

**On comp:** You moved from $88k to $90k last year. A 5–7% ask ($94.5–$96.3k) is reasonable for a two-year Senior Branch Manager with your metrics. Anchor to the CBM completion and deposit growth. Do not bring it up before the performance piece — earn the number first, then name it.

One logistics thing: request 45 minutes, not 30. More time lets the comp conversation breathe without feeling rushed.`,
    },
    {
      role: "user",
      content: "What if my deposit growth numbers aren't as strong as I'd like?",
    },
    {
      role: "assistant",
      content: `Then you own it briefly and pivot to what you did about it — that's what district managers want to see from someone angling for Area Manager.

The structure: *"Q1 deposit growth was X, which was below my target. Here's what I identified as the driver [short diagnosis], and here's what I changed in Q2 [your action]. Here's where we are now."*

A few things that work in your favor regardless of the numbers:

- **Bilingual capacity is a real differentiator.** If your branch serves a significant Spanish-speaking customer segment, quantify it. Retention rate, NPS, account-opening source data if you have it. This is a genuine edge that not every branch manager in the district has.

- **Team development.** Who have you promoted or developed? Area Managers are evaluated in part by the talent pipeline they build. If you've fast-tracked anyone to personal banker or supervisor, that's a data point.

- **The CBM.** It shows the district manager you're not waiting to be handed the next role — you're preparing for it on your own time and partially your own dime. Most branch managers at your level don't have it yet.

Weak deposit numbers are a one-quarter story. Leadership capacity and bilingual customer retention are a multi-year structural edge. Lead with the latter if the former is soft.`,
    },
  ],
});

writeThread({
  id: "2026-06-09_cbm-study-plan",
  title: "6 weeks to the CBM exam — what's the plan?",
  domain: "career",
  created: "2026-06-09T07:00:00Z",
  updated: "2026-06-09T07:18:00Z",
  turns: [
    {
      role: "user",
      content:
        "I'm 62% through the CBM coursework. The exam window opens in October and I want to sit for it in November. Six weeks to finish the material. What's a realistic plan?",
    },
    {
      role: "assistant",
      content: `You're further along than you think — 62% done means roughly 38% of the coursework remaining. If the CBM is structured like most ABA programs (typically 5–6 modules), you have about 2 modules left.

A 6-week plan assuming 2 sessions per week (weeknight evenings, 90 min each):

**Weeks 1–2:** Complete the next module. Use the ABA study guides, don't just read — answer the practice questions at the end of each section. Flag anything you got wrong.

**Weeks 3–4:** Complete the final module. Same approach.

**Week 5:** Full practice exam under timed conditions. ABA typically provides a practice test. Score it, identify your weak areas.

**Week 6:** Targeted review of weak areas only. The goal is not to re-read everything — it's to fix the specific gaps the practice test found.

Schedule the exam registration now (October window) so there's a date on the calendar. The accountability of a paid exam date does more than any study plan.

One scheduling note: your July 11 review and the Portland trip (July 1–4) are both in the next few weeks. Don't let those compress your Week 1–2 study time — front-load a bit before the Portland weekend if you can.`,
    },
  ],
});

// TAX
writeThread({
  id: "2026-06-06_fbar-walkthrough",
  title: "What do I actually need to file for the FBAR?",
  domain: "tax",
  created: "2026-06-06T20:00:00Z",
  updated: "2026-06-06T20:28:00Z",
  turns: [
    {
      role: "user",
      content:
        "Walk me through the FBAR. I have a savings account at BCP in Peru with about $11,000. What do I need to do and when?",
    },
    {
      role: "assistant",
      content: `The FBAR (FinCEN 114) is a disclosure form — not a tax — that US persons must file when they hold foreign financial accounts with an **aggregate balance exceeding $10,000 at any point during the calendar year**. Your BCP account at $11,000 clears that threshold, so you're required to file.

**What to do:**

1. **File FinCEN 114 at fincen.gov** (the BSA e-filing system). It's free and separate from your tax return — don't attach it to your 1040.

2. **What you report:** For each foreign account — the institution name (Banco de Crédito del Perú), country (Peru), account type (savings), last four digits of the account number, and the maximum value during the year in USD.

3. **Converting to USD:** Use the Treasury's official exchange rate for December 31 of the tax year (or the highest balance in the year if you want to be conservative). The BCP account is denominated in Peruvian soles (PEN); the USD equivalent is what you report.

**Deadlines:**
- Primary deadline: **April 15** (same as the federal return)
- Automatic extension: **October 15** — no form needed to claim the extension, it's automatic

**Interest income:** The interest the BCP account earns is also reportable on your US 1040 as foreign interest income (Schedule B). Based on the $11k balance you're probably earning a few hundred dollars a year — it's a small number but it must be reported.

**The inherited property (Lima family home):** A 1/3 share of a foreign property with no rental income generally does not trigger FBAR or Form 8938 at your net worth level. Worth confirming with a CPA once, but it's a passive hold.

Is there anything you're uncertain about — the account number, the PEN/USD conversion, or the online filing process?`,
    },
    {
      role: "user",
      content: "The interest I earn in the BCP account — I get a statement from them in Spanish. Is that enough documentation?",
    },
    {
      role: "assistant",
      content: `Yes, a BCP account statement is exactly what you need, even in Spanish.

Keep the original statement as your record. For the 1040 (Schedule B), you report the USD equivalent of the interest earned. You can translate it yourself — the exchange rate to use is the Treasury's year-end rate for December 31, or the spot rate on each interest posting date (either is acceptable; most people use the year-end rate for simplicity).

A few practical tips for your records:
- Download the PDF statement from BCP's online banking and save it to the tax domain in your vault. The IRS statute of limitations for unreported foreign income is 6 years (vs. 3 for domestic-only returns), so keep these indefinitely.
- Note the account's maximum balance during the year in USD for FBAR purposes — often this is just the year-end balance if the account is stable.
- If BCP issues a year-end "certificado de intereses" (interest certificate), grab that too — it's the cleanest documentation.

If you haven't worked with a CPA on the FBAR before, it might be worth a one-time consult in year one to make sure the workflow is set up correctly. The filing itself is straightforward once you've done it once.`,
    },
  ],
});

// HEALTH
writeThread({
  id: "2026-06-05_ldl-result",
  title: "LDL came back at 138 — what does this mean at 29?",
  domain: "health",
  created: "2026-06-05T18:00:00Z",
  updated: "2026-06-05T18:20:00Z",
  turns: [
    {
      role: "user",
      content:
        "Got my lab results back from the May physical. LDL is 138 mg/dL and vitamin D is 24 ng/mL. The doctor said watch it but didn't seem alarmed. Should I be worried?",
    },
    {
      role: "assistant",
      content: `Dr. Marquez is right not to be alarmed — but these are worth taking seriously as early signals rather than ignoring them.

**LDL at 138 mg/dL:**
The clinical categories are:
- Optimal: <100
- Near-optimal: 100–129
- Borderline high: 130–159 ← *you're here*
- High: 160–189

At 29 with no other cardiovascular risk factors — your BP is normal (118/76), glucose is normal, you're not a smoker, you're active — an LDL of 138 is unlikely to prompt medication. The standard first-line intervention is lifestyle: diet and exercise.

The two levers that move LDL most:
1. **Saturated fat reduction** — limit red meat, full-fat dairy, tropical oils. The effect on LDL is well-documented and measurable in 8–12 weeks.
2. **Aerobic exercise** — specifically zone-2 cardio, which you're already doing. This also raises HDL (yours is 52 — solid). Keep building the zone-2 volume.

The good news is you're catching this at 29, not 49. Early intervention — a modest dietary shift + consistent cardio — can move this number significantly before your next check.

**Vitamin D at 24 ng/mL:**
Low (reference range 30–100). Most labs flag below 30 as insufficient. Symptoms can be subtle: fatigue, slower recovery, mood. The fix is easy — 2,000 IU vitamin D3 daily is the standard starting dose. Re-test in 3 months. Get sun when you can (Austin helps here).

**Timeline:** Dr. Marquez wants to recheck in 3 months. Mark it — that's late August / September.`,
    },
    {
      role: "user",
      content: "Is there something about my background that makes the cholesterol more worth watching?",
    },
    {
      role: "assistant",
      content: `Good question, and worth knowing. There's a modest but real cardiovascular risk elevation in Latin American populations — it's not a dramatic difference, but it's one reason to treat a borderline-high LDL in your 20s as a genuine early signal rather than a number to revisit at 40.

A few things that apply to your situation:

**Family history matters a lot here.** If Rosa or Miguel has a history of early heart disease, high cholesterol, or a heart attack before age 55 (father) or 65 (mother), that changes the picture meaningfully — it would move you from "watch and lifestyle" territory toward "talk to a cardiologist sooner." Worth asking them on the Lima trip if you don't already know.

**Diet context:** Traditional Peruvian cooking isn't inherently high in saturated fat — the concern is more about what the US lifestyle layers on top (fast food, processed food). Leaning back toward more traditional cooking patterns (lots of fish, legumes, vegetables, lighter on dairy) is actually a cardiovascular positive, not just a cultural comfort.

**The fitness side:** You're in a genuinely good position here. Resting HR of 58 at 29 means your cardiovascular baseline is strong. The zone-2 running and bouldering you're doing are the right interventions — this is not a "you need to fundamentally change" situation. It's a "the number is a nudge to stay on this path and clean up the diet a bit."

Bottom line: flag the family history question before the August re-check. Everything else — lifestyle, activity, no major risk factors — is working in your favor.`,
    },
  ],
});

// FITNESS
writeThread({
  id: "2026-06-04_half-marathon-plan",
  title: "Build me a training plan for the November half-marathon",
  domain: "fitness",
  created: "2026-06-04T07:00:00Z",
  updated: "2026-06-04T07:20:00Z",
  turns: [
    {
      role: "user",
      content:
        "I want to run the Austin Half Marathon in November. I'm currently doing 3 sessions a week — 2 strength days and 1 zone-2 run, about 7–8 km. Where do I start?",
    },
    {
      role: "assistant",
      content: `You have about 23 weeks until November — that's plenty of time, and your current 7–8 km zone-2 run is a solid base to build from.

Here's the framework I'd use:

**Phase 1 — Build the aerobic base (Weeks 1–8, now through end of July)**
- Add a second weekly run: a shorter easy effort (4–5 km) on a different day. This is the 4th session you're aiming for.
- Keep the long run at zone 2 (conversational pace). Increase distance by ~10% per week.
- Week 8 target long run: ~12 km
- Strength stays at 2x/week — it protects you against injury

**Phase 2 — Half-specific work (Weeks 9–16, August through September)**
- Long run progresses to 16–18 km (you don't need to run 21k in training — 16–18k is enough)
- Add one tempo or progression run per week (zone 3–4): shorter, faster, 5–6 km
- 4 sessions/week: long run, tempo, strength x2
- Bouldering as an optional 5th session — good for active recovery

**Phase 3 — Taper (Weeks 17–23, October to race day)**
- Peak mileage week in early October, then taper
- Reduce volume by ~30% in the last 3 weeks
- Race week: short shakeout runs only, fresh legs on race day

**Goal time:** At your current fitness (7–8 km zone-2, resting HR 58), a realistic goal for a first half is **2:15–2:25**. If the training goes well, sub-2:10 is achievable.

One thing to do this week: register for the race. Having a bib number and a start time anchors everything else.`,
    },
  ],
});

// INSURANCE
writeThread({
  id: "2026-06-08_umbrella-policy",
  title: "Should I add the umbrella policy before the auto renewal?",
  domain: "insurance",
  created: "2026-06-08T16:00:00Z",
  updated: "2026-06-08T16:15:00Z",
  turns: [
    {
      role: "user",
      content:
        "The Geico auto renewal is in 22 days. I keep hearing I should add a $1M umbrella policy. Is now the time to do it? And does it interact with the HVAC situation?",
    },
    {
      role: "assistant",
      content: `Yes — add the umbrella, and do it at the auto renewal. The timing is actually ideal.

**Why now:**
Umbrella policies work by sitting on top of your existing auto and homeowner's policies. Most carriers require the underlying policies to be at certain minimum liability limits (usually $300k auto, $300k home) before they'll issue an umbrella. Your Geico auto renewal is the moment your carrier may want to adjust those underlying limits to qualify — doing it at renewal is cleaner than mid-term.

**The cost:** A $1M personal liability umbrella typically runs **$150–$200/year** for your profile (Austin TX, homeowner, two vehicles, no claims history). That's roughly $13–17/month. At your net worth and with a house, this is one of the highest-leverage insurance buys you can make — the premium is tiny relative to what it protects.

**What it covers that your current policies don't:** A serious auto accident where you're at fault, a guest injured at the house, defamation, certain lawsuits. Your $322k home and $35k+ in investment accounts are now worth protecting. At $168k household income, a judgment against you without umbrella coverage could reach wages as well.

**The HVAC interaction:** The two are separate — the HVAC replacement doesn't affect the umbrella decision at all. The umbrella interacts with the homeowner's renewal in September (Texas Farm Bureau will see the umbrella and it typically signals a more thorough risk profile). That's a mild positive, not a negative.

**Action:** When Geico sends the renewal, call them (or their umbrella partner) and ask for a $1M umbrella quote bundled with the auto renewal. If they don't offer umbrella, check with Texas Farm Bureau (your home carrier) — many home carriers bundle it.`,
    },
  ],
});

// HOME
writeThread({
  id: "2026-06-06_hvac-decision",
  title: "Replace the HVAC now or wait?",
  domain: "homestead",
  created: "2026-06-06T19:00:00Z",
  updated: "2026-06-06T19:22:00Z",
  turns: [
    {
      role: "user",
      content:
        "Aire Serv came out and said the 2016 Carrier is near end of life. They quoted $6,850 for a full replacement. Should I replace it now or wait and see if it makes it through the summer?",
    },
    {
      role: "assistant",
      content: `Replace it now, before July. Here's the reasoning:

**The risk of waiting is asymmetric.** A 2016 unit in Austin, TX, running through peak July/August heat (100°F+ days, often 40+ days above 95°F per summer) is likely to fail under maximum load — exactly when you need it most, and exactly when every HVAC contractor in the city is booked out 2 weeks. Emergency replacements in peak summer cost a 20–30% premium on top of the quote you have.

**$6,850 is a fair quote for a full Carrier system in Austin** (ranges run $5,500–$9,000 depending on tonnage and SEER rating). Get one more quote — not to nickel-and-dime, but to confirm the recommendation (replace vs. repair) and spec (tonnage, SEER). A 14-SEER unit is the minimum code; a 16-SEER costs $500–800 more but will lower your electricity bill year-round. Given Austin Energy's summer rates, the payback on the higher-SEER unit is roughly 4–5 years.

**What to ask the second contractor:**
- Is repair (capacitor, compressor) a realistic option for a 10-year-old unit, or does the tech recommend replacement?
- What tonnage and SEER rating are they speccing?
- Is the existing ductwork in good condition or will it need resealing?

Once you have two quotes, you'll have confidence in the number and the recommendation. At that point, the wealth question (how to fund it — see that thread) is already settled: June paychecks cover it.

**One more thing:** The Texas Farm Bureau homeowner's renewal is September. Replacing the unit before then means your HVAC age on the renewal form is 0 years, not 10. That's a clean data point for the underwriter.`,
    },
    {
      role: "user",
      content: "What SEER rating should I ask for?",
    },
    {
      role: "assistant",
      content: `For Austin, TX, I'd spec a **16 SEER2** (the newer SEER2 standard replaced SEER in 2023 — the rating looks slightly lower but the testing is more rigorous; a 16 SEER2 ≈ 18.5 old SEER).

Here's the quick math on why it's worth the upgrade:

- Austin Energy average summer electricity cost: roughly $0.12–0.14/kWh
- A 14 SEER2 vs 16 SEER2 on a 3-ton system (typical for a ~1,500 sq ft house): ~12–15% efficiency difference
- Typical Austin HVAC run time in summer: 8–10 hours/day for 4 months
- Annual savings estimate: **$140–200/year**
- Payback on the ~$700 upgrade: **3.5–5 years**

Given that you're planning to stay in this house (starter home, bought 2024), a 15–20 year HVAC lifespan means the 16 SEER2 easily pays for itself twice over.

If either contractor quotes a 14 SEER2 as standard, just ask "what's the upgrade cost to 16 SEER2?" — it's a straightforward question and they'll know exactly what you're asking.`,
    },
  ],
});

// TRAVEL
writeThread({
  id: "2026-06-07_portland-trip-plan",
  title: "Plan the Portland trip — $1,800 budget, 3 days",
  domain: "travel",
  created: "2026-06-07T20:00:00Z",
  updated: "2026-06-07T20:18:00Z",
  turns: [
    {
      role: "user",
      content:
        "We're planning a Portland, OR long weekend starting July 1 — Jordan, Sam, and Maya (3). Budget is $1,800 for the whole trip. Help me plan it.",
    },
    {
      role: "assistant",
      content: `Portland is a great pick for a family long weekend — Maya-friendly, compact, and a genuine change of pace from Austin. Here's how I'd structure the $1,800:

**Budget breakdown:**
| Category | Est. Cost |
|---|---|
| Flights (3 pax, AUS→PDX round trip) | $680–780 |
| Lodging (3 nights, family-friendly) | $480–540 |
| Food (3 days, mix of dining + grocery) | $280–320 |
| Activities + transit | $120–160 |
| Buffer | $100–120 |
| **Total** | **$1,660–1,940** |

You're tight but workable at $1,800 — book flights before they drift.

**Where to stay:** Look for a short-term rental (Airbnb/VRBO) with a kitchen rather than a hotel. A 1BR or studio in the Alberta Arts District or Hawthorne runs $150–170/night and gives you a kitchen for breakfast and snacks (significant savings with a 3-year-old). Hotels near the Pearl District are nicer but push $200+/night.

**What to do with Maya:**
- **Oregon Zoo** — outstanding, Maya will love the elephants; ~$25 adult / free under 3 or $14 for ages 3–5
- **Powell's Books** — free to browse; the kids section is magical and she can pick one book
- **Lan Su Chinese Garden** — surprisingly peaceful, small enough for a toddler
- **Portland Saturday Market** (if you catch the July 4th weekend version) — food, crafts, alive

**Logistics:** July 4th weekend means some crowds and possible fireworks logistics. If Maya does well with fireworks, great. If not, plan to be at the rental by 9pm on July 4th.

Do you want me to flag the flights in the calendar?`,
    },
  ],
});

writeThread({
  id: "2026-06-09_lima-trip-planning",
  title: "Book the Lima flights before holiday prices go up",
  domain: "travel",
  created: "2026-06-09T21:00:00Z",
  updated: "2026-06-09T21:15:00Z",
  turns: [
    {
      role: "user",
      content:
        "We want to go to Lima for the holidays — December 20 to January 3. That's Jordan, Sam, and Maya. What should I be doing now to not get burned on flights?",
    },
    {
      role: "assistant",
      content: `Book the flights now — seriously, don't wait another 2–3 weeks.

**Why the urgency:** Austin–Lima (AUS → LIM) for the December 20–January 3 window is a high-demand international route. Lima is a hub for South American holiday travel, and fares for this period typically peak 3–4 months in advance (August–September for December travel). You're in the last window where you can still get reasonable fares.

**What to expect:**
- **Direct or 1-stop via Miami/Houston/Bogotá** — LATAM, American, and United are the main carriers from AUS. A 1-stop via Lima's hub through Miami (about 8–9 hours total travel) is the most common.
- **Price range:** For 3 passengers (Austin to Lima, December 20 return January 3), expect $1,400–1,900 total if you book this week, vs. $2,200–2,800 if you wait until August.
- **Maya's fare:** At 3, she needs her own seat on an international flight — no lap child for flights over 12 hours. Factor that in.

**Document check (important):**
- Maya's US passport — check the expiration date right now. International travel generally requires 6 months of validity beyond return date; for Peru that means valid through at least July 2027.
- If Maya's passport is expiring soon, US passport renewal for a minor takes 6–8 weeks standard, 3–5 weeks expedited. Don't let this slip.
- Jordan's Peruvian connections shouldn't affect entry — naturalized citizens can enter Peru on either passport; just be consistent about which you use for entry/exit.

Check Google Flights tonight with flexible dates around Dec 19–22. Lock it in this week.`,
    },
  ],
});

// CALENDAR
writeThread({
  id: "2026-06-08_90-day-calendar",
  title: "What's most important to get on the calendar for the next 90 days?",
  domain: "calendar",
  created: "2026-06-08T08:00:00Z",
  updated: "2026-06-08T08:20:00Z",
  turns: [
    {
      role: "user",
      content: "Give me the most important dates and deadlines I should have on the calendar for the next 90 days.",
    },
    {
      role: "assistant",
      content: `Here's what I see as non-negotiable from your state right now, ordered by date:

**This week (June 8–14):**
- **June 12 (Sat)** — Maya's preschool recital. Immovable.
- **June 13 (Fri)** — District call and dentist same day.
- **ASAP this week** — Book Portland flights (July 1–4 is 3 weeks out; fares are moving).

**June 22–30:**
- **Geico auto renewal preparation** — The renewal date is July 2 (22 days from today). Before then: decide on the umbrella policy, call Geico or Texas Farm Bureau to add it at renewal. Calendar a reminder for June 25 to make the call.

**July:**
- **July 1–4** — Portland trip (once booked)
- **July 11** — Mid-year review with district manager. Start prep this week; don't leave it to July 9.
- **July 18** — Frontera Bank district meeting in San Francisco (company travel)
- **End of July** — HVAC installation should be done before peak August heat if you decide to proceed

**August:**
- **August 15** — RSU vest (120 shares, ~$6,180 gross). Calendar a task one week before to prepare the sell order and earmark the net proceeds.

**September:**
- **September 1** — Texas Farm Bureau homeowner's renewal. Calendar a 30-day prep reminder for August 1: review coverage, flag the new HVAC, and ask about umbrella bundling.

**October–November:**
- **October 15** — FBAR auto-extension deadline. File FinCEN 114 at fincen.gov before this date.
- **November 15** — Austin Half Marathon. Training plan should be locked in by July.

Do you want me to help block specific prep time for the July review?`,
    },
  ],
});

// LEARNING
writeThread({
  id: "2026-06-09_reading-rhythm",
  title: "I'm behind on my reading goal — how do I catch up?",
  domain: "learning",
  created: "2026-06-09T22:00:00Z",
  updated: "2026-06-09T22:12:00Z",
  turns: [
    {
      role: "user",
      content:
        "I've read 5 books this year and my goal is 12. We're in June — should I be worried? And what should I read next?",
    },
    {
      role: "assistant",
      content: `You're at 5 books through roughly half the year, so you're running at a pace of about 10/year. The gap to 12 is real but small — 7 more books in 6 months is 1.2/month, which is achievable with a slight rhythm change.

**The honest assessment:** You don't need to "catch up" — you need a reliable 30-minute reading slot. The culprit is usually a late-evening habit that gives way to screens. Swapping 20–30 minutes of that for reading before bed closes the gap naturally.

**What to read next (given your profile):**

*For the July review / career:* You're already reading *Never Split the Difference* (Voss) — finish that first. It's directly applicable to the comp conversation.

*After that, for the year:*
- **Range** (David Epstein) — your district manager recommended it; reading what leadership recommends is always useful before an Area Manager conversation.
- **The First 90 Days** (Watkins) — prep for the step up to Area Manager, ahead of time.
- One fiction book for the plane to Portland or Lima — reading in Spanish with Maya is paying dividends; a Spanish-language novel is an option if you want a stretch.

At your pace, finishing the 12 by December is realistic with nothing heroic. Don't let the gap create anxiety that makes reading feel like homework — that's the fastest way to stop.`,
    },
  ],
});

// CHIEF
writeThread({
  id: "2026-06-09_weekly-brief",
  title: "Give me my weekly life brief",
  domain: "chief",
  created: "2026-06-09T09:00:00Z",
  updated: "2026-06-09T09:25:00Z",
  turns: [
    {
      role: "user",
      content:
        "Quick weekly brief — what are the things across my life that I need to have in front of me right now?",
    },
    {
      role: "assistant",
      content: `**Weekly brief — week of June 9, 2026**

**This week's single focus:** Decide the HVAC — get the second quote, then call it. The longer it waits, the closer you get to July peak heat.

---

**Urgent (this week):**
- [ ] **HVAC:** Get second quote from a second contractor; compare with Aire Serv's $6,850. Decide and schedule.
- [ ] **Portland flights:** Book before prices move — July 1–4, 3 passengers.
- [ ] **Insurance:** Umbrella policy — call Geico or Texas Farm Bureau before the July 2 auto renewal.
- [ ] **Maya's passport:** Check expiration date before booking Lima flights (December 20).

**Coming up this month:**
- June 12 — Maya's preschool recital (immovable)
- June 13 — dentist + district call
- July 2 — Geico auto renewal
- July 11 — mid-year review (start prep this week)

**On track:**
- Fitness: 3–4 sessions/week, training toward November half-marathon ✓
- Savings rate: 18.2% this month ✓
- CBM: 62% complete — on pace for October exam window ✓
- Remittances: $400 sent to Lima last week ✓

**Watching:**
- LDL recheck in August (Dr. Marquez). Vitamin D supplement — are you taking it?
- RSU vest August 15 — earmark plan ready but no action needed until closer.
- FBAR (FinCEN 114) — gather BCP statement when it arrives; deadline October 15.

**This week's one ask from Sam and Jordan:** Decide the HVAC together tonight or tomorrow. It's the only thing blocking three other plans (wealth, home, insurance).`,
    },
    {
      role: "user",
      content: "Sam just confirmed she got the PT promotion. Salary goes to $82k in July. How does that change the picture?",
    },
    {
      role: "assistant",
      content: `That's a meaningful move — congratulations to Sam.

$82k (up from $78k) adds **$4,000/year gross** to the household, or roughly **$300/month net** after taxes. Texas has no state income tax, so the full federal bite at the marginal rate (probably 22%) leaves about $260/month extra starting July.

How it changes the picture:

**Emergency fund:** If you proceed with the HVAC from June paychecks, the extra $260/month from July means the fund rebuilds faster. You can accelerate the return to $10,240 by about 2 months vs. the original estimate.

**Long-term:** The household W2 income goes from $168k to $172k. That's a small shift in your overall financial trajectory but worth noting: at $172k MFJ you're still firmly in the 22% bracket (22% bracket tops at $201,050 MFJ for 2026). No bracket creep to worry about.

**One thing to double-check:** If Sam's employer plan (Austin Physical Therapy) adjusts benefits at the promotion, confirm the term life ($350k Haven) and 403b contribution rate are still correct. Sometimes a pay change triggers a benefits review window.

Good week. HVAC, Portland, umbrella — those are still the three moves to close before the month ends.`,
    },
  ],
});

console.log(`✓ wrote threads to ${OUT}`);
