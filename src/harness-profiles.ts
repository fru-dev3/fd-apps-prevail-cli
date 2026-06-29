// harness-profiles — per-harness headless invocation specs.
//
// Harnesses (Hermes, Pi, OpenCode, OpenClaw) are self-driving agents, not chat
// models: invoking them with a prompt runs THEIR own tool/agent loop and returns
// a result. Each one's headless invocation differs, so the old one-size
// `<bin> -p "<prompt>"` convention (cli-bridge.ts) was wrong for most of them —
// verified against each CLI's --help:
//
//   hermes    hermes -z "<prompt>" [-m <model>] [--safe-mode | --yolo]   (-p invalid)
//   pi        pi -p [--model <m>] "<prompt>"                              (-p == non-interactive)
//   opencode  opencode run "<message>" [--model <m>]
//   openclaw  (not installed locally) — no known headless flag yet; falls back
//             to the generic `-p` convention in cli-bridge until verified.
//
// `autonomy` maps to each harness's own permission switch where one exists:
//   "safe" → read-and-propose (e.g. Hermes --safe-mode); the default.
//   "auto" → full agency (e.g. Hermes --yolo); only after the broker gate
//            (broker.ts) has cleared the action.
// Harnesses without an explicit switch (pi, opencode) run with their default
// permissions; the Prevail-level gate is still the real guardrail (a blocked
// action is never dispatched at all).

export type HarnessAutonomy = "safe" | "auto";

export interface HarnessArgsInput {
  prompt: string;
  model: string;
  autonomy: HarnessAutonomy;
}

export interface HarnessProfile {
  // Build the argument list (excluding the binary itself) for a headless run.
  buildArgs(input: HarnessArgsInput): string[];
}

export const HARNESS_PROFILES: Record<string, HarnessProfile> = {
  hermes: {
    buildArgs: ({ prompt, model, autonomy }) => {
      const a: string[] = [];
      if (model) a.push("-m", model);
      a.push(autonomy === "auto" ? "--yolo" : "--safe-mode");
      a.push("-z", prompt);
      return a;
    },
  },
  pi: {
    buildArgs: ({ prompt, model }) => {
      // Pi has no single safe/yolo switch; default tools apply. Text mode keeps
      // the streamed stdout human-readable (not JSON), matching the desktop's
      // delta renderer.
      const a: string[] = ["-p"];
      if (model) a.push("--model", model);
      a.push(prompt);
      return a;
    },
  },
  opencode: {
    buildArgs: ({ prompt, model }) => {
      const a: string[] = ["run"];
      if (model) a.push("--model", model);
      a.push(prompt);
      return a;
    },
  },
  // OpenClaw is a Claude-protocol gateway harness. NOT verified against a local
  // install yet (flags unconfirmed) — this mirrors the de-facto headless `-p`
  // convention so it's at least dispatched explicitly. No known safe/yolo switch,
  // so autonomy isn't mapped here; the Prevail broker gate remains the guardrail.
  // Correct these args once `openclaw --help` can be checked on a real install.
  openclaw: {
    buildArgs: ({ prompt, model }) => {
      const a: string[] = [];
      if (model) a.push("--model", model);
      a.push("-p", prompt);
      return a;
    },
  },
};

export function isHarness(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(HARNESS_PROFILES, kind);
}

// Returns the headless args for a known harness, or null if this kind has no
// profile yet (caller should fall back to the generic convention).
export function buildHarnessArgs(kind: string, input: HarnessArgsInput): string[] | null {
  const profile = HARNESS_PROFILES[kind];
  return profile ? profile.buildArgs(input) : null;
}
