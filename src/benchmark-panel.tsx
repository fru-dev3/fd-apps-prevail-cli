import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "./theme.ts";
import {
  buildLeaderboard,
  listQuestions,
  runCanonicalSet,
  scoreRun,
  writeRunDirectory,
  type CanonicalQuestion,
  type CanonicalRunRecord,
  type LeaderboardEntry,
  type RunScore,
} from "./canonical-bench.ts";
import { type AvailableCli } from "./cli-bridge.ts";

interface Props {
  onClose: () => void;
  vaultPath: string;
  // The cockpit already detected these at boot — reuse so the panel
  // doesn't re-probe and we get a fast open.
  availableClis: AvailableCli[];
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

interface ProgressEntry {
  id: string;
  status: "start" | "ok" | "error";
  info?: string;
}

export function BenchmarkPanel({ onClose, vaultPath, availableClis }: Props) {
  useKeyboard((evt) => {
    if (evt.name === "escape") onClose();
  });

  const questions = useMemo<CanonicalQuestion[]>(
    () => listQuestions(vaultPath),
    [vaultPath],
  );
  const [targetIdx, setTargetIdx] = useState(0);
  const [model, setModel] = useState("");
  const [useCouncil, setUseCouncil] = useState(false);
  const [mode, setMode] = useState<Mode>("idle");
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [latestScore, setLatestScore] = useState<RunScore | null>(null);
  const [latestRunDir, setLatestRunDir] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>(() =>
    buildLeaderboard(vaultPath),
  );
  const abortRef = useRef<AbortController | null>(null);

  const target = availableClis[targetIdx];

  // Refresh leaderboard whenever a run finishes.
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
    setError(null);
    setMode("running");
    setProgress([]);
    setLatestScore(null);
    setLatestRunDir(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const records = await runCanonicalSet({
        vaultPath,
        questions,
        clis: availableClis,
        targetCli: useCouncil ? undefined : target,
        targetModel: model.trim() || undefined,
        signal: controller.signal,
        onProgress: (id, status, info) => {
          setProgress((p) => [...p, { id, status, info }]);
        },
      });

      const runDir = writeRunDirectory({
        vaultPath,
        records,
        targetCli: useCouncil ? undefined : target,
        targetModel: model.trim() || undefined,
      });
      setLatestRunDir(runDir);

      // Score immediately. The chair CLI is whichever target was used —
      // imperfect (a model judging itself), but matches the CLI-side
      // default and avoids requiring a second CLI to be installed.
      setMode("scoring");
      const result = await scoreRun({
        vaultPath,
        runDir,
        judgeCli: target,
        signal: controller.signal,
        onProgress: () => {
          // No per-question scoring progress display for now; runs are
          // typically <30s of judging total.
        },
      });
      setLatestScore(result);
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
        <text fg={theme.aiAccent} attributes={1}>{"◈ canonical benchmark"}</text>
        <text fg={theme.fgFaint}>
          {`${questions.length} questions under ${vaultPath}/benchmark/questions/ — replace any of them with your own via \`prevail bench seed --from-log <domain>\``}
        </text>
        <text> </text>

        {/* Question list — read-only, just orientation. */}
        <text fg={theme.fgDim} attributes={1}>{"questions"}</text>
        {questions.length === 0 && (
          <text fg={theme.warn}>
            {"  no canonical questions found. run `prevail bench seed --domain <name>` to add some."}
          </text>
        )}
        {questions.map((q) => (
          <text key={q.id} fg={theme.fgDim}>
            {`  ◆ ${q.id}  ·  ${q.domain}`}
          </text>
        ))}
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
          <text fg={theme.fgFaint}>{"  model:   "}</text>
          <input
            placeholder="(blank = CLI default)"
            value={model}
            maxLength={120}
            backgroundColor={theme.bgPanel}
            textColor={theme.fg}
            onInput={(v: string) => setModel(v)}
          />
        </box>
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
                {`▸ run ${questions.length} question${questions.length === 1 ? "" : "s"}`}
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

        {/* Result of the just-completed run */}
        {latestScore && (
          <>
            <text fg={theme.aiAccent} attributes={1}>{`◈ result — ${latestScore.label}`}</text>
            <text fg={theme.fg}>
              {`  keyword_avg: ${latestScore.keyword_avg ?? "—"}%   judge_avg: ${latestScore.judge_avg ?? "—"} / 10   (${latestScore.questionScores.length} questions)`}
            </text>
            <text fg={theme.fgFaint}>
              {latestRunDir
                ? `  full report: ${latestRunDir}/score.md`
                : "  (no run directory)"}
            </text>
            <text> </text>
            <text fg={theme.fgDim} attributes={1}>{"per-question scores"}</text>
            {latestScore.questionScores.map((q) => (
              <text key={q.id} fg={theme.fgDim}>
                {`  ${q.id.padEnd(36)}  ${(q.keyword_score ?? "—").toString().padStart(4)}%  ${q.judge_score === null ? "—" : `${q.judge_score}/10`}  ${q.judge_rationale ?? ""}`}
              </text>
            ))}
            <text> </text>
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
