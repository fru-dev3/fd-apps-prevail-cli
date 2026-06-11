#!/usr/bin/env bun
// generate-data.ts — emit per-domain data/ files for the Jordan Smith demo vault.
//
//   bun run scripts/sample-gen/generate-data.ts <out-dir>
//
// Writes CSV, JSON into <out-dir>/<domain>/data/.
// Run AFTER generate.ts (which creates the directory scaffolding).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PERSONA as P } from "./persona.ts";

const OUT = process.argv[2] || join(import.meta.dir, "out-vault");

function csv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (c.includes(",") ? `"${c}"` : c)).join(",")).join("\n") + "\n";
}

// ── wealth ────────────────────────────────────────────────────────────────────

const W = P.wealth;
const A = W.accounts;
const j = P.household.primary;

writeFileSync(
  join(OUT, "wealth", "data", "holdings.csv"),
  csv([
    ["account", "asset", "ticker", "allocation_pct", "value_usd"],
    // Jordan 401k — Fidelity
    ["Jordan 401k", "Fidelity 500 Index", "FXAIX", "55", "12265"],
    ["Jordan 401k", "Fidelity Total Intl Index", "FTIHX", "20", "4460"],
    ["Jordan 401k", "Fidelity US Bond Index", "FXNAX", "15", "3345"],
    ["Jordan 401k", "Fidelity Mid Cap Index", "FSMDX", "10", "2230"],
    // Sam 403b — Vanguard (Austin PT uses Vanguard plan)
    ["Sam 403b", "Vanguard Target 2055", "VFFVX", "100", "13100"],
    // Jordan Roth IRA
    ["Jordan Roth IRA", "Total Stock Market ETF", "VTI", "70", "6888"],
    ["Jordan Roth IRA", "Total Intl Stock ETF", "VXUS", "30", "2952"],
    // Sam Roth IRA
    ["Sam Roth IRA", "Total Stock Market ETF", "VTI", "70", "4494"],
    ["Sam Roth IRA", "Total Intl Stock ETF", "VXUS", "30", "1926"],
    // Taxable brokerage
    ["Taxable Brokerage", "Total Stock Market ETF", "VTI", "80", "4944"],
    ["Taxable Brokerage", "US Bond ETF", "BND", "20", "1236"],
    // HSA
    ["HSA", "Fidelity 500 Index", "FXAIX", "100", "2460"],
    // 529
    ["Maya 529", "Vanguard Target 2041 (age-based)", "VTTSX", "100", "4120"],
    // Cash accounts (not invested)
    ["Frontera Bank Checking", "Cash", "", "100", "4820"],
    ["Ally HYSA", "Cash", "", "100", "10240"],
    ["BCP Peru Savings", "Cash (USD equivalent)", "", "100", "11000"],
  ]),
);

writeFileSync(
  join(OUT, "wealth", "data", "transactions.csv"),
  csv([
    ["date", "description", "category", "amount_usd"],
    // June 2026
    ["2026-06-10", "Frontera Bank payroll (Jordan net)", "income", "5820.00"],
    ["2026-06-10", "Austin Physical Therapy payroll (Sam net)", "income", "4940.00"],
    ["2026-06-01", "Rocket Mortgage PITI", "housing", "-2410.00"],
    ["2026-06-05", "Honda CR-V loan payment", "auto", "-322.00"],
    ["2026-06-04", "H-E-B groceries", "food", "-186.50"],
    ["2026-06-07", "Haven Life term premiums (both)", "insurance", "-55.00"],
    ["2026-06-08", "PaySend remittance — Rosa & Miguel", "family", "-400.00"],
    ["2026-06-09", "Whole Foods", "food", "-74.20"],
    ["2026-06-09", "Maya preschool tuition", "childcare", "-820.00"],
    ["2026-06-02", "Austin Energy + water", "utilities", "-178.00"],
    ["2026-06-03", "Fidelity auto-invest (brokerage)", "investment", "-650.00"],
    ["2026-06-03", "Vanguard 529 auto-invest (Maya)", "investment", "-200.00"],
    ["2026-06-05", "Netflix + Spotify", "subscriptions", "-28.00"],
    ["2026-06-06", "Austin Bouldering Project (Jordan)", "fitness", "-38.00"],
    // May 2026
    ["2026-05-25", "Frontera Bank payroll (Jordan net)", "income", "5820.00"],
    ["2026-05-25", "Austin Physical Therapy payroll (Sam net)", "income", "4940.00"],
    ["2026-05-01", "Rocket Mortgage PITI", "housing", "-2410.00"],
    ["2026-05-05", "Honda CR-V loan payment", "auto", "-322.00"],
    ["2026-05-08", "PaySend remittance — Rosa & Miguel", "family", "-400.00"],
    ["2026-05-10", "H-E-B groceries", "food", "-194.80"],
    ["2026-05-12", "Target (household)", "household", "-112.40"],
    ["2026-05-15", "Jordan annual physical — Dr. Marquez", "health", "-30.00"],
    ["2026-05-18", "REI (running gear for half-marathon training)", "fitness", "-89.00"],
    ["2026-05-20", "Geico auto insurance (semi-annual)", "insurance", "-1140.00"],
    ["2026-05-01", "Fidelity auto-invest (brokerage)", "investment", "-650.00"],
    ["2026-05-01", "Vanguard 529 auto-invest (Maya)", "investment", "-200.00"],
    ["2026-05-22", "Dining out (date night)", "food", "-87.00"],
    ["2026-05-28", "Austin Energy + water", "utilities", "-185.00"],
  ]),
);

// Net worth history — Jordan's household, building from ~2025-01
const nwBase = 133_980;
const monthly = [
  { m: "2025-01", net_worth: 96_200 },
  { m: "2025-02", net_worth: 98_400 },
  { m: "2025-03", net_worth: 100_100 },
  { m: "2025-04", net_worth: 101_800 },
  { m: "2025-05", net_worth: 104_300 },
  { m: "2025-06", net_worth: 106_500 },
  { m: "2025-07", net_worth: 108_900 },
  { m: "2025-08", net_worth: 111_400 },
  { m: "2025-09", net_worth: 113_200 },
  { m: "2025-10", net_worth: 115_800 },
  { m: "2025-11", net_worth: 118_500 },
  { m: "2025-12", net_worth: 121_000 },
  { m: "2026-01", net_worth: 123_600 },
  { m: "2026-02", net_worth: 126_100 },
  { m: "2026-03", net_worth: 128_400 },
  { m: "2026-04", net_worth: 130_200 },
  { m: "2026-05", net_worth: 132_100 },
  { m: "2026-06", net_worth: nwBase },
];
writeFileSync(
  join(OUT, "wealth", "data", "net-worth-history.json"),
  JSON.stringify({ currency: "USD", monthly, savings_rate_pct: 18, emergency_fund_months: 3.0 }, null, 2) + "\n",
);

// ── tax ───────────────────────────────────────────────────────────────────────

writeFileSync(
  join(OUT, "tax", "data", "income-summary-2026.csv"),
  csv([
    ["source", "recipient", "form", "gross_usd", "withheld_federal", "withheld_state", "notes"],
    ["Frontera Bank", "Jordan Smith", "W-2", "90000", "14850", "0", "Base salary; supplemental RSU withholding separate"],
    ["Frontera Bank", "Jordan Smith", "W-2 (supplemental)", "6180", "2163", "0", "RSU vest 2026-08-15 est (22% supp rate)"],
    ["Austin Physical Therapy", "Sam Smith", "W-2", "78000", "11310", "0", "Texas — no state income tax"],
    ["Ally Bank", "Household", "1099-INT", "420", "0", "0", "HYSA interest at 4.1% APY"],
    ["Frontera Bank", "Jordan Smith", "1099-INT", "192", "0", "0", "Checking account interest"],
    ["BCP Peru", "Jordan Smith", "1099-INT (foreign)", "330", "0", "0", "FBAR-required; reportable as US income"],
    ["Fidelity", "Household", "1099-B/DIV", "380", "0", "0", "Dividends and realized gains; VTI/BND/VXUS"],
    ["Rocket Mortgage", "Household", "1098", "19400", "0", "0", "Mortgage interest deduction (est)"],
  ]),
);

writeFileSync(
  join(OUT, "tax", "data", "fbar-2026.json"),
  JSON.stringify(
    {
      form: "FinCEN 114 (FBAR)",
      filer: "Jordan Smith",
      tax_year: 2026,
      deadline: "April 15 (automatic extension to October 15)",
      accounts: [
        {
          institution: "BCP — Banco de Crédito del Perú",
          country: "Peru",
          account_type: "Savings",
          account_number_last4: "7421",
          max_value_usd: 11_000,
          year_end_balance_usd: 11_000,
          currency: "PEN",
          interest_earned_usd: 330,
          triggers_fbar: true,
          note: "Exceeds the $10,000 aggregate threshold — filing required",
        },
      ],
      threshold_usd: 10_000,
      inherited_foreign_property: {
        description: "1/3 share of family home in Lima, Peru (inherited 2019)",
        estimated_value_usd: 35_000,
        form_8938_required: false,
        note: "Below Form 8938 reporting threshold; no rental income — passive hold only",
      },
    },
    null,
    2,
  ) + "\n",
);

// ── health ────────────────────────────────────────────────────────────────────

writeFileSync(
  join(OUT, "health", "data", "vitals.csv"),
  csv([
    ["date", "resting_hr", "sleep_hours", "wellness_score", "weight_lbs", "notes"],
    ["2026-05-01", "61", "6.8", "71", "172", ""],
    ["2026-05-08", "60", "7.0", "72", "172", ""],
    ["2026-05-15", "59", "7.2", "73", "171", "Annual physical today"],
    ["2026-05-22", "58", "7.1", "74", "171", ""],
    ["2026-05-29", "58", "7.0", "73", "170", "Travel week — disrupted sleep"],
    ["2026-06-05", "58", "7.1", "74", "170", ""],
    ["2026-06-09", "57", "7.3", "75", "170", "Best sleep month — bouldering helping"],
  ]),
);

writeFileSync(
  join(OUT, "health", "data", "lab-results.csv"),
  csv([
    ["test", "value", "unit", "reference_range", "flag", "date", "ordering_provider"],
    ["Total Cholesterol", "201", "mg/dL", "<200", "borderline", "2026-05-15", "Dr. Elena Marquez"],
    ["LDL Cholesterol", "138", "mg/dL", "<100 optimal / <130 near-optimal", "borderline high", "2026-05-15", "Dr. Elena Marquez"],
    ["HDL Cholesterol", "52", "mg/dL", ">40", "normal", "2026-05-15", "Dr. Elena Marquez"],
    ["Triglycerides", "88", "mg/dL", "<150", "normal", "2026-05-15", "Dr. Elena Marquez"],
    ["Blood Glucose (fasting)", "91", "mg/dL", "70-99", "normal", "2026-05-15", "Dr. Elena Marquez"],
    ["Vitamin D (25-OH)", "24", "ng/mL", "30-100", "low", "2026-05-15", "Dr. Elena Marquez"],
    ["TSH", "1.8", "mIU/L", "0.4-4.0", "normal", "2026-05-15", "Dr. Elena Marquez"],
    ["Hemoglobin A1c", "5.1", "%", "<5.7", "normal", "2026-05-15", "Dr. Elena Marquez"],
    ["Blood Pressure", "118/76", "mmHg", "<120/80", "normal", "2026-05-15", "Dr. Elena Marquez"],
    ["Resting HR", "58", "bpm", "60-100", "normal (athlete)", "2026-05-15", "Dr. Elena Marquez"],
  ]),
);

// ── fitness ───────────────────────────────────────────────────────────────────

writeFileSync(
  join(OUT, "fitness", "data", "training-log.csv"),
  csv([
    ["date", "type", "duration_min", "distance_km", "hr_avg", "rpe", "notes"],
    ["2026-05-03", "strength", "50", "", "128", "7", "Push day — bench / OHP"],
    ["2026-05-05", "zone-2 run", "45", "7.2", "138", "5", "Riverside trail"],
    ["2026-05-07", "strength", "55", "", "132", "7", "Pull day — rows / pull-ups"],
    ["2026-05-10", "bouldering", "90", "", "125", "6", "Austin Bouldering Project — V3 project"],
    ["2026-05-13", "strength", "50", "", "130", "7", "Leg day — squats / RDL"],
    ["2026-05-15", "zone-2 run", "45", "7.0", "136", "5", "Rest day after physical"],
    ["2026-05-18", "strength", "50", "", "129", "7", "Push day"],
    ["2026-05-20", "zone-2 run", "50", "8.1", "140", "5", "Longer effort — feeling good"],
    ["2026-05-22", "bouldering", "90", "", "122", "5", "Sent the V3 — first time!"],
    ["2026-05-25", "strength", "55", "", "131", "8", "Pull day — added weight"],
    ["2026-05-27", "zone-2 run", "45", "7.3", "137", "5", "Easy recovery"],
    ["2026-05-29", "rest", "0", "0", "", "", "Travel day to Portland"],
    ["2026-06-01", "strength", "50", "", "128", "7", "Back from Portland"],
    ["2026-06-03", "zone-2 run", "50", "8.0", "138", "5", "Best run yet — sub-6:10/km"],
    ["2026-06-05", "bouldering", "90", "", "124", "6", "Working a V4"],
    ["2026-06-08", "strength", "55", "", "132", "7", "Leg day — PR on squat (+5 kg)"],
    ["2026-06-10", "zone-2 run", "45", "7.5", "136", "5", "Morning run before work"],
  ]),
);

// ── career ────────────────────────────────────────────────────────────────────

writeFileSync(
  join(OUT, "career", "data", "rsu-schedule.csv"),
  csv([
    ["vest_date", "shares_est", "price_per_share_est", "gross_usd", "status", "notes"],
    ["2025-08-15", "120", "51.50", "6180", "vested", "Aug 2025 tranche — taxes withheld"],
    ["2026-02-15", "120", "51.50", "6180", "vested", "Feb 2026 tranche — taxes withheld"],
    ["2026-08-15", "120", "51.50", "6180", "upcoming", "Next vest — mark on calendar"],
    ["2027-02-15", "120", "51.50", "6180", "unvested", ""],
    ["2027-08-15", "120", "51.50", "6180", "unvested", ""],
    ["2028-02-15", "120", "51.50", "6180", "unvested", "Final tranche of $50k grant"],
  ]),
);

writeFileSync(
  join(OUT, "career", "data", "compensation-history.csv"),
  csv([
    ["year", "title", "base_usd", "rsu_granted_usd", "bonus_usd", "total_usd", "notes"],
    ["2022", "Personal Banker", "62000", "0", "3100", "65100", "Promotion from teller"],
    ["2023", "Branch Manager", "74000", "0", "5180", "79180", "First manager role"],
    ["2024", "Branch Manager", "78000", "50000", "5460", "133460", "RSU grant ($50k over 4 yrs)"],
    ["2025", "Senior Branch Manager", "88000", "0", "6160", "94160", "Promotion — fast-tracked"],
    ["2026", "Senior Branch Manager", "90000", "0", "0", "90000", "YTD base only; RSU vest Aug"],
  ]),
);

// ── insurance ─────────────────────────────────────────────────────────────────

writeFileSync(
  join(OUT, "insurance", "data", "policies.csv"),
  csv([
    ["type", "carrier", "policy_number", "coverage_usd", "premium_amount", "premium_period", "renewal_date", "notes"],
    ["Homeowner's", "Texas Farm Bureau", "HO-2024-8841", "322000", "2180", "annual", "2026-09-01", "Aging HVAC may affect renewal quote"],
    ["Auto (2 vehicles)", "Geico", "GA-44-8872901", "300000", "1140", "semi-annual", "2026-07-02", "22 days away"],
    ["Health (HDHP + HSA)", "Frontera Bank plan (BCBS)", "EMP-FRB-22041", "", "0", "employer-sponsored", "", "Jordan employee; Sam on own plan"],
    ["Term life — Jordan", "Haven Life", "TL-JOR-20240318", "500000", "31", "monthly", "2044-03-18", "20-yr term; Maya + Sam as beneficiaries"],
    ["Term life — Sam", "Haven Life", "TL-SAM-20240318", "350000", "24", "monthly", "2044-03-18", "20-yr term; Jordan + Maya as beneficiaries"],
    ["LTD — Jordan", "Frontera Bank (employer)", "LTD-FRB-2024", "54000", "0", "employer-sponsored", "", "60% of salary; 90-day elimination"],
    ["Umbrella", "NONE", "", "0", "0", "", "", "GAP — $1M umbrella not yet added (~$180/yr)"],
  ]),
);

// ── home ──────────────────────────────────────────────────────────────────────

writeFileSync(
  join(OUT, "homestead", "data", "maintenance-log.csv"),
  csv([
    ["date", "item", "status", "cost_quoted", "cost_actual", "vendor", "notes"],
    ["2026-06-08", "HVAC replacement (2016 Carrier)", "quoted — decision pending", "6850", "", "Aire Serv Austin", "Near end of life; replace before July peak"],
    ["2026-06-01", "Furnace filter replacement", "due", "18", "", "DIY", "MERV-11; last replaced Feb"],
    ["2026-05-20", "Home office repaint", "in progress", "0", "0", "DIY", "Picked color — La Paloma Gray"],
    ["2026-04-15", "Gutter cleaning", "done", "180", "180", "Austin Gutter Pros", "Spring clean"],
    ["2026-03-10", "Garage door spring", "done", "220", "220", "Overhead Door Austin", "Replaced"],
    ["2026-02-01", "Furnace filter replacement", "done", "18", "18", "DIY", "MERV-11"],
    ["2025-11-15", "Gutter cleaning (fall)", "done", "180", "180", "Austin Gutter Pros", ""],
    ["2025-10-01", "HVAC annual service", "done", "89", "89", "Aire Serv Austin", "Tech flagged end-of-life concern"],
  ]),
);

// ── travel ────────────────────────────────────────────────────────────────────

writeFileSync(
  join(OUT, "travel", "data", "trips.csv"),
  csv([
    ["destination", "depart", "return", "travelers", "budget_usd", "actual_usd", "booked", "notes"],
    ["Portland, OR", "2026-07-01", "2026-07-04", "Jordan + Sam + Maya", "1800", "", "no", "Long weekend; flights not yet booked"],
    ["Lima, Peru", "2026-12-20", "2027-01-03", "Jordan + Sam + Maya", "4800", "", "no", "Annual family visit; Maya's first time back"],
    ["Austin, TX (local)", "2026-06-14", "2026-06-14", "Jordan + Maya", "0", "0", "n/a", "Preschool recital Sat"],
    ["Denver, CO", "2026-11-15", "2026-11-16", "Jordan", "420", "", "no", "CBM exam trip (if not local)"],
    ["San Francisco, CA (work)", "2026-07-18", "2026-07-19", "Jordan", "0", "0", "yes", "Frontera Bank district meeting — company paid"],
    ["Cusco / Machu Picchu", "2027-04-01", "2027-04-10", "Jordan + Sam + Maya", "7500", "", "no", "Wishlist — tentative 2027"],
  ]),
);

// ── calendar ──────────────────────────────────────────────────────────────────

writeFileSync(
  join(OUT, "calendar", "data", "upcoming-events.json"),
  JSON.stringify(
    {
      generated: P.generatedAt,
      horizon_days: 120,
      events: [
        { date: "2026-06-12", title: "Maya's preschool recital", category: "family", priority: "immovable" },
        { date: "2026-06-13", title: "Dentist appointment (Jordan)", category: "health", priority: "confirmed" },
        { date: "2026-06-13", title: "District call — Frontera Bank", category: "work", priority: "confirmed" },
        { date: "2026-07-02", title: "Geico auto insurance renewal", category: "insurance", priority: "action-required" },
        { date: "2026-07-01", title: "Portland trip begins", category: "travel", priority: "planned" },
        { date: "2026-07-11", title: "Jordan mid-year review", category: "career", priority: "confirmed" },
        { date: "2026-07-18", title: "Frontera Bank district meeting (SF)", category: "work", priority: "confirmed" },
        { date: "2026-08-15", title: "RSU vest — 120 shares (~$6,180 gross)", category: "wealth", priority: "immovable" },
        { date: "2026-09-01", title: "Texas Farm Bureau homeowner's renewal", category: "insurance", priority: "action-required" },
        { date: "2026-10-15", title: "FBAR auto-extension deadline (FinCEN 114)", category: "tax", priority: "action-required" },
        { date: "2026-11-15", title: "Austin Half Marathon", category: "fitness", priority: "goal" },
        { date: "2026-12-20", title: "Lima trip — depart ATX", category: "travel", priority: "planned" },
      ],
    },
    null,
    2,
  ) + "\n",
);

// ── learning ─────────────────────────────────────────────────────────────────

writeFileSync(
  join(OUT, "learning", "data", "books.csv"),
  csv([
    ["title", "author", "status", "date_finished", "rating_out_of_5", "notes"],
    ["The Coaching Habit", "Michael Bungay Stanier", "done", "2026-01-18", "5", "Direct application to branch 1-on-1s"],
    ["The Psychology of Money", "Morgan Housel", "done", "2026-02-28", "5", "Re-read; gifted to two teammates"],
    ["Staff Engineer", "Will Larson", "done", "2026-04-10", "4", "Useful framing even outside engineering"],
    ["Four Thousand Weeks", "Oliver Burkeman", "done", "2026-05-22", "5", "Slowed down in a good way"],
    ["Becoming a Branch Leader (CBM prep)", "ABA", "done", "2026-05-30", "4", "Required CBM coursework"],
    ["Never Split the Difference", "Chris Voss", "in-progress", "", "", "Chapter 7 — started for the July review"],
    ["The Lean Startup", "Eric Ries", "wishlist", "", "", ""],
    ["Range", "David Epstein", "wishlist", "", "", "Recommended by district manager"],
  ]),
);

writeFileSync(
  join(OUT, "learning", "data", "courses.csv"),
  csv([
    ["course", "provider", "progress_pct", "target_date", "cost_usd", "employer_sponsored", "notes"],
    ["Certified Branch Manager (CBM)", "ABA (American Bankers Association)", "62", "2026-10-31", "1200", "yes", "Employer covers 50%; Jordan covers 50%"],
    ["Leadership Book Club", "Frontera Bank internal", "100", "", "0", "yes", "Monthly; currently reading Never Split the Difference"],
    ["Duolingo Spanish maintenance", "Duolingo", "100", "", "0", "no", "Daily streak — keeping native fluency current"],
    ["Half-Marathon Training Plan (Hal Higdon)", "Self-directed", "40", "2026-11-15", "0", "no", "Week 7 of 18"],
  ]),
);

// ── chief ─────────────────────────────────────────────────────────────────────

writeFileSync(
  join(OUT, "chief", "data", "weekly-review.json"),
  JSON.stringify(
    {
      week_of: "2026-06-08",
      generated: P.generatedAt,
      score_out_of_10: 7,
      wins: [
        "Sam got the PT promotion confirmation — salary goes to $82k in July",
        "Fitness: PR on squat; sent the V3 at the bouldering gym",
        "Maya's bilingual reading improving — finished her first Spanish picture book alone",
      ],
      friction: [
        "HVAC decision still pending — cost anxiety",
        "CBM coursework slipped one session this week",
        "Missed one zone-2 run (busy Wednesday)",
      ],
      open_threads: P.chief.acrossLife,
      next_week_focus: "Decide the HVAC (call Aire Serv for a second quote). Start CBM final module.",
      savings_rate_this_month: "18.2%",
    },
    null,
    2,
  ) + "\n",
);

console.log(`✓ wrote data files to ${OUT}`);
