import { describe, expect, test } from "bun:test";
import {
  buildCliArgs,
  detectClis,
  extractCodexReply,
  extractGeminiReply,
  runOllamaChat,
} from "./cli-bridge.ts";

describe("buildCliArgs", () => {
  const PROMPT = "Reply with: pong";

  describe("claude", () => {
    test("first turn, no model, no manual", () => {
      const args = buildCliArgs({
        cli: "claude",
        prompt: PROMPT,
        model: "",
        isFirst: true,
        manual: null,
      });
      expect(args).toEqual(["-p", PROMPT]);
    });

    test("first turn with model and manual", () => {
      const args = buildCliArgs({
        cli: "claude",
        prompt: PROMPT,
        model: "opus",
        isFirst: true,
        manual: "OPERATING MANUAL CONTENT",
      });
      expect(args).toEqual([
        "--model",
        "opus",
        "--append-system-prompt",
        "OPERATING MANUAL CONTENT",
        "-p",
        PROMPT,
      ]);
    });

    test("continue turn uses --continue (no system-prompt re-injection)", () => {
      const args = buildCliArgs({
        cli: "claude",
        prompt: PROMPT,
        model: "",
        isFirst: false,
        manual: "MANUAL",
      });
      expect(args).toEqual(["--continue", "-p", PROMPT]);
    });
  });

  describe("codex", () => {
    test("includes --skip-git-repo-check so vault dirs (non-git) work", () => {
      const args = buildCliArgs({
        cli: "codex",
        prompt: PROMPT,
        model: "",
        isFirst: true,
        manual: null,
      });
      expect(args[0]).toBe("exec");
      expect(args).toContain("--skip-git-repo-check");
    });

    test("passes -m model when set", () => {
      const args = buildCliArgs({
        cli: "codex",
        prompt: PROMPT,
        model: "gpt-5-codex",
        isFirst: true,
        manual: null,
      });
      const mIdx = args.indexOf("-m");
      expect(mIdx).toBeGreaterThanOrEqual(0);
      expect(args[mIdx + 1]).toBe("gpt-5-codex");
    });

    test("prompt is the final positional arg", () => {
      const args = buildCliArgs({
        cli: "codex",
        prompt: PROMPT,
        model: "",
        isFirst: true,
        manual: null,
      });
      expect(args[args.length - 1]).toBe(PROMPT);
    });

    test("manual is dropped — codex has no system-prompt channel and echoes the prompt", () => {
      const args = buildCliArgs({
        cli: "codex",
        prompt: PROMPT,
        model: "",
        isFirst: true,
        manual: "MANUAL CONTENT",
      });
      const last = args[args.length - 1] ?? "";
      expect(last).toBe(PROMPT);
      expect(last).not.toContain("<operating-manual>");
      expect(last).not.toContain("MANUAL CONTENT");
    });
  });

  describe("antigravity (agy)", () => {
    test("includes --dangerously-skip-permissions so vault dirs work", () => {
      const args = buildCliArgs({
        cli: "antigravity",
        prompt: PROMPT,
        model: "",
        isFirst: true,
        manual: null,
      });
      expect(args).toContain("--dangerously-skip-permissions");
    });

    test("passes --model when set, then -p prompt", () => {
      const args = buildCliArgs({
        cli: "antigravity",
        prompt: PROMPT,
        model: "Gemini 3.1 Pro (High)",
        isFirst: true,
        manual: null,
      });
      const mIdx = args.indexOf("--model");
      const pIdx = args.indexOf("-p");
      expect(mIdx).toBeGreaterThanOrEqual(0);
      expect(args[mIdx + 1]).toBe("Gemini 3.1 Pro (High)");
      expect(pIdx).toBeGreaterThan(mIdx);
      expect(args[pIdx + 1]).toBe(PROMPT);
    });

    test("default model uses just -p prompt", () => {
      const args = buildCliArgs({
        cli: "antigravity",
        prompt: PROMPT,
        model: "",
        isFirst: true,
        manual: null,
      });
      const pIdx = args.indexOf("-p");
      expect(pIdx).toBeGreaterThanOrEqual(0);
      expect(args[pIdx + 1]).toBe(PROMPT);
    });
  });
});

describe("runOllamaChat", () => {
  // Ollama daemon won't be running in CI / under `bun test`, so these tests
  // just verify the error-path returns a string (not a thrown exception) so
  // a council fanout with ollama in the panel doesn't crash the whole batch.
  test("unreachable endpoint returns a string error, doesn't throw", async () => {
    const r = await runOllamaChat({
      baseUrl: "http://127.0.0.1:1",
      model: "llama3.1",
      prompt: "hi",
    });
    expect(typeof r).toBe("string");
    expect(r).toMatch(/^\(ollama:/);
  });

  test("pre-aborted signal returns (cancelled), not a thrown abort", async () => {
    const c = new AbortController();
    c.abort();
    const r = await runOllamaChat({
      baseUrl: "http://127.0.0.1:1",
      model: "llama3.1",
      prompt: "hi",
      signal: c.signal,
    });
    expect(r).toBe("(cancelled)");
  });

  // maxOutputChars enforcement. Spin up a one-shot fake OpenAI-compatible
  // server that returns a content blob much larger than the cap; verify
  // the runner slices it down and tags the reply with the truncation
  // marker instead of returning the full 50KB.
  test("maxOutputChars truncates oversize replies (non-stream path)", async () => {
    const big = "x".repeat(5000);
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: big } }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const r = await runOllamaChat({
        baseUrl: `http://127.0.0.1:${server.port}`,
        model: "llama3.1",
        prompt: "hi",
        maxOutputChars: 100,
      });
      expect(r.startsWith("x".repeat(100))).toBe(true);
      expect(r).toContain("(truncated at 100 chars)");
      expect(r.length).toBeLessThan(big.length);
    } finally {
      server.stop(true);
    }
  });

  test("maxOutputChars leaves under-cap replies untouched", async () => {
    const small = "hello world";
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: small } }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const r = await runOllamaChat({
        baseUrl: `http://127.0.0.1:${server.port}`,
        model: "llama3.1",
        prompt: "hi",
        maxOutputChars: 1000,
      });
      expect(r).toBe(small);
    } finally {
      server.stop(true);
    }
  });
});

describe("detectClis", () => {
  test("returns an array (length depends on installed CLIs)", async () => {
    const clis = await detectClis();
    expect(Array.isArray(clis)).toBe(true);
    for (const c of clis) {
      expect(["claude", "codex", "antigravity", "ollama"]).toContain(c.kind);
      // ollama's bin is a URL (http://...) — the others are file paths.
      if (c.kind === "ollama") expect(c.bin).toMatch(/^https?:\/\//);
      else expect(c.bin).toMatch(/\//);
      expect(c.label.length).toBeGreaterThan(0);
    }
  });
});

// Regression coverage for the codex envelope stripper. The "codex exec"
// runtime wraps every successful reply in a noisy envelope (workdir, model,
// session id, provider, "user" / "codex" markers, "tokens used") that used
// to leak into the chat bubble. extractCodexReply pulls only the model's
// answer; failures + missing-reply cases get cleaned error lines.
describe("extractCodexReply", () => {
  test("strips the success envelope and returns the model body", () => {
    const raw = `OpenAI Codex v0.136.0
--------
workdir: /Users/x/y
model: gpt-5.4
provider: openai
session id: 019e88ad-...
--------
user
What's 2+2?
codex
4
tokens used
1,234`;
    expect(extractCodexReply(raw)).toBe("4");
  });

  test("multi-line replies are preserved between 'codex' and 'tokens used'", () => {
    const raw = `--------
user
hi
codex
line one
line two
line three
tokens used
99`;
    expect(extractCodexReply(raw)).toBe("line one\nline two\nline three");
  });

  test("non-zero exit prefix returns the error line, not the envelope", () => {
    const raw = `(/opt/homebrew/bin/codex exited 1)
OpenAI Codex v0.136.0
--------
workdir: /tmp
model: gpt-5.4
ERROR: The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.`;
    const out = extractCodexReply(raw);
    expect(out).toContain("not supported when using Codex");
    expect(out).not.toContain("workdir");
    expect(out).not.toContain("OpenAI Codex");
  });

  test("envelope without a codex reply marker returns concise fallback", () => {
    const raw = `--------
workdir: /tmp
model: gpt-5.4
session id: abc
--------
user
hello`;
    // No "codex" line ever appears — the model never replied.
    expect(extractCodexReply(raw)).toBe("(codex produced no reply)");
  });

  test("empty input passes through", () => {
    expect(extractCodexReply("")).toBe("");
  });

  // Codex 0.136+ split the streams: the reply goes to stdout (just the
  // bare answer), the envelope (workdir / model / 'codex' marker / tokens
  // used) goes to stderr. runCapture only hands us stdout — so the input
  // is just the bare reply with no marker line. Used to be falsely
  // discarded as "(codex produced no reply)"; now passes through.
  test("bare stdout reply (no envelope, no marker) passes through unchanged", () => {
    expect(extractCodexReply("2 + 2 = 4.")).toBe("2 + 2 = 4.");
  });

  test("bare multi-line stdout reply passes through", () => {
    const reply = "line one\nline two\nline three";
    expect(extractCodexReply(reply)).toBe(reply);
  });
});

// Regression coverage for the gemini stack-trace stripper. The gemini CLI
// dumps 30+ lines of Node.js "at frameName (file:///...)" frames after the
// real error line on any API failure. extractGeminiReply pulls the error,
// leaves successful replies untouched.
describe("extractGeminiReply", () => {
  test("collapses stack traces to the error line on quota exhaust", () => {
    const raw = `(/opt/homebrew/bin/gemini exited 1)
Error when talking to Gemini API Full report available at: /var/folders/x/y/z.json TerminalQuotaError: You have exhausted your capacity on this model. Your quota will reset after 21h0m20s.
    at classifyGoogleError (file:///opt/homebrew/Cellar/gemini-cli/0.44.1/libexec/lib/node_modules/@google/gemini-cli/bundle/chunk-GPVT36PL.js:304203:18)
    at retryWithBackoff (file:///opt/homebrew/Cellar/gemini-cli/0.44.1/libexec/lib/node_modules/@google/gemini-cli/bundle/chunk-GPVT36PL.js:304863:31)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)`;
    const out = extractGeminiReply(raw);
    expect(out).toContain("TerminalQuotaError");
    expect(out).toContain("21h0m20s");
    expect(out).not.toContain("at classifyGoogleError");
    expect(out).not.toContain("Full report available at");
    expect(out).not.toContain("file:///opt/homebrew/Cellar");
  });

  test("successful gemini reply passes through unchanged", () => {
    const plain = "Here is my answer\nin two lines.";
    expect(extractGeminiReply(plain)).toBe(plain);
  });

  test("empty input passes through", () => {
    expect(extractGeminiReply("")).toBe("");
  });
});
