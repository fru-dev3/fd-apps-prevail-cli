import type { AvailableCli, CliKind } from "../cli-bridge.ts";
import type { Domain, ViewKey } from "../vault.ts";

export type ChatSeed =
  | "tab"
  | { kind: "skill"; id: string; title: string }
  | { kind: "app"; id: string; title: string; domains: string[] };

export interface ChatMsg {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  kind?:
    | "distill-draft"
    | "distill-saved"
    | "distill-discarded"
    | "council-config"
    | "council-pending"
    | "council-response"
    | "council-synthesizing"
    | "council-verdict"
    // Live-updating assistant bubble during streaming. Replaced with a
    // normal "assistant" message when the stream finishes. Used by the
    // single-CLI chat path; council uses its own panelist-streaming flow.
    | "streaming"
    // Post-turn serendipity injection (Option B). After the main reply
    // lands, an extra lightweight call asks the same CLI for one
    // non-obvious adjacent angle. Result lands here as its own dim
    // bubble so it doesn't pollute the main answer.
    | "serendipity"
    // Auto-council classifier said "this looks council-worthy" while
    // running in `suggest` mode. content carries the ORIGINAL prompt
    // so a click on the bubble can re-run it through runCouncil.
    | "council-suggestion";
  cli?: CliKind; // for council-response bubbles
  model?: string;
  // Captured at SEND TIME so the per-bubble badge can render what was
  // active when THIS turn fired — not the current global state. The user
  // may have cycled framework/lens chips between turns, and the badge has
  // to be loyal to the moment, not the latest config.
  // Stored as display labels (e.g. "BLUF", "CONTRARIAN") rather than ids
  // so rendering is a straight string concat — no lookup at draw time.
  framework?: string;
  lens?: string;
}

export interface ChatSession {
  key: string;
  label: string;
  hostDomain: Domain;
  cli: AvailableCli;
  model: string;
  seed: ChatSeed;
  initialView: ViewKey;
  messages: ChatMsg[];
  pending: boolean;
  hasFirstTurn: boolean;
  sessionId: string;
  // Per-session usage counter for the status-line meter. calls = total CLI
  // spawns (council fires N+1 per question for N panelists + chair).
  // promptChars + replyChars are coarse proxies for cost — exact tokens
  // would require per-CLI envelope parsing which the wrappers don't all
  // expose consistently. Used only for display; never persisted.
  usage: { calls: number; promptChars: number; replyChars: number };
}

export type ChatCommand =
  | { kind: "switch-cli"; cli: CliKind; model?: string }
  | { kind: "switch-model"; model: string }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "help" }
  | { kind: "distill" }
  | { kind: "accept-distill"; ts: number; content: string }
  | { kind: "discard-distill"; ts: number }
  | { kind: "search"; query: string }
  | { kind: "history"; limit?: number }
  | { kind: "web"; mode: "allow" | "deny" | "status" }
  | { kind: "council"; prompt: string }
  | { kind: "council-config" }
  | { kind: "council-mode-toggle" }
  | { kind: "council-use"; clis: string[] }
  | { kind: "council-model"; cli: string; model: string }
  | { kind: "council-chair"; cli: string; model: string }
  | { kind: "heatmap"; days?: number }
  | { kind: "watch"; limit?: number }
  | { kind: "framework"; id: string }
  | { kind: "gut"; text: string }
  | { kind: "calibration"; sub: string; arg: string }
  | { kind: "telegram"; sub: string; arg: string }
  | { kind: "briefing"; sub: string; arg: string }
  | { kind: "connectors" }
  | { kind: "connector-oauth"; id: string }
  | { kind: "connector-test"; id: string }
  | { kind: "unknown"; raw: string };
