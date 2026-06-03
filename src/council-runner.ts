import {
  runChatTurn,
  type AvailableCli,
  type CliHealth,
} from "./cli-bridge.ts";
import { readCouncilConfig } from "./config.ts";
import { formatRecallContext, recall, type MemoryHit } from "./memory.ts";

export interface CouncilPanelist {
  cli: AvailableCli;
  model: string;
}

export interface PanelResult {
  cli: AvailableCli;
  model: string;
  ok: boolean;
  reply: string;
  ms: number;
}

export interface CouncilResult {
  panel: PanelResult[];
  verdict: string;
  chairLabel: string;
  degraded: boolean; // true when fewer than 2 distinct CLI kinds responded
}

// Build the panelist list from saved config + available CLIs. Same shape
// app.tsx uses, factored out so the daemon can build the same panel without
// duplicating the logic. Health-skipping is done by the caller — health is a
// state concept that lives near the TUI/daemon, not here.
export function buildCouncilPanel(clis: AvailableCli[]): CouncilPanelist[] {
  const cfg = readCouncilConfig();
  let activeClis = clis;
  if (cfg.clis && cfg.clis.length > 0) {
    activeClis = clis.filter((c) => cfg.clis!.includes(c.kind));
  }
  const panelists: CouncilPanelist[] = [];
  for (const cli of activeClis) {
    const variants = cfg.models[cli.kind] ?? [""];
    for (const m of variants) {
      panelists.push({ cli, model: m });
    }
  }
  return panelists;
}

const PANELIST_TIMEOUT_MS = 120_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// One-shot council fanout: fire prompt at every panelist in parallel, then
// synthesize a verdict using the chair model (or the first successful
// panelist if no chair pinned / chair unavailable). Returns structured
// result with panel responses + final verdict.
//
// Designed for headless use (daemon, scheduled briefings, future API). The
// TUI has its own runCouncil with React state plumbing; this version
// returns plain data so any frontend can render it. The interfaces are
// kept simple on purpose — no streaming, no incremental updates. v2 can
// add an AsyncIterable variant if we need live progress in the daemon.
export async function runCouncilOneShot(args: {
  prompt: string;
  cwd: string;
  panelists: CouncilPanelist[];
  cliHealth?: Map<string, CliHealth | null>;
  signal?: AbortSignal;
  // Per-panelist streaming. When set, each chunk from any panelist is
  // forwarded with (panelistIdx, delta) so the caller (TUI / Telegram /
  // MCP) can update the right bubble. Chair synthesis chunks come back
  // with panelistIdx === -1.
  onPanelistChunk?: (panelistIdx: number, delta: string) => void;
  // Vault root for memory recall. When set AND an embedder is available,
  // the top-k semantically-similar prior decisions are prepended to the
  // panelist prompt as a <context> block. Disabled (or no embedder) = no
  // recall, identical behavior to v0.4.
  vaultPath?: string;
  recallK?: number;
}): Promise<CouncilResult> {
  // Drop unhealthy panelists if health was passed.
  const healthy = args.cliHealth
    ? args.panelists.filter((p) => {
        const h = args.cliHealth!.get(p.cli.kind);
        return !h || h.ok;
      })
    : args.panelists;

  if (healthy.length === 0) {
    return {
      panel: [],
      verdict: "(no panelists available — all configured CLIs failed their probe)",
      chairLabel: "",
      degraded: true,
    };
  }

  // Memory recall — best-effort, silent on failure. When Ollama isn't up
  // (no embedder), recall() returns [] and we proceed without context.
  // When it does hit, we prepend the top-k prior decisions so each
  // panelist sees what you decided before on similar questions.
  let recallContext = "";
  let recallHits: MemoryHit[] = [];
  if (args.vaultPath) {
    try {
      recallHits = await recall({
        vaultPath: args.vaultPath,
        query: args.prompt,
        k: args.recallK ?? 3,
        signal: args.signal,
      });
      recallContext = formatRecallContext(recallHits);
    } catch {
      /* embedder unavailable — fall through with no recall */
    }
  }
  const enriched = recallContext ? `${recallContext}\n\n${args.prompt}` : args.prompt;

  // Fan out in parallel. Each panelist runs in a separate runChatTurn —
  // shared abort signal means a single cancel kills the whole batch.
  const panel: PanelResult[] = await Promise.all(
    healthy.map(async (p, idx) => {
      const start = Date.now();
      try {
        const reply = await withTimeout(
          runChatTurn({
            prompt: enriched,
            cwd: args.cwd,
            cli: p.cli,
            model: p.model,
            isFirst: true,
            bare: true,
            signal: args.signal,
            onChunk: args.onPanelistChunk
              ? (delta) => args.onPanelistChunk!(idx, delta)
              : undefined,
          }),
          PANELIST_TIMEOUT_MS,
          `${p.cli.label}${p.model ? `·${p.model}` : ""}`,
        );
        return {
          cli: p.cli,
          model: p.model,
          ok: !reply.startsWith("(") || !reply.includes("error"),
          reply,
          ms: Date.now() - start,
        };
      } catch (err) {
        return {
          cli: p.cli,
          model: p.model,
          ok: false,
          reply: `(error: ${(err as Error).message})`,
          ms: Date.now() - start,
        };
      }
    }),
  );

  const good = panel.filter((r) => r.ok && !r.reply.startsWith("("));
  const distinctClis = new Set(panel.map((p) => p.cli.kind));
  const degraded = distinctClis.size < 2;

  if (good.length === 0) {
    return {
      panel,
      verdict: "(no panelist produced a usable reply — see panel output for errors)",
      chairLabel: "",
      degraded,
    };
  }
  if (good.length === 1) {
    // Single-respondent council — no synthesis needed, just surface the
    // one reply as the verdict.
    return {
      panel,
      verdict: good[0]!.reply,
      chairLabel: `${good[0]!.cli.label} (sole respondent)`,
      degraded: true,
    };
  }

  // Synthesis. Pick the chair: prefer the config-pinned chair if its CLI
  // is in the panel; otherwise use the first successful panelist.
  const cfg = readCouncilConfig();
  let chairCli = good[0]!.cli;
  let chairModel = "";
  let chairLabel = `${chairCli.label}${good[0]!.model ? `·${good[0]!.model}` : ""}`;
  if (cfg.chair) {
    const candidate = panel.find((p) => p.cli.kind === cfg.chair!.cli);
    if (candidate) {
      chairCli = candidate.cli;
      chairModel = cfg.chair.model ?? "";
      chairLabel = `${chairCli.label}${chairModel ? `·${chairModel}` : ""}`;
    }
  }

  const panelistList = good
    .map((c) => (c.model ? `${c.cli.label}·${c.model}` : c.cli.label))
    .join(", ");
  // SECURITY: panelist replies are LLM-generated text that may itself contain
  // markdown headers, including a counterfeit "## Verdict" section designed
  // to hijack the chair's synthesis or the downstream parseVerdict matcher.
  // We block-quote any line that would otherwise be a chair-level heading so
  // the embedded content can never masquerade as chair output. The chair
  // still reads the content fine — it just can't be confused for structure.
  const panelBlock = good
    .map((c) => {
      const tag = c.model ? `${c.cli.label}·${c.model}` : c.cli.label;
      const sanitized = c.reply.trim().replace(/^(##\s)/gm, "(panelist) $1");
      return `--- ${tag} ---\n${sanitized}`;
    })
    .join("\n\n");

  const synthPrompt =
    `You are the chair of an AI council. ${good.length} independent panelists (${panelistList}) just answered the same user question. ` +
    `Your job: show what each panelist said and why, name the consensus, name the divergence, then deliver one decisive verdict with the reasoning tied back to the panelists. Do not hedge — pick a side.\n\n` +
    `USER QUESTION:\n${args.prompt}\n\n` +
    `PANEL RESPONSES:\n${panelBlock}\n\n` +
    `MAJORITY RULE — read carefully:\n` +
    `When panelists give different concrete answers to the same factual question (a specific date, number, dollar amount, name, yes/no call, recommended action), the verdict MUST side with the majority answer. The minority position only wins if it cites a hard external fact the majority got demonstrably wrong; if you invoke this exception, name the fact explicitly in Divergence and Why.\n\n` +
    `Output exactly these four sections in this order, no preamble:\n\n` +
    `## What each panelist said\n` +
    `One bullet per panelist using their label exactly as shown above. Format: "**<label>**: <concrete answer in <=1 sentence> — <key reason in <=1 sentence>>". Include any cited source/date/number verbatim.\n\n` +
    `## Consensus\n` +
    `Bulleted list of every concrete point the panel agreed on. If they disagreed on everything, write "None — see divergence."\n\n` +
    `## Divergence\n` +
    `Bulleted list of substantive disagreements. For each bullet, name which panelist took which side and a vote tally. Skip stylistic differences.\n\n` +
    `## Verdict\n` +
    `Two lines. Line 1 starts with "VERDICT:" + one sentence giving the decisive call. Line 2 starts with "Why:" + one sentence tying the call back to panelists by name.`;

  try {
    const verdict = await withTimeout(
      runChatTurn({
        prompt: synthPrompt,
        cwd: args.cwd,
        cli: chairCli,
        model: chairModel,
        isFirst: true,
        bare: true,
        signal: args.signal,
        // Chair chunks use panelistIdx === -1 so the UI can render the
        // verdict bubble in real time as the chair synthesizes.
        onChunk: args.onPanelistChunk ? (delta) => args.onPanelistChunk!(-1, delta) : undefined,
      }),
      PANELIST_TIMEOUT_MS,
      `${chairCli.label} (synthesis)`,
    );
    return { panel, verdict, chairLabel, degraded };
  } catch (err) {
    return {
      panel,
      verdict: `(synthesis failed: ${(err as Error).message})`,
      chairLabel,
      degraded,
    };
  }
}
