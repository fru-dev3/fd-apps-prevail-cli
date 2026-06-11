// persona.ts — the single source of truth for the demo vault.
//
// Every domain the generator emits (config.md, _state.md, data files, chat
// threads) derives from THIS object, so the sample data is consistent by
// construction: change a number here and it flows everywhere.
//
// The household is fictional. Jordan's Peruvian background is drawn as a
// strength — bilingual, bicultural, family-oriented — and the "complexity" it
// adds (international travel, remittances, a foreign account that crosses the
// FBAR threshold) is authentic to many immigrant households and gives the demo
// genuine cross-domain richness. Keep it respectful; avoid stereotype.
//
// Numbers are EXACT (no round "~$11k" approximations) so the data reads real,
// and modest — a 29-year-old dual-income household early in its wealth-building.

export const PERSONA = {
  // ─── The household ────────────────────────────────────────────────
  household: {
    primary: {
      name: "Jordan Smith",
      age: 29,
      // Born in Lima, Peru; immigrated to the US in 2011 at 14 (the "1.5
      // generation"), naturalized 2018. Bilingual Spanish/English — an asset at
      // the branch, which serves a large Spanish-speaking customer base.
      birthplace: "Lima, Peru",
      immigratedYear: 2011,
      immigratedAge: 14,
      naturalizedYear: 2018,
      languages: ["Spanish (native)", "English (fluent)"],
      job: {
        title: "Senior Branch Manager",
        employer: "Frontera Bank", // publicly-traded Texas regional bank → modest RSUs make sense
        yearsAtBank: 5,
        yearsInRole: 2, // fast track: teller → personal banker → branch manager
        baseSalary: 90_000,
        // Modest equity: a $50k grant vesting over 4 years; next tranche small.
        rsu: { unvestedTotal: 50_000, nextVestDate: "2026-08-15", nextVestGross: 6_180, cadence: "semi-annual" },
      },
    },
    partner: {
      name: "Sam Smith",
      age: 28,
      job: { title: "Physical Therapist", employer: "Austin Physical Therapy", baseSalary: 78_000 },
    },
    child: { name: "Maya Smith", age: 3, stage: "preschool", raisedBilingual: true },
    // Aging parents in Lima; Jordan sends monthly remittances to help support them.
    familyAbroad: { who: "Jordan's parents (Rosa & Miguel)", city: "Lima, Peru", remittanceMonthly: 400 },
    location: { address: "2117 Cedar Hollow Dr", city: "Austin", state: "TX", zip: "78704", noStateIncomeTax: true },
    filingStatus: "married filing jointly",
  },

  // ─── Wealth ───────────────────────────────────────────────────────
  // Net worth ≈ $134,000, computed in the generator from these components so it
  // always reconciles. Early-career: modest balances, equity-heavy.
  wealth: {
    householdW2Income: 168_000, // Jordan 90k + Sam 78k
    monthlySavings: 850, // 650 brokerage + 200 to Maya's 529
    accounts: {
      checking: { institution: "Frontera Bank", balance: 4_820 }, // banks where they work
      emergencyFund: { institution: "Ally", apy: 0.041, balance: 10_240 }, // ~3 months
      brokerageTaxable: { institution: "Fidelity", balance: 6_180 },
      roth: { jordan: 9_840, sam: 6_420 },
      retirement: { jordan401k: 22_300, jordanMatch: "4% match (Jordan contributes 6%)", sam403b: 13_100 },
      hsa: 2_460,
      college529: { beneficiary: "Maya", balance: 4_120 },
    },
    home: {
      // Starter house bought in 2024 with ~5% down — little equity yet.
      marketValue: 322_000,
      mortgage: { balance: 311_200, rate: 0.0625, lender: "Rocket Mortgage", monthlyPITI: 2_410 },
    },
    vehicles: [
      { desc: "2021 Honda CR-V", loanBalance: 10_800, rate: 0.059, monthly: 322 },
      { desc: "2017 Toyota Corolla (Sam)", loanBalance: 0, value: 8_500 },
    ],
    allocation: { current: "80% equities / 13% bonds / 7% cash", target: "75% equities / 20% bonds / 5% cash" },
    fireTargetNumber: 1_500_000,
  },

  // ─── Peru / international ties ─────────────────────────────────────
  // The authentic complexity: a foreign bank account that crosses the $10k
  // FBAR threshold, and an inherited share of the family home in Lima.
  international: {
    peruSavingsAccount: { institution: "BCP (Banco de Crédito del Perú)", balanceUSD: 11_000, triggersFBAR: true },
    inheritedPropertyShare: { what: "1/3 share of the family home in Lima (inherited 2019)", estValueUSD: 35_000 },
    annualVisit: true, // visits Lima ~once a year
  },

  // ─── Tax ──────────────────────────────────────────────────────────
  tax: {
    year: 2026,
    filingStatus: "married filing jointly",
    state: "Texas (no state income tax)",
    forms: ["2x W-2", "RSU supplemental withholding", "1099-INT (Ally, Frontera, BCP)", "1099-B/DIV (Fidelity)", "1098 (mortgage)"],
    foreignReporting: {
      fbar: { required: true, reason: "BCP account ($11,000) exceeds the $10,000 aggregate threshold", deadline: "Apr 15 (auto-ext Oct 15)" },
      foreignInterest: "interest on the BCP account is US-reportable",
    },
    credits: ["Child Tax Credit (Maya)"],
    notes: "All-W2 + RSU; RSU vests are supplementally withheld and may slightly under-withhold — watch the April balance. Remittances to parents are not deductible and well under the gift-tax exclusion.",
  },

  // ─── Insurance ────────────────────────────────────────────────────
  insurance: {
    policies: [
      { type: "Homeowner's", carrier: "Texas Farm Bureau", premiumAnnual: 2_180, renewal: "2026-09", note: "aging HVAC affects renewal/risk" },
      { type: "Auto (2 vehicles)", carrier: "Geico", premiumSixMonth: 1_140, renewal: "in 22 days" },
      { type: "Health (HDHP + HSA)", carrier: "Jordan's Frontera Bank plan" },
      { type: "Term life — Jordan", carrier: "Haven", coverage: 500_000, premiumMonthly: 31 },
      { type: "Term life — Sam", carrier: "Haven", coverage: 350_000, premiumMonthly: 24 },
      { type: "Long-term disability — Jordan", carrier: "employer (Frontera)" },
    ],
    gap: "No umbrella policy yet — a $1M umbrella (~$180/yr) is worth adding (protects the home + savings).",
  },

  // ─── Health ───────────────────────────────────────────────────────
  health: {
    jordan: {
      wellnessScore: 74, restingHR: 58, avgSleepHours: 7.1, workoutsPerWeek: 3,
      lastPhysical: "2026-05", pcp: "Dr. Elena Marquez",
      labFlags: ["LDL cholesterol 138 mg/dL (borderline high — an early flag at 29)", "Vitamin D 24 ng/mL (low)"],
    },
    goals: ["Wellness score ≥ 80", "Train 4x/week", "Average 7.5h sleep"],
  },

  // ─── Fitness ──────────────────────────────────────────────────────
  fitness: {
    plan: "3x strength + 2x zone-2 cardio", recent: "started bouldering at a local gym",
    goal: "Austin half-marathon in November", hrvTrend: "improving",
  },

  // ─── Career ───────────────────────────────────────────────────────
  career: {
    role: "Senior Branch Manager, Frontera Bank (5 yrs at the bank, 2 in the role)",
    aiming: "Area/District Manager",
    strengths: ["bilingual — serves the branch's Spanish-speaking customers", "team leadership", "deposit growth"],
    cert: "studying for the Certified Branch Manager (CBM) credential",
    review: "mid-year review in July; comp conversation tied to district numbers",
  },

  // ─── Travel ───────────────────────────────────────────────────────
  travel: {
    next: { place: "Portland, OR", when: "in 3 weeks", who: "family long weekend", budget: 1_800 },
    planned: { place: "Lima, Peru", when: "December", who: "annual family visit (holidays with Rosa & Miguel)", note: "show Maya more of where Jordan grew up" },
    wishlist: ["Cusco / Machu Picchu with Maya", "Japan 2027"],
  },

  // ─── Home / Homestead ─────────────────────────────────────────────
  home: {
    hvac: { unit: "2016 Carrier (came with the house)", status: "near end of life", replacementQuote: 6_850, decision: "replace before peak summer vs wait" },
    maintenance: ["furnace filter due", "repaint home office (in progress)", "gutter clean before fall"],
  },

  // ─── Learning ─────────────────────────────────────────────────────
  learning: {
    inProgress: ["Certified Branch Manager (CBM) coursework", "a leadership book club at work"],
    books: { readThisYear: 5, target: 12 },
    personal: "helping Maya with Spanish reading on weekends",
  },

  // ─── Chief (the command center that ties it together) ─────────────
  chief: {
    focusToday: "decide the HVAC, then prep the district call",
    top3: ["HVAC: replace ($6,850) vs wait", "Q2 tax / FBAR paperwork started", "confirm RSU vest earmark"],
    acrossLife: [
      "HVAC $6,850 pending — touches Wealth, Home, Insurance",
      "Insurance: auto renewal in 22 days; home renewal Sept",
      "Tax: FBAR for the BCP account; RSU vest Aug 15 (withholding)",
      "Travel: Portland in 3 weeks; Lima in December",
    ],
  },

  // ─── Cross-domain threads ─────────────────────────────────────────
  // The connective tissue that makes "combine health + wealth" (etc.) pay off.
  // The generator drops references to these into each linked domain's _state.md.
  crossDomain: [
    { id: "hvac", summary: "Replace the 2016 HVAC ($6,850) before summer", links: ["wealth", "homestead", "insurance"] },
    { id: "rsu-vest", summary: "RSU vest 2026-08-15 ($6,180 gross)", links: ["career", "wealth", "tax"] },
    { id: "fbar", summary: "BCP foreign account ($11,000) → FBAR filing required", links: ["tax", "wealth"] },
    { id: "maya", summary: "Maya (3): 529, child tax credit, term-life beneficiary, preschool recital Sat", links: ["wealth", "tax", "insurance", "calendar"] },
    { id: "labs", summary: "Borderline LDL 138 + low vitamin D", links: ["health", "fitness", "insurance"] },
    { id: "lima-trip", summary: "December family visit to Lima", links: ["travel", "calendar", "wealth"] },
    { id: "umbrella", summary: "Add a $1M umbrella policy (no gap coverage yet)", links: ["insurance", "wealth"] },
  ],

  // Domains the generator will emit (core 7 + 4 extras).
  domains: ["chief", "career", "wealth", "tax", "health", "fitness", "insurance", "homestead", "travel", "calendar", "learning"] as const,

  generatedAt: "2026-06-10",
} as const;

export type Persona = typeof PERSONA;
