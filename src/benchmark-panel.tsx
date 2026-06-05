import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "./theme.ts";
import {
  benchmarkRoot,
  buildLeaderboard,
  listQuestions,
  runCanonicalSet,
  scoreRun,
  seedFromLatestCouncil,
  writeDraftQuestion,
  writeRunDirectory,
  type CanonicalQuestion,
  type CanonicalRunRecord,
  type LeaderboardEntry,
  type RunScore,
} from "./canonical-bench.ts";
import {
  MODEL_QUICKPICKS_FALLBACK,
  defaultModelFor,
  type AvailableCli,
  type CliKind,
} from "./cli-bridge.ts";
import { openInFinder } from "./system.ts";

interface Props {
  onClose: () => void;
  vaultPath: string;
  // The cockpit already detected these at boot — reuse so the panel
  // doesn't re-probe and we get a fast open.
  availableClis: AvailableCli[];
  // Domain names — used by the "import from journal" picker. Reading
  // them from app.tsx state (already scanned at boot) instead of
  // re-scanning the vault here.
  domainNames: string[];
}

// Two-pane benchmark overlay. The user picks a target CLI/model, fires
// all canonical questions sequentially, and watches per-question
// progress. After the run finishes, scoreRun grades it (keyword match +
// LLM-as-judge if a chair CLI is available). Past runs land in the
// leaderboard view at the bottom.
//
// Why this is an overlay instead of a tab: the existing tabs are
// per-domain (chat/state/quickstart/prompts/skills) and the benchmark
// is cross-domain by definition. Bolting it onto a fake "domain" tab
// would feel wrong; bolting it onto the global Tools panel would mix
// "configure prevAIl" with "run model evaluations" — different mental
// modes. A focused overlay accessed via Shift+B or the Tools "Open
// benchmark" link is the cleanest fit.
type Mode = "idle" | "running" | "scoring" | "done" | "error";

// Sub-modes for the customization flow. These swap in/out as small
// inline forms beneath the question list — they never leave the
// overlay, so the user's mental model stays "I'm in the benchmark
// view." Escape from any sub-mode returns to "list".
type PanelMode = "list" | "new" | "import";

interface ProgressEntry {
  id: string;
  status: "start" | "ok" | "error";
  info?: string;
}

export function BenchmarkPanel({ onClose, vaultPath, availableClis, domainNames }: Props) {
  useKeyboard((evt) => {
    if (evt.name === "escape") {
      // Escape from a sub-form drops back to the list. Escape from the
      // list closes the panel entirely. Two-tier Escape matches how
      // the chat input + workspace tabs behave.
      if (panelMode !== "list") {
        setPanelMode("list");
        return;
      }
      onClose();
    }
  });

  // Refresh tick — bumped after any scaffold operation so listQuestions
  // re-reads from disk and the new question shows up in the row list.
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshQuestions = () => setRefreshTick((t) => t + 1);

  const questions = useMemo<CanonicalQuestion[]>(
    () => listQuestions(vaultPath),
    [vaultPath, refreshTick],
  );
  // Highlighted question for "✎ edit highlighted". Clicking any row
  // sets this; defaults to first.
  const [selectedQuestionIdx, setSelectedQuestionIdx] = useState(0);
  const [panelMode, setPanelMode] = useState<PanelMode>("list");
  const [newDomain, setNewDomain] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [customizeMessage, setCustomizeMessage] = useState<string | null>(null);

  function openExistingInFinder(q: CanonicalQuestion) {
    // The OS's default markdown editor (TextEdit / VSCode / Obsidian /
    // whatever the user has configured) opens the file. Doesn't tie us
    // to a specific in-cockpit editor, doesn't unmount the overlay.
    openInFinder(q.filePath);
    setCustomizeMessage(`opened ${q.id}.md in your editor`);
    setTimeout(() => setCustomizeMessage(null), 3000);
  }

  function commitNewQuestion() {
    const domain = newDomain.trim();
    if (!domain) {
      setCustomizeMessage("✗ pick a domain first");
      return;
    }
    try {
      const path = writeDraftQuestion({
        vaultPath,
        domain,
        prompt: newPrompt.trim() || undefined,
      });
      openInFinder(path);
      refreshQuestions();
      setNewDomain("");
      setNewPrompt("");
      setPanelMode("list");
      setCustomizeMessage(`✓ wrote stub — fill in the rest in your editor (${path.split("/").pop()})`);
      setTimeout(() => setCustomizeMessage(null), 5000);
    } catch (err) {
      setCustomizeMessage(`✗ ${(err as Error).message}`);
    }
  }

  function commitImportFrom(domain: string) {
    try {
      const r = seedFromLatestCouncil(vaultPath, domain);
      if (!r) {
        setCustomizeMessage(`✗ no council verdict found under ${domain}/_log/`);
        return;
      }
      openInFinder(r.path);
      refreshQuestions();
      setPanelMode("list");
      setCustomizeMessage(`✓ imported from ${r.sourceFile.split("/").pop()} — edit to mark expected_decision`);
      setTimeout(() => setCustomizeMessage(null), 6000);
    } catch (err) {
      setCustomizeMessage(`✗ ${(err as Error).message}`);
    }
  }
  const [targetIdx, setTargetIdx] = useState(0);
  // Per-CLI multi-select: when the user switches CLI, their previous
  // model selection for that CLI persists. The "" (empty string) entry
  // means "the CLI's default model" — useful when the user just wants
  // to bench whatever's current without pinning a version.
  const [selectedByCli, setSelectedByCli] = useState<Record<string, string[]>>({});
  const [useCouncil, setUseCouncil] = useState(false);
  const [mode, setMode] = useState<Mode>("idle");
  // Per-model results from the most recent multi-model run. Each entry
  // carries the raw records (for the click-to-expand Q/expected/reply
  // drill-down) AND the score. Replaces the old single-result state.
  type ModelResult = {
    cli: CliKind;
    model: string;
    runDir: string;
    records: CanonicalRunRecord[];
    score: RunScore;
  };
  const [results, setResults] = useState<ModelResult[]>([]);
  // Per-(modelKey + questionId) progress + active model display. The
  // active model is whichever one is currently running in the loop —
  // shown above the progress list.
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Click-to-expand a result row: shows the question, expected_decision,
  // and the model's actual reply inline so the user can judge the
  // score themselves instead of trusting the LLM judge.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>(() =>
    buildLeaderboard(vaultPath),
  );
  const abortRef = useRef<AbortController | null>(null);

  const target = availableClis[targetIdx];
  const selectedModels: string[] = target
    ? selectedByCli[target.kind] ?? [""]
    : [];

  // Model picks for the current CLI = quickpicks list + a "(default)"
  // sentinel. We include the default at the TOP so it's the first one
  // toggled on when a user lands on a freshly-switched CLI.
  const modelChoices: string[] = useMemo(() => {
    if (!target) return [];
    const def = defaultModelFor(target.kind);
    const picks = MODEL_QUICKPICKS_FALLBACK[target.kind] ?? [];
    // De-dupe while preserving order: default first, then picks (minus
    // the one that already matches the default).
    const seen = new Set([def]);
    const out = [def];
    for (const p of picks) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  }, [target?.kind]);

  function toggleModel(m: string) {
    if (!target) return;
    setSelectedByCli((prev) => {
      const cur = prev[target.kind] ?? [];
      const next = cur.includes(m)
        ? cur.filter((x) => x !== m)
        : [...cur, m];
      return { ...prev, [target.kind]: next };
    });
  }

  // Refresh leaderboard whenever the multi-model run finishes.
  useEffect(() => {
    if (mode === "done") {
      setLeaderboard(buildLeaderboard(vaultPath));
    }
  }, [mode, vaultPath]);

  async function fireRun() {
    if (!target) {
      setError("no CLI detected — install claude / codex / antigravity / ollama first");
      setMode("error");
      return;
    }
    if (questions.length === 0) {
      setError(`no canonical questions under ${vaultPath}/benchmark/questions/`);
      setMode("error");
      return;
    }
    // No models picked = fall back to the CLI's default (matches single-
    // model behavior pre-v1.5.0 so users who don't bother picking still
    // get a usable run).
    const modelsToRun: string[] =
      selectedModels.length > 0 ? selectedModels : [""];

    setError(null);
    setMode("running");
    setProgress([]);
    setResults([]);
    setExpandedKey(null);

    const controller = new AbortController();
    abortRef.current = controller;

    const collected: ModelResult[] = [];

    try {
      for (let mi = 0; mi < modelsToRun.length; mi++) {
        if (controller.signal.aborted) break;
        const m = modelsToRun[mi]!;
        const label =
          m === "" ? `${target.kind} (default)` : `${target.kind} · ${m}`;
        setActiveModel(`${mi + 1}/${modelsToRun.length} — ${label}`);
        setProgress([]); // reset per-model progress

        const records = await runCanonicalSet({
          vaultPath,
          questions,
          clis: availableClis,
          targetCli: useCouncil ? undefined : target,
          targetModel: m || undefined,
          signal: controller.signal,
          onProgress: (id, status, info) => {
            setProgress((p) => [...p, { id, status, info }]);
          },
        });

        const runDir = writeRunDirectory({
          vaultPath,
          records,
          targetCli: useCouncil ? undefined : target,
          targetModel: m || undefined,
        });

        setMode("scoring");
        const score = await scoreRun({
          vaultPath,
          runDir,
          judgeCli: target,
          signal: controller.signal,
          onProgress: () => {},
        });
        // Keep running, but already commit this model's result so the
        // user can read the partial leaderboard while later models fire.
        collected.push({ cli: target.kind, model: m, runDir, records, score });
        setResults([...collected]);
        setMode("running");
      }
      setActiveModel(null);
      setMode("done");
    } catch (err) {
      const msg = (err as Error)?.message ?? "run failed";
      // Aborts come through as plain "AbortError" — treat as cancelled
      // rather than an error condition.
      if (controller.signal.aborted) {
        setError("cancelled");
      } else {
        setError(msg);
      }
      setMode("error");
    } finally {
      abortRef.current = null;
    }
  }

  function cancelRun() {
    abortRef.current?.abort();
  }

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={theme.aiAccent}
      backgroundColor={theme.bg}
      title=" Benchmark "
      titleAlignment="left"
      bottomTitle=" Esc to close "
      bottomTitleAlignment="right"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <scrollbox flexGrow={1} scrollY>
        <box flexDirection="row">
          <text fg={theme.aiAccent} attributes={1}>{"◈ canonical benchmark"}</text>
          <text fg={theme.fgFaint}>{"     "}</text>
          {/* Click to open <vault>/benchmark/ in the OS file browser.
              Lets the user see questions/ + runs/ + README side by side,
              grep through past run scoreboards, or version-control the
              whole folder externally. Same openInFinder pattern as the
              ConfigBar's ▸ vault chip. */}
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.bgPanel}
            onMouseDown={() => openInFinder(benchmarkRoot(vaultPath))}
          >
            <text fg={theme.aiAccent}>{"▸ open folder"}</text>
          </box>
        </box>
        <text fg={theme.fgFaint}>
          {`${questions.length} questions under ${vaultPath}/benchmark/questions/ — replace any of them with your own via \`prevail bench seed --from-log <domain>\``}
        </text>
        <text> </text>

        {/* Question list — clickable rows, the highlighted one is the
            target of "✎ edit highlighted" below. */}
        <text fg={theme.fgDim} attributes={1}>
          {`questions (${questions.length})`}
        </text>
        {questions.length === 0 && (
          <text fg={theme.warn}>
            {"  no canonical questions yet — use + new question or ▸ import below"}
          </text>
        )}
        {questions.map((q, i) => {
          const active = i === selectedQuestionIdx;
          const fg = active ? theme.gold : theme.fgDim;
          const pointer = active ? "›" : " ";
          return (
            <box
              key={q.id}
              flexDirection="row"
              height={1}
              backgroundColor={active ? theme.selBg : theme.bg}
              onMouseDown={() => setSelectedQuestionIdx(i)}
            >
              <text fg={fg}>
                {` ${pointer} ◆ ${q.id}  ·  ${q.domain}`}
              </text>
            </box>
          );
        })}
        <text> </text>

        {/* CUSTOMIZE — three buttons that let the user grow their
            benchmark over time without leaving the cockpit. Reuses the
            same scaffolding functions as the CLI (writeDraftQuestion,
            seedFromLatestCouncil) so the file format never diverges. */}
        <text fg={theme.fgDim} attributes={1}>{"customize"}</text>
        <box flexDirection="row" paddingTop={0}>
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.bgPanel}
            onMouseDown={() => {
              setPanelMode("new");
              setCustomizeMessage(null);
            }}
          >
            <text fg={theme.aiAccent}>{"+ new question"}</text>
          </box>
          <text fg={theme.fgFaint}>{"  "}</text>
          {questions.length > 0 && (
            <>
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={theme.bgPanel}
                onMouseDown={() => {
                  const q = questions[selectedQuestionIdx];
                  if (q) openExistingInFinder(q);
                }}
              >
                <text fg={theme.goldDim}>{"✎ edit highlighted"}</text>
              </box>
              <text fg={theme.fgFaint}>{"  "}</text>
            </>
          )}
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.bgPanel}
            onMouseDown={() => {
              setPanelMode("import");
              setCustomizeMessage(null);
            }}
          >
            <text fg={theme.aiAccent}>{"▸ import from journal"}</text>
          </box>
        </box>
        {customizeMessage && (
          <text fg={theme.gold}>{`  ${customizeMessage}`}</text>
        )}

        {/* SUB-FORM: new question. Single-line inputs for domain + a
            short prompt. After we write the stub, openInFinder kicks
            the user into their default markdown editor to fill in the
            rest (expected_decision, verdict keywords, full context,
            notes). The CLI-side flow is the same. */}
        {panelMode === "new" && (
          <box flexDirection="column" paddingTop={1} paddingLeft={2}>
            <text fg={theme.aiAccent} attributes={1}>{"+ new canonical question"}</text>
            <text fg={theme.fgFaint}>
              {"  fill in the rest of the fields in your editor after the file opens"}
            </text>
            <text> </text>
            <box flexDirection="row">
              <text fg={theme.fgFaint}>{"  domain:  "}</text>
              <input
                value={newDomain}
                placeholder="e.g. wealth, health, tax"
                maxLength={48}
                backgroundColor={theme.bgPanel}
                textColor={theme.fg}
                onInput={(v: string) => setNewDomain(v)}
              />
            </box>
            <box flexDirection="row">
              <text fg={theme.fgFaint}>{"  prompt:  "}</text>
              <input
                value={newPrompt}
                placeholder="(optional — fillable in the file)"
                maxLength={200}
                backgroundColor={theme.bgPanel}
                textColor={theme.fg}
                onInput={(v: string) => setNewPrompt(v)}
              />
            </box>
            <text> </text>
            <box flexDirection="row">
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={theme.selBg}
                onMouseDown={commitNewQuestion}
              >
                <text fg={theme.gold} attributes={1}>{"▸ write stub & open in editor"}</text>
              </box>
              <text fg={theme.fgFaint}>{"   "}</text>
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={theme.bgPanel}
                onMouseDown={() => setPanelMode("list")}
              >
                <text fg={theme.fgDim}>{"cancel"}</text>
              </box>
            </box>
            <text> </text>
          </box>
        )}

        {/* SUB-FORM: import from journal. Pick a domain whose _log/
            you want to pull the most recent council verdict from.
            seedFromLatestCouncil walks the latest <date>.md, finds the
            last "⚖ council" section, and pre-fills a draft with the
            prompt + verdict in the Notes section — the user only has
            to type the expected_decision + keywords. */}
        {panelMode === "import" && (
          <box flexDirection="column" paddingTop={1} paddingLeft={2}>
            <text fg={theme.aiAccent} attributes={1}>{"▸ import latest council verdict"}</text>
            <text fg={theme.fgFaint}>
              {"  pick a domain — we'll find its most recent ⚖ council entry in _log/ and seed a draft"}
            </text>
            <text> </text>
            {domainNames.length === 0 ? (
              <text fg={theme.warn}>{"  no domains in the vault yet."}</text>
            ) : (
              domainNames.map((d) => (
                <box
                  key={d}
                  flexDirection="row"
                  height={1}
                  paddingLeft={2}
                  onMouseDown={() => commitImportFrom(d)}
                >
                  <text fg={theme.aiAccent}>{`  ▸ ${d}`}</text>
                </box>
              ))
            )}
            <text> </text>
            <box
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.bgPanel}
              onMouseDown={() => setPanelMode("list")}
            >
              <text fg={theme.fgDim}>{"cancel"}</text>
            </box>
            <text> </text>
          </box>
        )}
        <text> </text>

        {/* Run form */}
        <text fg={theme.fgDim} attributes={1}>{"run a new benchmark"}</text>
        <box flexDirection="row" paddingTop={0}>
          <text fg={theme.fgFaint}>{"  target:  "}</text>
          {availableClis.length === 0 ? (
            <text fg={theme.warn}>{"no CLIs detected"}</text>
          ) : (
            availableClis.map((c, i) => (
              <box
                key={c.kind}
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                onMouseDown={() => setTargetIdx(i)}
              >
                <text fg={i === targetIdx ? theme.aiAccent : theme.fgDim} attributes={i === targetIdx ? 1 : 0}>
                  {i === targetIdx ? `▸ ${c.label}` : `  ${c.label}`}
                </text>
              </box>
            ))
          )}
        </box>
        <box flexDirection="row" paddingTop={0}>
          <text fg={theme.fgFaint}>{"  models:  "}</text>
          <text fg={theme.fg}>
            {selectedModels.length === 0
              ? "(none — will use CLI default)"
              : `${selectedModels.length} selected · click chips to toggle`}
          </text>
        </box>
        {/* Multi-select chip picker. Each model from this CLI's
            quickpicks list is its own clickable chip. Selected chips
            get a ✓ + selBg highlight. The default model is pinned at
            the top so users who don't care about specific versions
            still get a meaningful pick. */}
        <box flexDirection="row" paddingTop={0} paddingLeft={2}>
          <text fg={theme.fgFaint}>{" "}</text>
        </box>
        {modelChoices.length > 0 && (
          <box flexDirection="column" paddingLeft={4}>
            {modelChoices.map((m) => {
              const checked = selectedModels.includes(m);
              const isDefault = target ? m === defaultModelFor(target.kind) : false;
              const labelTxt = isDefault ? `${m} (default)` : m;
              return (
                <box
                  key={m}
                  flexDirection="row"
                  height={1}
                  backgroundColor={checked ? theme.selBg : theme.bg}
                  onMouseDown={() => toggleModel(m)}
                >
                  <text fg={checked ? theme.aiAccent : theme.fgDim} attributes={checked ? 1 : 0}>
                    {`  ${checked ? "✓" : "·"} ${labelTxt}`}
                  </text>
                </box>
              );
            })}
          </box>
        )}
        <box flexDirection="row" paddingTop={0}>
          <text fg={theme.fgFaint}>{"  council: "}</text>
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            onMouseDown={() => setUseCouncil((v) => !v)}
          >
            <text fg={useCouncil ? theme.aiAccent : theme.fgDim} attributes={useCouncil ? 1 : 0}>
              {useCouncil ? "[x] fan out to council" : "[ ] fan out to council"}
            </text>
          </box>
        </box>
        <text> </text>

        <box flexDirection="row">
          {mode === "idle" || mode === "done" || mode === "error" ? (
            <box
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.selBg}
              onMouseDown={() => void fireRun()}
            >
              <text fg={theme.gold} attributes={1}>
                {`▸ run ${selectedModels.length || 1} model${(selectedModels.length || 1) === 1 ? "" : "s"} × ${questions.length} question${questions.length === 1 ? "" : "s"}`}
              </text>
            </box>
          ) : (
            <box
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.bgPanel}
              onMouseDown={cancelRun}
            >
              <text fg={theme.warn} attributes={1}>{"✕ cancel"}</text>
            </box>
          )}
        </box>
        <text> </text>

        {/* Progress / status */}
        {(mode === "running" || mode === "scoring") && activeModel && (
          <text fg={theme.gold} attributes={1}>{`▸ ${activeModel}`}</text>
        )}
        {mode === "running" && (
          <>
            <text fg={theme.fgDim} attributes={1}>{`progress (${progress.filter((p) => p.status === "ok" || p.status === "error").length}/${questions.length})`}</text>
            {progress.map((p, i) => {
              const fg =
                p.status === "ok" ? theme.ok : p.status === "error" ? theme.warn : theme.fgFaint;
              const glyph = p.status === "ok" ? "✓" : p.status === "error" ? "✗" : "·";
              return (
                <text key={`${p.id}-${i}`} fg={fg}>
                  {`  ${glyph} ${p.id}  ${p.info ?? ""}`}
                </text>
              );
            })}
            <text> </text>
          </>
        )}
        {mode === "scoring" && (
          <text fg={theme.gold}>{"scoring run via LLM judge…"}</text>
        )}
        {mode === "error" && error && (
          <text fg={theme.warn}>{`✗ ${error}`}</text>
        )}

        {/* Per-model results with click-to-expand drill-down. The user
            asked: "what was the question, expected answer, what did
            the model say?" — that's what the expanded view shows. */}
        {results.length > 0 && (
          <>
            <text fg={theme.aiAccent} attributes={1}>{`◈ results — ${results.length} model${results.length === 1 ? "" : "s"}`}</text>
            <text fg={theme.fgFaint}>{"  click any question row to see the prompt + expected decision + model's reply"}</text>
            <text> </text>
            {results.map((r) => {
              const modelLabel = r.model === "" ? `${r.cli} (default)` : `${r.cli} · ${r.model}`;
              return (
                <box key={`${r.cli}-${r.model}`} flexDirection="column">
                  <text fg={theme.gold} attributes={1}>{`  ${modelLabel}`}</text>
                  <text fg={theme.fg}>
                    {`    keyword_avg: ${r.score.keyword_avg ?? "—"}%   judge_avg: ${r.score.judge_avg ?? "—"} / 10   (${r.score.questionScores.length} questions)`}
                  </text>
                  <text fg={theme.fgFaint}>{`    full report: ${r.runDir}/score.md`}</text>
                  {r.score.questionScores.map((q) => {
                    const key = `${r.cli}-${r.model}-${q.id}`;
                    const expanded = expandedKey === key;
                    // Look up the original question + the model's record
                    // for this question. Lazy: we already have them in
                    // memory from the run, no need to re-read disk.
                    const question = questions.find((qq) => qq.id === q.id);
                    const record = r.records.find((rec) => rec.id === q.id);
                    return (
                      <box key={key} flexDirection="column">
                        <box
                          flexDirection="row"
                          height={1}
                          onMouseDown={() => setExpandedKey(expanded ? null : key)}
                        >
                          <text fg={theme.fgDim}>
                            {`    ${expanded ? "▾" : "▸"} ${q.id.padEnd(36)}  ${(q.keyword_score ?? "—").toString().padStart(4)}%  ${q.judge_score === null ? "—" : `${q.judge_score}/10`}  ${q.judge_rationale ?? ""}`}
                          </text>
                        </box>
                        {expanded && (
                          <box flexDirection="column" paddingLeft={8} paddingTop={1} paddingBottom={1}>
                            <text fg={theme.fgDim} attributes={1}>{"question"}</text>
                            <text fg={theme.fg}>
                              {question?.prompt ?? "(question file not loaded)"}
                            </text>
                            {question?.context && (
                              <>
                                <text> </text>
                                <text fg={theme.fgDim} attributes={1}>{"context"}</text>
                                <text fg={theme.fg}>{question.context}</text>
                              </>
                            )}
                            <text> </text>
                            <text fg={theme.fgDim} attributes={1}>{"expected decision"}</text>
                            <text fg={theme.ok}>
                              {question?.expected_decision ?? "(no expected_decision set)"}
                            </text>
                            {question?.expected_verdict_keywords && (
                              <text fg={theme.fgFaint}>
                                {`keywords: ${question.expected_verdict_keywords.join(", ")}`}
                              </text>
                            )}
                            <text> </text>
                            <text fg={theme.fgDim} attributes={1}>{"model said"}</text>
                            <text fg={theme.fg}>
                              {record?.reply || "(empty reply or error)"}
                            </text>
                            <text> </text>
                            <text fg={theme.fgDim} attributes={1}>{"keyword scoring"}</text>
                            <text fg={theme.ok}>{`  ✓ hit:  ${q.keyword_hits.join(", ") || "(none)"}`}</text>
                            <text fg={theme.warn}>{`  ✗ miss: ${q.keyword_misses.join(", ") || "(none)"}`}</text>
                            {q.judge_rationale && (
                              <>
                                <text> </text>
                                <text fg={theme.fgDim} attributes={1}>{`judge rationale (${q.judge_score}/10)`}</text>
                                <text fg={theme.fg}>{q.judge_rationale}</text>
                              </>
                            )}
                          </box>
                        )}
                      </box>
                    );
                  })}
                  <text> </text>
                </box>
              );
            })}
          </>
        )}

        {/* Leaderboard across all prior runs */}
        <text fg={theme.aiAccent} attributes={1}>{"◈ leaderboard"}</text>
        {leaderboard.length === 0 ? (
          <text fg={theme.fgFaint}>
            {"  no scored runs yet. run a benchmark above and the result lands here."}
          </text>
        ) : (
          <>
            <text fg={theme.fgDim}>{"  judge / 10  keyword %  questions  label"}</text>
            <text fg={theme.fgFaint}>{"  ----------  ---------  ---------  ------------------------------"}</text>
            {leaderboard.map((e) => {
              const j = e.judge_avg === null ? "—" : e.judge_avg.toFixed(1);
              const k = e.keyword_avg === null ? "—" : `${e.keyword_avg}%`;
              return (
                <text key={e.label} fg={theme.fg}>
                  {`  ${j.padStart(10)}  ${k.padStart(9)}  ${String(e.questions).padStart(9)}  ${e.label}`}
                </text>
              );
            })}
          </>
        )}
      </scrollbox>
    </box>
  );
}
