import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyFold, placeFile, planFold, rewritePaths } from "./fold.ts";

// Under homedir(): archiveDomain validates the vault path and refuses /var.
const ROOT = mkdtempSync(join(homedir(), ".prevail-fold-test-"));
const V = join(ROOT, "vault");
const dom = (d: string) => join(V, "data", "domains", d);
const backups: string[] = [];
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  for (const b of backups) rmSync(b, { force: true });
});

function seed() {
  rmSync(V, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "chief", "vision", "intel", "wealth", "money"]) mkdirSync(join(dom(d), "memory"), { recursive: true });
  writeFileSync(join(dom("general"), "_loops.json"), JSON.stringify({ loops: [{ id: "morning-brief", name: "Morning Brief", kind: "briefing", enabled: true }] }));
  writeFileSync(join(dom("general"), "memory", "memory.md"), "# General memory\n\n- Likes foo.\n");
  writeFileSync(join(dom("general"), "memory", "tasks.md"), "# Tasks\n\n- [ ] Existing bar task\n");
  mkdirSync(join(dom("general"), "source"), { recursive: true });
  writeFileSync(join(dom("general"), "source", "goals.md"), "- [ ] Keep foo lean ~id:g-aaa ~status:active\n");

  writeFileSync(join(dom("chief"), "manifest.json"), JSON.stringify({ identity: { name: "chief" } }));
  writeFileSync(join(dom("chief"), "ideal-state.md"), "# Chief\n");
  writeFileSync(join(dom("chief"), "mission.md"), "# Mission\n\nLive a calm foo life.\n");
  mkdirSync(join(dom("chief"), "source"), { recursive: true });
  writeFileSync(join(dom("chief"), "source", "pulse.html"), "<link href=\"brand.css\">\n<p>chief/source/app-index.md</p>\n");
  writeFileSync(join(dom("chief"), "source", "config.md"), "# Chief config\n");
  writeFileSync(join(dom("chief"), "source", "goals.md"), "# chief goals\n\n- [ ] Keep one status page ~id:g-bbb ~status:active\n- [ ] Keep foo lean ~id:g-aaa ~status:active\n");
  mkdirSync(join(dom("chief"), "memory", "skills", "app-scan"), { recursive: true });
  writeFileSync(join(dom("chief"), "memory", "skills", "app-scan", "scan.sh"), 'INDEX="$DOMAINS/chief/source/app-index.md"\nTASKS="$DOMAINS/chief/memory/tasks.md"\n');
  writeFileSync(join(dom("chief"), "memory", "memory.md"), "# Chief memory\n\n- The board has 30 domains.\n");
  writeFileSync(join(dom("chief"), "memory", "decisions.jsonl"), `${JSON.stringify({ ts: 1, decision: "Use one brand file" })}\n`);
  writeFileSync(join(dom("chief"), "memory", "state.md"), "# state\n");
  writeFileSync(join(dom("chief"), "memory", "tasks.md"), "# Work\n\n- [ ] Bring Money out of zero ~priority:high\n- [ ] Warm the coldest domains\n- [x] Old done thing\n");
  mkdirSync(join(dom("chief"), "memory", "threads"), { recursive: true });
  writeFileSync(join(dom("chief"), "memory", "threads", "t1.md"), "---\ntitle: foo\n---\n");
  writeFileSync(join(dom("chief"), "_loops.json"), JSON.stringify({ loops: [
    { id: "morning-brief", name: "Morning Brief", kind: "briefing", enabled: true },
    { id: "app-index", name: "App Index", kind: "steward", enabled: true },
  ] }));

  writeFileSync(join(dom("vision"), "independence-tracker.md"), "# Tracker\n\nRunway: foo months.\n");
  writeFileSync(join(dom("vision"), "memory", "memory.md"), "- Motto: live fully.\n");
  writeFileSync(join(dom("vision"), "memory", "tasks.md"), "- [ ] Review the bar insurance policy\n");
  writeFileSync(join(dom("vision"), "_loops.json"), JSON.stringify({ loops: [{ id: "weekly-checkin", name: "Weekly Check-in", kind: "steward", enabled: true }] }));
  // intel: an empty but real domain
  writeFileSync(join(dom("intel"), "manifest.json"), "{}");
}

describe("placeFile", () => {
  test("source files go to General's source, memory lists are merged, the rest is kept under folded/", () => {
    expect(placeFile("chief", "source/pulse.html")).toEqual({ from: "chief/source/pulse.html", to: "general/source/pulse.html", how: "copy" });
    expect(placeFile("chief", "source/config.md")?.to).toBe("general/source/chief-config.md");
    expect(placeFile("chief", "memory/memory.md")?.how).toBe("append");
    expect(placeFile("chief", "memory/decisions.jsonl")?.how).toBe("jsonl");
    expect(placeFile("chief", "source/goals.md")?.how).toBe("goals");
    expect(placeFile("intel", "memory/briefs/a.md")?.to).toBe("general/memory/folded/intel/briefs/a.md");
    expect(placeFile("vision", "independence-tracker.md")?.to).toBe("general/source/independence-tracker.md");
    expect(placeFile("vision", "independence-tracker.md", { files: { "vision/independence-tracker.md": "wealth/source/independence-tracker.md" } })?.to).toBe("wealth/source/independence-tracker.md");
    for (const keep of ["manifest.json", "ideal-state.md", "_loops.json", "_loops_runtime.json", "memory/tasks.md", "memory/state.md", "memory/threads/a.md", ".system/journal.jsonl", "memory/tasks.pre-reorg.md", "_tasks.pre-merge-2026-08-10.bak", "manifest.json.pre-compass-2026-10-02", "source/pulse.html.pre-m0-2026-10-02", "memory/skills/app-scan/scan.sh.bak.2026-08-24"]) {
      expect(placeFile("chief", keep)).toBeNull();
    }
  });
});

describe("rewritePaths", () => {
  test("paths into a folded domain point at their new home", () => {
    expect(rewritePaths('INDEX="$DOMAINS/chief/source/app-index.md"', "chief")).toBe('INDEX="$DOMAINS/general/source/app-index.md"');
    expect(rewritePaths("see chief/source/pulse.html", "chief")).toBe("see general/source/pulse.html");
    expect(rewritePaths("<vault>/data/domains/chief/memory/skills/app-scan/scan.sh", "chief")).toBe("<vault>/data/domains/general/memory/skills/app-scan/scan.sh");
    expect(rewritePaths("intel/memory/briefs/x.md", "intel")).toBe("general/memory/folded/intel/briefs/x.md");
    expect(rewritePaths("TASKS=$D/chief/memory/tasks.md", "chief")).toBe("TASKS=$D/general/memory/tasks.md");
    expect(rewritePaths("mischief/source/x", "chief")).toBe("mischief/source/x");
  });
});

describe("fold", () => {
  test("plan reads only; apply moves memory, loops, tasks and threads, then archives", async () => {
    seed();
    const routes = {
      loops: {
        "chief/morning-brief": { to: null, note: "merged into General's morning brief" },
        "vision/weekly-checkin": { to: "general", id: "weekly-review", playbook: "weekly-review", autonomy: "auto", name: "Weekly Review" },
      },
      tasks: [{ from: "chief", match: "money out of zero", to: "money" }, { from: "vision", match: "insurance", to: "wealth" }],
      files: { "vision/independence-tracker.md": "wealth/source/independence-tracker.md" },
    };
    const plan = planFold(V, routes, Date.parse("2026-10-02T12:00:00Z"));
    expect(plan.domains.map((d) => d.domain)).toEqual(["chief", "vision", "intel"]);
    expect(existsSync(dom("chief"))).toBe(true);
    const chief = plan.domains[0]!;
    expect(chief.tasks.map((t) => t.to)).toEqual(["money", "general"]);
    expect(chief.loops.find((l) => l.id === "app-index")?.newId).toBe("app-index");

    const r = await applyFold(V, plan);
    backups.push(...r.archived.map((a) => a.backup));

    // Archived beside the live domains, never at the vault root, never deleted.
    expect(r.archived.map((a) => a.domain)).toEqual(["chief", "vision", "intel"]);
    for (const d of ["chief", "vision", "intel"]) {
      expect(existsSync(dom(d))).toBe(false);
      expect(existsSync(join(V, "data", "domains", "_archive", d, "memory"))).toBe(true);
    }
    expect(existsSync(join(V, "_archive"))).toBe(false);
    expect(readdirSync(V).sort()).toEqual(["build", "data"]);

    const g = (p: string) => readFileSync(join(dom("general"), p), "utf8");
    expect(g("source/pulse.html")).toContain("general/source/app-index.md");
    expect(g("source/chief-config.md")).toContain("Chief config");
    expect(g("source/mission.md")).toContain("calm foo life");
    expect(g("memory/skills/app-scan/scan.sh")).toBe('INDEX="$DOMAINS/general/source/app-index.md"\nTASKS="$DOMAINS/general/memory/tasks.md"\n');
    expect(g("memory/memory.md")).toContain("## Folded from Chief (2026-10-02)");
    expect(g("memory/memory.md")).toContain("- The board has 30 domains.");
    expect(g("memory/memory.md")).toContain("## Folded from Vision (2026-10-02)");
    expect(existsSync(join(dom("general"), "memory", "memory.md.pre-fold-2026-10-02"))).toBe(true);
    expect(JSON.parse(g("memory/decisions.jsonl").trim())).toEqual({ ts: 1, decision: "Use one brand file", folded_from: "chief" });
    // Goals: new ids added, a goal already in General not doubled.
    expect(g("source/goals.md").match(/g-aaa/g)?.length).toBe(1);
    expect(g("source/goals.md")).toContain("Keep one status page ~id:g-bbb");
    // Loops: carried with a source mark; a clashing id gets the domain prefix; a dropped one is not carried.
    const loops = JSON.parse(g("_loops.json")).loops as { id: string; foldedFrom?: string; playbook?: string }[];
    expect(loops.map((l) => l.id)).toEqual(["morning-brief", "app-index", "weekly-review"]);
    expect(loops.find((l) => l.id === "weekly-review")).toMatchObject({ foldedFrom: "vision/weekly-checkin", playbook: "weekly-review", autonomy: "auto", name: "Weekly Review", status: "active" });
    // Tasks: open ones to their owner; done ones stay in the archive.
    expect(g("memory/tasks.md")).toContain("- [ ] Warm the coldest domains");
    expect(g("memory/tasks.md")).not.toContain("Old done thing");
    expect(readFileSync(join(dom("money"), "memory", "tasks.md"), "utf8")).toContain("Bring Money out of zero");
    expect(readFileSync(join(dom("wealth"), "memory", "tasks.md"), "utf8")).toContain("Review the bar insurance policy");
    expect(readFileSync(join(dom("wealth"), "source", "independence-tracker.md"), "utf8")).toContain("Runway");
    // Threads copied; the receipt lists what moved.
    expect(existsSync(join(dom("general"), "memory", "threads", "t1.md"))).toBe(true);
    expect(readFileSync(r.receipt, "utf8")).toContain("morning-brief: not carried over. merged into General's morning brief");

    // A second run finds nothing left to fold.
    const again = planFold(V, routes);
    expect(again.domains).toEqual([]);
    expect(again.skipped.map((s) => s.domain)).toEqual(["chief", "vision", "intel"]);
  });
});
