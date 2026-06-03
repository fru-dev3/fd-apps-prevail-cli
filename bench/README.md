# prevail-bench

> Public benchmark suite for AI council reasoning on real-life decisions.

**TL;DR:** A curated set of decision-grade questions where you can run the
exact same `/council` prompt against Claude, Codex, Gemini, and Ollama —
then score the panel on (a) reasoning quality, (b) cross-model agreement,
and (c) where verifiable, outcome accuracy.

Most "Claude vs GPT vs Gemini" comparisons run single prompts. Council runs
all of them in parallel, then a chair synthesizes — and we measure whether
the synthesis is better than any single model.

## Methodology

Each question is a markdown file under `questions/<domain>/<slug>.md` with
this shape:

```markdown
---
id: wealth-mortgage-vs-invest
domain: wealth
stakes: high
verifiable: false
---

## Prompt

Should I prepay my 6% mortgage or invest the cash in an S&P 500 index fund?

## Context (pre-pasted)

- Effective tax rate: 32%
- Mortgage balance: $340,000
- Years remaining: 24
- Liquid savings: 4 months expenses

## Scoring rubric

- **Liquidity floor**: does the answer require ≥6mo emergency fund first?
- **Risk-adjusted spread**: does it compute the after-tax effective rate?
- **Behavioral risk**: does it flag the "can't sell at -30%" failure mode?
```

`prevail bench run [--domain <name>] [--question <id>]` walks the suite,
runs `/council` against every question, and writes results to
`results/<YYYY-MM-DD>/<id>.md` plus a top-level `results/<date>-summary.md`
markdown table.

## What we score

| metric | what it measures |
| --- | --- |
| **panel agreement** | how often N panelists converged on the same call |
| **verdict surface area** | did the chair's verdict cite all rubric checkpoints? |
| **divergence accuracy** | when panelists split, did the chair's verdict side with the *correct* faction? (for verifiable questions) |
| **time-to-verdict** | wall clock from prompt to verdict (faster is better) |
| **token efficiency** | total tokens across the panel + chair (lower is better at same quality) |

## Running the bench yourself

```bash
# All questions, current models
prevail bench run

# Just the wealth domain
prevail bench run --domain wealth

# A single question
prevail bench run --question wealth-mortgage-vs-invest

# Compare two model versions on the same suite
PREVAIL_BENCH_CLAUDE_MODELS="claude-opus-4-7,claude-opus-4-6" prevail bench run
```

Results land in `results/`. Commit them to your fork to share scores.

## Contributing questions

PRs welcome. Quality bar:

1. The question should be a real decision someone would actually make.
2. Include enough context so the model isn't guessing at the situation.
3. Write a scoring rubric — explicit checkpoints make the chair's verdict
   measurable. "Good answer" isn't enough.
4. Mark `verifiable: true` only if there's a knowable correct answer.

See `questions/wealth/mortgage-vs-invest.md` for the format.
