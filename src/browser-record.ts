// browser-record — turn a successful agentic run into a DETERMINISTIC replay
// skill. The agent loop is the expensive fallback; this is what makes every
// subsequent sync fast and ~free: a normal `runner: browser` skill file the
// existing SkillSpec/runSkill/daemon machinery already understands.
//
// Recording rules (enforced here):
//   * Only goal-advancing actions become steps. navigate/click/select/fill/
//     download/scroll are kept; read/request_screenshot/ask_user/wait_for(pure
//     pauses) are dropped — they were for the model's benefit, not the recipe.
//   * Selectors are derived from the targeted element's snapshot fingerprint via
//     buildLocator (role+name first). No ephemeral refs are ever written.
//   * fill VALUES are passed through redactActionValue, so a secret-shaped
//     literal becomes a placeholder. (Credential fills never reach here — the
//     guard blocks them at action time.)

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { vwriteFile } from "./vault-session.ts";
import {
  buildLocator,
  buildFallbackLocator,
  redactActionValue,
  validateReplaySteps,
  type AgentAction,
  type ReplayStep,
  type SnapshotElement,
  type ElementFingerprint,
  type ReplayExpect,
} from "./browser-actions.ts";

// One executed step in an agentic run, captured by the loop. `target` is the
// snapshot element the action addressed (for ref actions), used to derive a
// robust locator. `downloads` is how many files this action produced.
export interface TraceEntry {
  action: AgentAction;
  target?: SnapshotElement;
  urlAfter?: string;
  downloads?: number;
}

export interface RecordOptions {
  skillId: string; // e.g. "download-statements"
  connector: string; // app id
  goal: string;
  startUrl: string;
  trigger?: string; // default "refresh"
  session?: "profile" | "state";
  domainAllow?: string[];
  successGlob?: string; // success_check files_match glob
  minDownloads?: number;
}

function fingerprintOf(el: SnapshotElement | undefined): ElementFingerprint {
  if (!el) return {};
  return {
    role: el.role && el.name ? el.role : undefined,
    name: el.name || undefined,
    text: el.name || undefined,
    testid: el.testid,
  };
}

// Convert the captured trace into the deterministic steps[] list.
export function traceToSteps(trace: TraceEntry[]): ReplayStep[] {
  const steps: ReplayStep[] = [];
  for (const t of trace) {
    const a = t.action;
    switch (a.action) {
      case "navigate": {
        steps.push({ action: "navigate", url: a.url, expect: a.url ? urlExpect(a.url) : undefined });
        break;
      }
      case "click": {
        const fp = fingerprintOf(t.target);
        const locator = buildLocator(fp);
        const fallback = buildFallbackLocator(fp, locator);
        const expect: ReplayExpect | undefined = t.downloads && t.downloads > 0 ? { download: true } : undefined;
        steps.push({ action: "click", locator, fallback, expect });
        break;
      }
      case "fill": {
        const fp = fingerprintOf(t.target);
        steps.push({ action: "fill", locator: buildLocator(fp), value: redactActionValue(a.text || "") });
        break;
      }
      case "select": {
        const fp = fingerprintOf(t.target);
        steps.push({ action: "select", locator: buildLocator(fp), option: a.option });
        break;
      }
      case "download": {
        const fp = fingerprintOf(t.target);
        steps.push({ action: "download", locator: buildLocator(fp), expect: { download: true } });
        break;
      }
      case "scroll": {
        if (a.to) steps.push({ action: "scroll", to: a.to });
        break;
      }
      // read / wait_for / request_screenshot / ask_user / done / fail: not steps.
    }
  }
  return steps;
}

function urlExpect(url: string): ReplayExpect | undefined {
  try {
    const path = new URL(url).pathname;
    if (path && path !== "/") return { url_matches: path };
  } catch {
    /* ignore */
  }
  return undefined;
}

// Serialize a steps[] list to YAML-ish lines that parseSkillFile/parseYamlish
// round-trips. Kept deliberately simple (inline JSON for nested objects is valid
// YAML flow syntax and survives the engine's tolerant parser).
function stepsToYaml(steps: ReplayStep[]): string {
  const lines: string[] = ["steps:"];
  for (const s of steps) lines.push(`  - ${JSON.stringify(s)}`);
  return lines.join("\n");
}

// Build the full recorded skill markdown.
export function buildReplaySkillMarkdown(opts: RecordOptions, steps: ReplayStep[]): string {
  const today = new Date().toISOString();
  const fm: string[] = [
    "---",
    `id: ${opts.skillId}`,
    "runner: browser",
    `trigger: ${opts.trigger || "refresh"}`,
    "auth: []",
    "op: read",
    "recorded_from: agentic",
    `recorded_at: ${today}`,
    `connector: ${opts.connector}`,
    `session: ${opts.session || "profile"}`,
    `start_url: ${opts.startUrl}`,
    `goal: ${JSON.stringify(opts.goal)}`,
  ];
  if (opts.domainAllow && opts.domainAllow.length) fm.push(`domain_allow: ${JSON.stringify(opts.domainAllow)}`);
  if (opts.successGlob) {
    fm.push(`success_check: ${JSON.stringify({ type: "files_match", glob: opts.successGlob, min: opts.minDownloads || 1 })}`);
  }
  fm.push(stepsToYaml(steps));
  fm.push("---");
  fm.push("");
  fm.push(`# ${opts.skillId} (recorded)`);
  fm.push("");
  fm.push(`Auto-recorded by the browser agent on ${today.slice(0, 10)} from the goal:`);
  fm.push(`"${opts.goal}".`);
  fm.push("");
  fm.push("Replays deterministically with zero model calls. Edit the `steps:` list");
  fm.push("by hand if the portal changes; the agent re-learns and overwrites this");
  fm.push("file automatically if replay drifts.");
  fm.push("");
  return fm.join("\n");
}

export interface RecordResult {
  ok: boolean;
  path?: string;
  steps: number;
  message: string;
}

// Write the recorded replay skill to <connectorDir>/skills/<skillId>.md.
export function writeReplaySkill(connectorDir: string, opts: RecordOptions, trace: TraceEntry[]): RecordResult {
  const steps = traceToSteps(trace);
  if (steps.length === 0) return { ok: false, steps: 0, message: "no recordable steps in trace" };
  const check = validateReplaySteps(steps);
  if (!check.ok) return { ok: false, steps: steps.length, message: `invalid steps: ${check.errors.join("; ")}` };
  const md = buildReplaySkillMarkdown(opts, steps);
  const skillsDir = join(connectorDir, "skills");
  mkdirSync(skillsDir, { recursive: true });
  const path = join(skillsDir, `${opts.skillId}.md`);
  vwriteFile(path, md);
  return { ok: true, path, steps: steps.length, message: `recorded ${steps.length} steps → ${opts.skillId}.md` };
}
