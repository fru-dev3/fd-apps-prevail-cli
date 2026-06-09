import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPack,
  exportPack,
  listBundledPacks,
  parsePack,
  type PrevailPack,
} from "./pack.ts";

const SAMPLE: PrevailPack = {
  schema: "prevail.pack/v1",
  name: "Test Persona",
  version: "1.0.0",
  domains: [
    {
      slug: "tax",
      title: "Taxes",
      soul: "# Taxes\n",
      goals: "# Goals\n- file on time\n",
      config: "# Config\n",
      prompts: ["What is due this quarter?"],
      skills: [{ name: "estimate helper", body: "# Estimate Helper\n" }],
    },
    { slug: "health", soul: "# Health\n" },
  ],
};

describe("parsePack", () => {
  it("accepts a valid pack", () => {
    const p = parsePack(JSON.stringify(SAMPLE));
    expect(p.name).toBe("Test Persona");
    expect(p.domains.length).toBe(2);
  });
  it("rejects a wrong schema", () => {
    expect(() => parsePack(JSON.stringify({ ...SAMPLE, schema: "nope" }))).toThrow(/schema/);
  });
  it("rejects a pack with no domains", () => {
    expect(() => parsePack(JSON.stringify({ ...SAMPLE, domains: [] }))).toThrow(/no domains/);
  });
  it("rejects malformed JSON", () => {
    expect(() => parsePack("{not json")).toThrow(/valid JSON/);
  });
});

describe("applyPack", () => {
  it("materializes domains with their intent files", () => {
    const vault = mkdtempSync(join(tmpdir(), "prevail-pack-"));
    const r = applyPack(vault, SAMPLE);
    expect(r.created.sort()).toEqual(["health", "tax"]);
    expect(r.skipped).toEqual([]);
    expect(readFileSync(join(vault, "tax", "soul.md"), "utf8")).toContain("Taxes");
    expect(readFileSync(join(vault, "tax", "goals.md"), "utf8")).toContain("file on time");
    expect(readFileSync(join(vault, "tax", "PROMPTS.md"), "utf8")).toContain("What is due");
    expect(existsSync(join(vault, "tax", "_skills", "estimate-helper", "SKILL.md"))).toBe(true);
    rmSync(vault, { recursive: true, force: true });
  });

  it("skips existing domains unless overwrite is set", () => {
    const vault = mkdtempSync(join(tmpdir(), "prevail-pack-"));
    mkdirSync(join(vault, "tax"), { recursive: true });
    writeFileSync(join(vault, "tax", "soul.md"), "# my real tax domain\n");

    const r = applyPack(vault, SAMPLE);
    expect(r.skipped).toContain("tax");
    expect(r.created).toContain("health");
    // The real domain is untouched.
    expect(readFileSync(join(vault, "tax", "soul.md"), "utf8")).toContain("my real tax domain");

    const r2 = applyPack(vault, SAMPLE, { overwrite: true });
    expect(r2.created).toContain("tax");
    expect(readFileSync(join(vault, "tax", "soul.md"), "utf8")).toContain("# Taxes");
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("exportPack round-trips intent only", () => {
  it("exports soul/goals/config but not derived/private content", () => {
    const vault = mkdtempSync(join(tmpdir(), "prevail-pack-exp-"));
    applyPack(vault, SAMPLE);
    // Add some private/derived content that must NOT be exported.
    writeFileSync(join(vault, "tax", "_state.md"), "PRIVATE STATE");
    writeFileSync(join(vault, "tax", "_journal.md"), "PRIVATE JOURNAL");

    const out = exportPack(vault, "My Export");
    const tax = out.domains.find((d) => d.slug === "tax")!;
    expect(tax.soul).toContain("Taxes");
    expect(tax.goals).toContain("file on time");
    // Whole serialized pack carries no private content.
    const json = JSON.stringify(out);
    expect(json).not.toContain("PRIVATE STATE");
    expect(json).not.toContain("PRIVATE JOURNAL");
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("bundled packs", () => {
  it("ships valid persona packs", () => {
    const packs = listBundledPacks();
    expect(packs.length).toBeGreaterThanOrEqual(3);
    for (const { pack } of packs) {
      expect(pack.schema).toBe("prevail.pack/v1");
      expect(pack.domains.length).toBeGreaterThan(0);
    }
    expect(packs.map((p) => p.pack.name)).toContain("Small Business Owner");
  });
});
