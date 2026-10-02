// Editing a specialist from the app: save keeps the prior file as a dated
// version and writes a ledger line, reset moves the override aside (never
// deletes), a ceiling raise needs a confirmation, and per-domain instructions
// can only tighten. Invented data only.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forDomain, getSpecialist, parseSpecialist, resetSpecialist, saveDomainInstructions, saveSpecialist, serializeSpecialist } from "./specialists.ts";

const ROOT = join("/tmp", `prevail-spec-edit-${process.pid}`);
const V = join(ROOT, "vault");
const SPECS = join(V, "build", "specialists");
const VERS = join(SPECS, ".versions");
const LEDGER = join(V, "build", "_meta", "specialists", "ledger.jsonl");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(V, "build", "_meta"), { recursive: true });
  for (const d of ["general", "foo"]) {
    mkdirSync(join(V, "data", "domains", d, "memory"), { recursive: true });
    writeFileSync(join(V, "data", "domains", d, "manifest.json"), JSON.stringify({ identity: { name: d } }));
  }
});
const T1 = Date.parse("2026-10-02T09:00:00Z");
const T2 = Date.parse("2026-10-02T10:00:00Z");

describe("specialist editing", () => {
  test("a file round-trips through serialize and parse", () => {
    const s = getSpecialist(V, "researcher")!;
    const back = parseSpecialist(serializeSpecialist(s))!;
    expect({ ...back, builtIn: s.builtIn }).toEqual({ ...s, source: undefined } as never);
  });

  test("save writes the override, keeps the prior file as a dated version, and logs a ledger line", () => {
    const r1 = saveSpecialist(V, "researcher", { budget: { minutes: 3 }, doneWhen: ["the foo answer is first"] }, { now: T1 });
    expect(r1.ok).toBe(true);
    expect(getSpecialist(V, "researcher")!.budget.minutes).toBe(3);
    expect(getSpecialist(V, "researcher")!.doneWhen).toEqual(["the foo answer is first"]);
    expect(getSpecialist(V, "researcher")!.source).toBe("build/specialists/researcher.md");
    // The first save had nothing to replace.
    expect(existsSync(VERS) ? readdirSync(VERS) : []).toEqual([]);
    const r2 = saveSpecialist(V, "researcher", { mandate: "A deep, sourced foo answer." }, { now: T2 });
    expect(r2.ok && r2.version).toBe("build/specialists/.versions/researcher.2026-10-02T10-00-00-000Z.md");
    expect(readFileSync(join(VERS, "researcher.2026-10-02T10-00-00-000Z.md"), "utf8")).toContain("the foo answer is first");
    const rows = readFileSync(LEDGER, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((r) => r.action)).toEqual(["save", "save"]);
    expect(rows[1].id).toBe("researcher");
  });

  test("a ceiling above the built-in needs a confirmation; lowering it does not", () => {
    const raise = saveSpecialist(V, "researcher", { ceiling: "draft" }, { now: T1 });
    expect(raise.ok).toBe(false);
    expect(!raise.ok && raise.needsConfirm).toBe(true);
    expect(existsSync(join(SPECS, "researcher.md"))).toBe(false);
    expect(saveSpecialist(V, "researcher", { ceiling: "draft" }, { now: T1, confirmRaise: true }).ok).toBe(true);
    expect(getSpecialist(V, "researcher")!.ceiling).toBe("draft");
    expect(saveSpecialist(V, "editor", { ceiling: "read" }, { now: T1 }).ok).toBe(true);
  });

  test("bad values are refused before anything is written", () => {
    expect(saveSpecialist(V, "researcher", { tools: ["shell"] }).ok).toBe(false);
    expect(saveSpecialist(V, "researcher", { budget: { passes: 9 } }).ok).toBe(false);
    expect(saveSpecialist(V, "researcher", { mandate: "" }).ok).toBe(false);
    expect(saveSpecialist(V, "foo-nobody", { mandate: "Foo" }).ok).toBe(false);
    expect(existsSync(SPECS)).toBe(false);
  });

  test("reset moves the override aside, never deletes it", () => {
    saveSpecialist(V, "writer", { budget: { minutes: 2 } }, { now: T1 });
    const r = resetSpecialist(V, "writer", T2);
    expect(r).toEqual({ ok: true, moved: "build/specialists/.versions/writer.2026-10-02T10-00-00-000Z.md" });
    expect(existsSync(join(SPECS, "writer.md"))).toBe(false);
    expect(readFileSync(join(VERS, "writer.2026-10-02T10-00-00-000Z.md"), "utf8")).toContain("minutes: 2");
    expect(getSpecialist(V, "writer")!.budget.minutes).toBe(3);
    expect(resetSpecialist(V, "writer", T2)).toEqual({ ok: true, moved: null });
  });

  test("per-domain instructions may only tighten", () => {
    const loose = saveDomainInstructions(V, "editor", "foo", { ceiling: "act" });
    expect(loose.ok).toBe(false);
    expect(!loose.ok && loose.error).toContain("only be tightened");
    expect(saveDomainInstructions(V, "researcher", "foo", { tools: ["web", "shell"] }).ok).toBe(false);
    const ok = saveDomainInstructions(V, "researcher", "foo", { ceiling: "read", tools: ["vault-read"], notes: "Prefer foo sources." }, T1);
    expect(ok).toEqual({ ok: true, path: "data/domains/foo/source/specialists/researcher.md" });
    const { spec, notes } = forDomain(V, getSpecialist(V, "researcher")!, "foo");
    expect(spec.tools).toEqual(["vault-read"]);
    expect(notes).toBe("Prefer foo sources.");
    // Saving again keeps the prior instructions as a dated version.
    saveDomainInstructions(V, "researcher", "foo", { notes: "Prefer bar sources." }, T2);
    expect(readdirSync(join(V, "data", "domains", "foo", "source", "specialists", ".versions"))).toEqual(["researcher.2026-10-02T10-00-00-000Z.md"]);
    expect(saveDomainInstructions(V, "researcher", "../general", { notes: "x" }).ok).toBe(false);
  });
});
