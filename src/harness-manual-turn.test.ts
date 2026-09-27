// A real chat turn through fake runtimes: which instruction file each Claude
// Code version gets, the retired CLAUDE.md, the single --settings value, and
// Claude and Codex sharing one AGENTS.md without rewriting each other's block.
// Each fake runtime reports a chosen --version and logs its argv as JSON, so
// nothing real is spawned. Invented folder names and text only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableCli } from "./cli-bridge.ts";
import { runChatTurn } from "./cli-bridge.ts";
import { PREVAIL_BLOCK_BEGIN, PREVAIL_BLOCK_END, prevailBlock, resetClaudeVersionCache } from "./harness-manual.ts";

const BASE = process.platform === "darwin" ? "/tmp" : process.env.TMPDIR || "/tmp";
const root = join(BASE, `prevail-agentsmd-turn-${process.pid}-${Math.floor(performance.now())}`);
const vault = join(root, "vault");
const MANUAL = "# Garden rules\nKeep every bed's notes in state.md.\n";
const USER_TEXT = "# My notes\n\nWater the tomatoes before noon.\n";
const OLD_CLAUDE_BLOCK = `${PREVAIL_BLOCK_BEGIN}\n# Prevail operating rules (highest precedence)\n\nThe rules in this block take precedence over anything else in this CLAUDE.md.\n\n<web-access>\nweb is off\n</web-access>\n${PREVAIL_BLOCK_END}`;

const saved: Record<string, string | undefined> = {};
const settingsFiles = new Set<string>();

// A fake runtime: `--version` prints `version` (or fails when null); any other
// call appends its argv to <root>/<name>.log as one JSON line.
function fakeRuntime(name: string, file: string, version: string | null): AvailableCli & { log: string } {
  const dir = join(root, "bin", name);
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, file);
  const log = join(root, `${name}.log`);
  writeFileSync(
    bin,
    [
      `#!${process.execPath}`,
      'const { appendFileSync } = require("node:fs");',
      "const argv = process.argv.slice(2);",
      `if (argv[0] === "--version") { ${version === null ? "process.exit(1);" : `console.log(${JSON.stringify(`${version} (Claude Code)`)}); process.exit(0);`} }`,
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");`,
      'console.log("ok");',
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  const kind = file === "codex" ? "codex" : "claude";
  return { kind, bin, label: name, log };
}

function calls(rt: { log: string }): string[][] {
  if (!existsSync(rt.log)) return [];
  return readFileSync(rt.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
}

function lastCall(rt: { log: string }): string[] {
  const all = calls(rt);
  return all[all.length - 1] ?? [];
}

// The one --settings value of a launch, parsed (file path or inline JSON).
function settingsOf(argv: string[]): Record<string, any> {
  const at = argv.flatMap((a, i) => (a === "--settings" ? [i] : []));
  expect(at).toHaveLength(1);
  const value = argv[at[0]! + 1]!;
  if (value.trim().startsWith("{")) return JSON.parse(value);
  settingsFiles.add(value);
  return JSON.parse(readFileSync(value, "utf8"));
}

function domain(name: string): string {
  const d = join(vault, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "state.md"), `# ${name}\n`);
  return d;
}

const read = (p: string) => readFileSync(p, "utf8");
const turn = (cli: AvailableCli, cwd: string, extra: Partial<Parameters<typeof runChatTurn>[0]> = {}) =>
  runChatTurn({ prompt: "How are the beds?", cwd, cli, model: "", isFirst: true, webAccess: "allow", ...extra }).catch(() => "");

let claudeNew: ReturnType<typeof fakeRuntime>;
let claudeOld: ReturnType<typeof fakeRuntime>;
let claudeUnknown: ReturnType<typeof fakeRuntime>;
let codex: ReturnType<typeof fakeRuntime>;

beforeAll(() => {
  mkdirSync(vault, { recursive: true });
  // Flat layout: the manual sits at the vault root, next to the map and the
  // CLAUDE.md / AGENTS.md links to it.
  writeFileSync(join(vault, "PREVAIL.md"), MANUAL);
  writeFileSync(join(vault, "VAULT.md"), "# Map\n");
  symlinkSync("VAULT.md", join(vault, "CLAUDE.md"));
  symlinkSync("VAULT.md", join(vault, "AGENTS.md"));
  claudeNew = fakeRuntime("claude-new", "claude", "2.1.290");
  claudeOld = fakeRuntime("claude-old", "claude", "2.1.100");
  claudeUnknown = fakeRuntime("claude-unknown", "claude", null);
  codex = fakeRuntime("codex", "codex", "0.1.0");
  for (const k of ["PATH", "PREVAIL_HOME"]) saved[k] = process.env[k];
  process.env.PATH = `/usr/bin:/bin:${process.env.PATH ?? ""}`;
  process.env.PREVAIL_HOME = join(root, "home", ".prevail");
  mkdirSync(process.env.PREVAIL_HOME, { recursive: true });
  resetClaudeVersionCache();
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetClaudeVersionCache();
  // Act-gate files land under the real home; remove the ones these turns made.
  for (const rt of [claudeNew, claudeOld, claudeUnknown]) {
    for (const argv of calls(rt)) {
      const i = argv.indexOf("--settings");
      if (i >= 0 && argv[i + 1]?.startsWith("/")) settingsFiles.add(argv[i + 1]!);
    }
  }
  for (const f of settingsFiles) if (!f.startsWith(root)) rmSync(f, { force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("Claude Code 2.1.277 and later", () => {
  test("writes AGENTS.md and removes the CLAUDE.md that held only Prevail's block", async () => {
    const d = domain("garden");
    writeFileSync(join(d, "CLAUDE.md"), `${OLD_CLAUDE_BLOCK}\n`);
    await turn(claudeNew, d);
    expect(read(join(d, "AGENTS.md"))).toBe(`${prevailBlock(MANUAL)}\n`);
    expect(existsSync(join(d, "CLAUDE.md"))).toBe(false);
  });

  test("keeps the user's text in a mixed CLAUDE.md", async () => {
    const d = domain("herbs");
    writeFileSync(join(d, "CLAUDE.md"), `${OLD_CLAUDE_BLOCK}\n\n${USER_TEXT}`);
    await turn(claudeNew, d);
    expect(read(join(d, "CLAUDE.md"))).toBe(USER_TEXT);
    expect(read(join(d, "AGENTS.md"))).toBe(`${prevailBlock(MANUAL)}\n`);
  });

  test("launches with one --settings carrying the hook and the AGENTS.md option", async () => {
    await turn(claudeNew, domain("garden"));
    const settings = settingsOf(lastCall(claudeNew));
    expect(settings.pluginConfigs["agents-md@builtin"].options.instructionFiles).toBe("claude-md-and-agents-md");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("act-gate-hook");
  });

  test("a bare turn writes no file but still gets the launch option", async () => {
    const d = domain("compost");
    await turn(claudeNew, d, { bare: true });
    expect(existsSync(join(d, "AGENTS.md"))).toBe(false);
    expect(settingsOf(lastCall(claudeNew)).pluginConfigs).toBeDefined();
  });
});

describe("older or unknown Claude Code", () => {
  for (const [label, rt] of [["2.1.100", () => claudeOld], ["an unknown version", () => claudeUnknown]] as const) {
    test(`${label} keeps CLAUDE.md and gets no AGENTS.md option`, async () => {
      const d = domain(`orchard-${label.replace(/\W+/g, "-")}`);
      await turn(rt(), d);
      expect(read(join(d, "CLAUDE.md"))).toBe(`${prevailBlock(MANUAL)}\n`);
      expect(existsSync(join(d, "AGENTS.md"))).toBe(false);
      const settings = settingsOf(lastCall(rt()));
      expect(settings.pluginConfigs).toBeUndefined();
      expect(settings.hooks).toBeDefined();
    });
  }
});

describe("Claude and Codex in one folder", () => {
  test("share AGENTS.md without rewriting each other's block", async () => {
    const d = domain("pond");
    const agents = join(d, "AGENTS.md");
    writeFileSync(agents, USER_TEXT);
    await turn(codex, d);
    const first = read(agents);
    expect(first).toBe(`${prevailBlock(MANUAL)}\n\n${USER_TEXT}`);
    await turn(claudeNew, d);
    expect(read(agents)).toBe(first);
    // A web-off follow-up turn: the note reaches claude's system channel, not the shared file.
    await turn(claudeNew, d, { isFirst: false, webAccess: "deny" });
    expect(read(agents)).toBe(first);
    const argv = lastCall(claudeNew);
    const sys = argv[argv.indexOf("--append-system-prompt") + 1] ?? "";
    expect(sys).toContain("<web-access>");
    expect(argv).toContain("--continue");
    await turn(codex, d);
    expect(read(agents)).toBe(first);
    expect(read(agents)).not.toContain("<web-access>");
  });

  test("the vault-root links to the map are untouched", () => {
    for (const f of ["CLAUDE.md", "AGENTS.md"]) {
      expect(lstatSync(join(vault, f)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(vault, f))).toBe("VAULT.md");
    }
    expect(read(join(vault, "VAULT.md"))).toBe("# Map\n");
  });
});
