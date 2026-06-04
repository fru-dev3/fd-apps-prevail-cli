# Canonical benchmark — starter pack

These 10 questions ship with the demo vault to give the `prevail bench` tooling something to chew on out of the box. They're written against the **Alex Rivera** demo persona (40, married, two kids, mid-career engineer + side business) and each one carries a **ground-truth verdict** the demo persona would stand behind in real life.

## How the scoring works

When you run:

```
prevail bench run --canonical --cli claude
prevail bench score
prevail bench leaderboard
```

each question gets graded two ways:

1. **Mechanical keyword match (0-100%):** how many of the `expected_verdict_keywords` show up in the model's reply.
2. **LLM-as-judge (0-10):** a chair model reads the question, the `expected_decision`, and the model's reply, and scores alignment with a one-line rationale.

A reply that hedges ("it depends on your risk tolerance") will score low on both — these questions are deliberately written so a competent model should pick a clear side.

## Replacing with your own

This is a **starter pack**, not a fixed test. To replace any question with your own:

- **Edit a question file:** open `vault-demo/benchmark/questions/<id>.md` in your editor and rewrite the prompt, context, expected_decision, and verdict keywords.
- **Add a new one:** `prevail bench seed --domain wealth` writes a fillable stub.
- **Import from your history:** `prevail bench seed --from-log wealth` walks the most recent council verdict from your domain log and pre-fills a draft from it. This is the highest-value path — your real decisions become your real benchmark.

The goal is to test new models against questions where you *already know* the right answer because you lived it. The starter pack is just scaffolding so the machinery doesn't feel empty on day one.
