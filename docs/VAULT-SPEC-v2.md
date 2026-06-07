# prevAIl Vault Specification — v2 (DRAFT / target)

> **Status: DESIGN TARGET, not yet implemented.** v1 (`VAULT-SPEC.md`) remains
> the live contract until the migration lands. v2 is a schema-version bump — it
> changes the load-bearing domain rule and the ownership model, so it requires a
> migration of every existing vault. This document is the canonical reference we
> build that migration against.

The vault is a folder of **domains** (`wealth`, `health`, `business`, …), each a
slice of life or work represented entirely as plain files on disk — readable by
any tool, syncable through any folder. No database, ever.

---

## 1. The core idea: inputs vs derivations

A vault holds two fundamentally different kinds of thing, and conflating them was
the v1 mistake:

- **Inputs** — what *you* provide: your intent (who you are, what you want) and
  your raw material (receipts, statements, documents). Only a human authors these.
- **Derivations** — what the *agent* synthesizes from your inputs: the current
  state, the timeline, next actions, generated artifacts. These are
  **regenerable** — change the inputs and the agent rebuilds them.

> You don't hand-write your state. You drop in 100 receipts and the agent *forms*
> a temporal spending state. State is a **projection**, not a document.

### The derivation pipeline

```
data/ (raw)
   │  agent extracts  (DETERMINISTIC — §6)
   ▼
_ledger.jsonl  (structured facts & metrics over time)
   │  agent projects  (LLM — §6)
   ▼
_state.md  (current snapshot)  ──measured against──▶  goals.md
   │                                                     │
   └──────────────▶  _tasks.jsonl  /  _artifacts/  ◀─────┘

skills = the learned procedures that run this pipeline.
```

---

## 2. The three tiers & the `_` rule

| Tier | Owner | Members |
|---|---|---|
| **Intent** | human (agent may *draft*, you commit) | `soul.md`, `goals.md`, `config.md` |
| **Raw material** | human-supplied only | `data/` |
| **Derived** | agent owns & regenerates (`_`-prefixed) | everything else |

**The naming rule:** a leading underscore means **machine-writable** — the agent
or system owns it and may regenerate it. No underscore means **human-owned**.

**"Agent-owned" = source-of-truth + regeneration, NOT access control.** A human
*may* read or seed any derived file, but should not hand-edit one — the agent
re-derives it. To assert a fact, you correct the **input** (§9), not the output.

---

## 3. Per-domain anatomy (FINAL)

```
<vault>/<domain>/
  # ── INTENT (human) ──
  soul.md          why this domain exists — purpose, principles, risk posture.
                   Stable; rarely changes. Fractal with the vault-level soul.
  goals.md         objectives + KPI targets. Each goal names its metric & target.
  config.md        preferences / settings (key: value) + `sensitivity:` tier (§7).

  # ── RAW MATERIAL (human) ──
  data/            source documents the agent reads (receipts, statements, PDFs…).
    corrections.md human-asserted ground-truth facts (highest precedence). §9.

  # ── DERIVED (agent, regenerable, `_`) ──
  _state.md        synthesized snapshot — projection of _ledger. Carries
                   `derived_from:` provenance frontmatter (§6).
  _ledger.jsonl    append-only structured facts & metric readings. Permanent. §5.
  _decisions.jsonl append-only key decisions, each linked to its source. §5.
  _tasks.jsonl     structured current work (status + provenance). §5.1.
  _skills/         learned procedures the agent forms & uses.
  _artifacts/      generated outputs (briefs, reports, drafts).
  _log/            operational history, score history (score.jsonl).
  _threads/        chat & council transcripts.
  _meta/           manifest.json (routing/identity/sensitivity), agent memory.
```

Only the **intent** tier makes a domain real (§4). Every derived entry is optional
— its absence means "the agent hasn't produced it yet."

---

## 4. The domain rule (changed from v1)

> **A directory is a domain if and only if it contains `soul.md`.**

A domain exists because **you declared intent for it** — not because a synthesized
`_state.md` happens to exist. This is the load-bearing change from v1. A brand-new
domain has `soul.md` (+ maybe `data/`) and **no `_state.md` yet** — a valid,
*unprocessed* domain. The scanner skips reserved support dirs (`core`, `complete`,
`scripts`, `.git`, `.claude`, `node_modules`) and anything `_`-prefixed at vault root.

---

## 5. The append-only logs (a domain's memory)

Agent-appended, human-correctable, never rewritten in place. Appends commute, so
they merge cleanly across machines (§8).

### `_ledger.jsonl` — what happened (facts, with trust)
```json
{"ts":"2026-06-06T19:00:00Z","type":"metric","key":"net_worth","value":189400,"unit":"USD","source":"data/statements/2026-06.pdf#p2","confidence":"high","verified":false}
{"ts":"2026-06-06T19:05:00Z","type":"event","label":"Renewed auto policy","source":"data/insurance/policy.pdf","confidence":"medium","verified":false}
```
Every fact carries `source` (file + locator), `confidence` (`high|medium|low`),
and `verified` (human-confirmed). See §6 for how trust gates usage.

### `_decisions.jsonl` — what we chose (with provenance)
```json
{"ts":"2026-06-06T20:00:00Z","decision":"Move 20% of cash into a broad index fund","rationale":"runway > 12mo","source":"council:r_8f3a","alternatives":["hold cash","short-term bonds"],"status":"ratified"}
```
**Provenance is the point.** A decision distilled from a chat or **council verdict**
carries `source: "thread:<id>"` / `"council:<id>"`; the full deliberation lives in
`_threads/` and the decision links back by id. Decisions start `proposed`, flip to
`ratified` on human confirm.

### 5.1 `_tasks.jsonl` — current work
Mutable working set (the gap between `_state` and `goals`); one task per line.
```json
{"id":"t_a1","title":"Rebalance to 70/30","status":"open","priority":"high","due":"2026-07-01","goal":"net_worth_500k","source":"council:r_8f3a","created":"2026-06-06T20:00:00Z","updated":"2026-06-06T20:00:00Z"}
```
- `status ∈ proposed · open · in_progress · blocked · done · dropped`
- `goal` links to a `goals.md` objective; `source` links to its origin thread/council.
- **Every status transition appends an event to `_ledger.jsonl`** (`{"type":"event","label":"task open→done: …","source":"task:t_a1"}`). Current work lives in `_tasks`; permanent history lives in `_ledger`. This also makes task history concurrency-safe (§8).

---

## 6. Derivation & freshness (the operational contract)

The whole model rests on the agent turning inputs into derivations. This section
makes *when*, *how reproducible*, and *how trusted* explicit.

### 6.1 Deterministic vs LLM — the dividing line
- **Deterministic & always-current** (no LLM, reproducible): parsing/extracting
  facts into `_ledger`, computing scores, freshness/hash checks. A dollar amount on
  a statement parses the same way every time.
- **LLM & cached** (non-deterministic, regenerable): the `_state.md` narrative,
  `_tasks` proposals, `_artifacts`, decision distillation.

> **Facts are deterministic and permanent (`_ledger`). Prose is LLM and
> regenerable (`_state`).** Re-deriving never rewrites a fact — only the summary
> over the facts. (LLM-assisted extraction is allowed, but its output is normalized
> deterministically and written as a ledger fact with a `confidence`.)

### 6.2 Provenance & staleness
Every derived file records what it was built from, as frontmatter:
```yaml
---
derived_from:
  data:   "sha256:…"      # hash of the data/ manifest at derivation time
  ledger: 1487            # last ledger line consumed
at:   "2026-06-06T20:00:00Z"
by:   "claude-opus-4-8"
schema: 2
---
```
A derived file is **stale** iff its `derived_from` marks ≠ the current inputs. The
staleness check is a **cheap hash compare**; the expensive LLM re-derive runs *only*
when stale or explicitly forced. This is also the primary cost control (§ Open
Problems): no input change → no model call.

### 6.3 Triggers
Re-derivation runs (cheapest-first): **on-demand** (you open the domain or ask) →
**on-input-change** (data added / ledger appended, debounced) → **on-heartbeat**
(cadence warmth, budget-permitting). Deterministic extraction runs eagerly on input
change; LLM projection runs lazily, gated by staleness + budget.

### 6.4 Trust & verification
Wrong numbers in a money/health vault are dangerous, so extracted facts are not
assumed infallible:
- Every `_ledger` fact carries `confidence` and `verified`.
- A **high-magnitude** fact (money, dosage, legal date) that is `low` confidence or
  unverified is marked `needs_review` and surfaced in the UI; it is shown but
  **flagged in goal math until verified**.
- `verified:true` is only ever set by a human action (or an authoritative connector,
  e.g. a bank API), never by the LLM that extracted it.

---

## 7. Privacy & sensitivity

This vault holds the most sensitive data a person has. Privacy is a first-class
field, not an afterthought.

- **Per-domain `sensitivity` tier** (in `config.md` / `_meta/manifest.json`):
  `standard` · `sensitive` · `local_only`.
  Defaults: `wealth`, `health`, `estate`, `insurance`, `records` → **`local_only`**.
- **`local_only`**: raw `data/` never leaves the device for a remote model.
  Derivation uses a local model (Ollama) or deterministic-only extraction; any remote
  model receives **redacted/aggregated** views, never source documents.
- **Redaction** (existing `privacy.ts`) runs before *any* remote model call for
  `sensitive`/`local_only` domains — strips PII, account numbers, names.
- **At rest / sync**: the vault should live in a private, ideally encrypted location.
  Vault git remotes **must be private**; a default `.gitignore` excludes `data/` and
  `_artifacts/` from any vault repo unless the user explicitly opts a domain in.
- Sensitivity is **inherited**: a domain's tier applies to its `data/`, `_ledger`,
  `_artifacts`, and any council/chat grounded in it.

---

## 8. Concurrency & conflicts

Your setup is multi-writer by design (two machines over Tailscale + Paperclip +
OpenClaw + the desktop app). The architecture makes most conflicts *non-events*:

| Layer | Conflict policy |
|---|---|
| **Human inputs** (`soul`/`goals`/`config`/`data`) | Rare, human-edited. Sync = last-writer-wins or git merge; the human resolves. |
| **Append-only logs** (`_ledger`/`_decisions`) | Appends commute. Merge = union, sort by `ts`, dedup by `id`. Readers tolerate a torn final line. |
| **Derived projections** (`_state`/`_tasks`/`_artifacts`) | **Regenerable → conflicts don't matter.** On any clobber/conflict, discard and re-derive. Written by the single local engine via atomic temp-write + rename. |

> **Only human input ever needs careful merging.** Everything derived is either
> append-commutative or regenerable, so conflicts resolve themselves. Designate the
> machine the user is on as the active engine/writer; other agents *propose* (append
> to a log) rather than rewrite a projection.

---

## 9. Corrections & reconciliation

When a human asserts a fact that contradicts the agent's derived `_state`, it goes
into **`data/corrections.md`** — an input, not an edit to the projection.
Corrections are **highest precedence** in derivation: the agent must honor them over
anything it infers from other raw data. Humans assert into the input layer; the
agent always re-derives the output layer — and every override is preserved.

---

## 10. Scoring philosophy (changed from v1)

v1 rewarded a hand-written `state.md` — backwards under v2, where state is the
agent's own output. v2 scores what the human controls and the agent's job of
bridging them:
- **Input richness** — raw `data/` + intent (`soul`, `goals`) provided.
- **Derivation quality** — did the agent build `_ledger`/`_state` and keep them fresh
  (via §6.2 staleness) against the data.
- **Goal attainment** — a *second* score: progress on `goals.md` measured through
  `_ledger`.

---

## 11. Vault root

```
vault/
  soul.md          GLOBAL identity — values, voice, long arc, hard constraints.
                   Injected into every domain's context. Root of the fractal souls.
  <domain>/        … (per §3)
```

---

## 12. Migration from v1

1. Per domain, by *ownership* (not blanket "into data/"):
   - `state.md → _state.md` (+ provenance frontmatter)
   - `decisions.md → _decisions.jsonl`
   - `open-loops.md → _tasks.jsonl`
   - `manifest.json` / `MEMORY.md → _meta/`
   - `skills/` + `PROMPTS.md` (seed) → `_skills/`
   - `00_current/` + `01_prior/` → `data/` (flattened by source type; drop the
     numeric tiers — the ledger carries recency)
   - `02_briefs/ → _artifacts/` (briefs are synthesized output, not raw data)
   - `QUICKSTART.md` → fold into `soul.md`; drop the boilerplate.
2. Create `soul.md` (seed from the top of the old `state.md` + `QUICKSTART.md`) and `goals.md`.
3. Domain detection: `state.md` → `soul.md`.
4. Scoring: re-key canonical paths; flip the philosophy (§10).
5. Schema-version bump; one-shot migrator over every vault.

> Sequence: lock spec → restructure demo vault → update detection → update scoring →
> ship migrator. Each stage independently testable.

---

## 13. Open problems (tracked, not blocking stage 2)

Best-choice **direction** noted for each; full design deferred.

1. **Cross-domain reality.** Life isn't siloed (a house buy touches wealth +
   real-estate + tax + estate + insurance; "TechFlow Inc" is shared). *Direction:* a
   vault-level entity registry + cross-domain refs (`@entity:…`), and councils that
   may span domains.
2. **Append-only scale.** `_ledger` grows forever. *Direction:* periodic compaction
   to a `_ledger.snapshot.json` + a tail of recent lines; projection reads snapshot +
   tail.
3. **Forgetting vs "never delete."** *Direction:* redaction via **tombstone events**
   (`{"type":"redact","target":"<id>"}`) that projections honor; physical purge only
   on explicit user request (never-delete = never *without* the user).
4. **Cost / runaway guardrails.** Derivation + council + heartbeat spawn LLMs on a
   cadence (cf. the 50 GB runaway). *Direction:* wire `budget.ts` into the derivation
   loop; the §6.2 staleness gate is the primary cost control (no change → no call);
   hard per-cycle caps + kill-switch.
5. **Cold-start ramp.** A fresh domain is `soul.md` + nothing. *Direction:* an
   ingestion on-ramp (declare intent → connect a source / drop data → deterministic
   extraction populates `_ledger` → first projection) — this replaces the removed
   onboarding popup.
6. **Metric vocabulary.** `goals` and `_ledger` must agree on metric keys/units.
   *Direction:* a per-domain metric registry (canonical `key`, `unit`) so
   goal↔ledger matching is exact.
7. **Derivation eval.** LLM derivation can't be unit-tested like deterministic
   scoring. *Direction:* golden-set evals over fixture vaults.
