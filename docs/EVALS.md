# Evals

Two layers protect agent quality from regressing when a model, prompt, or
runtime changes.

## 1. Deterministic guard evals (CI)

The load-bearing honesty machinery is unit-tested and runs on every push, so a
refactor can't silently break it:

- **No fabricated success** (`verified-footer.test.ts`): the "what I actually
  did" footer is built from the verified action ledger, never the model's
  prose. A reply that only *sounds* like it acted cannot claim it did.
- **No injected instructions obeyed** (`taint.test.ts`): external content is
  wrapped as untrusted and injection scaffolding is defanged.
- **Guardrails hold at execution** (`egress-guard.test.ts`, `email-policy.test.ts`,
  `act-gate*.test.ts`): sensitive content and third-party sends are held/drafted
  regardless of prompt phrasing.
- **Upstream contracts** (`contract.test.ts`): the real `gws`/`claude`/`codex`
  output shapes our parsers depend on still hold (skips when a tool is absent).

## 2. Semantic quality evals (manual, before promoting a release)

Model-graded quality is non-deterministic, so it's a maintainer gate, not a CI
check. The Arena / canonical-benchmark harness is the mechanism:

1. Keep a frozen set of representative questions under the benchmark
   `questions/` dir (real decisions across a few domains, with any attachments).
2. Run the set against the candidate build:
   `prevail bench run` (or the Arena tab in the desktop app).
3. Compare the scored results against the last promoted build's run. Look for
   regressions in decisiveness, grounding, and the disagreement surface.
4. Only **promote** the prerelease to stable (Actions → Promote to stable) once
   the scores hold. If they regress, fix or roll back.

The frozen question set is the "golden run": curate it once from real usage,
re-score it on every model/prompt change, and treat a score drop as a release
blocker. This is deliberately a human-in-the-loop gate — quality is judged, not
asserted.
