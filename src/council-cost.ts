// council-cost — rough heuristic estimator for a /council fanout.
//
// Cost numbers here are deliberately coarse — they're meant to give the
// user a one-line "you're about to spend ~$X" sanity check before
// firing a heavy multi-CLI multi-lens turn, NOT a precise bill. Every
// surface that shows these numbers labels them "rough" or "~" so the
// user understands the actual cost depends on response length and the
// model variants in play.
//
// The math:
//   totalCalls = panelistCount * lensCount + 1   (+1 = the chair synth)
//   estCostUsd = sum over panelists of (lensCount * perCallUsd(panelist))
//              + chairCostUsd
//   perCli   = same sum, grouped by cli kind for the convening line
//
// lensCount semantics: callers pass 1 when no lens is active, and N
// when a fanout is in play (N = expandLensSelection(...).length). The
// chair always fires exactly once regardless of lens fanout — it
// synthesizes the whole panel into one verdict.

// Per-call USD estimate by CLI kind. Tuned for our typical prompt+reply
// sizes (a few KB in, a few KB out) at each CLI's default model. Local
// CLIs are free.
const PER_CALL_USD: Record<string, number> = {
  claude: 0.005,
  codex: 0.004,
  gemini: 0.003,
  ollama: 0,
};

// Fallback for unknown / future CLIs. Same as claude — conservative
// enough that we don't accidentally under-warn the user.
const PER_CALL_USD_UNKNOWN = 0.005;

// Chair (synthesis) call cost. Chair is one extra call on top of the
// panel; we don't know which CLI will end up doing synthesis at
// estimate-time (it depends on which panelist replied first or the
// pinned chair config), so we pick a single representative price
// rather than threading the chair CLI through the estimator.
const CHAIR_CALL_USD = 0.005;

function perCallUsd(cliKind: string): number {
  return cliKind in PER_CALL_USD ? PER_CALL_USD[cliKind]! : PER_CALL_USD_UNKNOWN;
}

export interface CostEstimate {
  panelistCount: number;       // distinct (cli, model) panelists
  lensCount: number;           // 1 when no lens, N when lens=all
  totalCalls: number;          // panelistCount * lensCount + 1 (chair)
  estCostUsd: number;          // rough heuristic — sum per-CLI per-call estimates
  perCli: Record<string, number>;  // breakdown for the convening line
}

export interface EstimateArgs {
  panelists: { cliKind: string; model: string }[];
  lensCount: number;       // 1 when no lens is active, N when fanned out
  promptChars: number;     // count of the user prompt; vault context excluded
}

export function estimateCouncilCost(args: EstimateArgs): CostEstimate {
  const panelistCount = args.panelists.length;
  // Guard: callers may pass 0 when there's no lens (legacy) — we
  // normalize to 1 so the math still works (one call per panelist).
  const lensCount = args.lensCount > 0 ? args.lensCount : 1;

  // Panel calls = panelist × lens (one call per panelist per lens).
  // Chair = +1 synthesis call regardless of fanout.
  const totalCalls = panelistCount * lensCount + 1;

  // Aggregate per-CLI spend so the convening line can break it down
  // ("claude: $0.02, codex: $0.016, ollama: free"). We sum by kind, not
  // by (cli, model) pair — different model variants of the same CLI
  // share the heuristic price.
  const perCli: Record<string, number> = {};
  let panelCost = 0;
  for (const p of args.panelists) {
    const per = perCallUsd(p.cliKind);
    const cost = per * lensCount;
    perCli[p.cliKind] = (perCli[p.cliKind] ?? 0) + cost;
    panelCost += cost;
  }

  const estCostUsd = panelCost + CHAIR_CALL_USD;

  return {
    panelistCount,
    lensCount,
    totalCalls,
    estCostUsd,
    perCli,
  };
}

// Format an estimate into the one-line system message shown before
// "convening council". Kept here so the app.tsx call site and any
// tests can share a single format and round-trip the rounding.
export function formatCostLine(est: CostEstimate): string {
  const dollars = est.estCostUsd.toFixed(2);
  return `estimated cost: ~$${dollars} for ${est.totalCalls} calls (rough — actual depends on response length)`;
}
