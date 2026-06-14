import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildRecommendations } from "./recommendations.ts";

// NOTE: use a project-local temp dir, NOT os.tmpdir(). On macOS os.tmpdir() is
// under /var/folders, and scanVault's validateVaultPath refuses to scan system
// paths like /var (a security feature), which would make scanVault return [].
test("buildRecommendations: domain rec for missing area, app rec for unfed domain", () => {
  const root = join(process.cwd(), `.rectest-${process.pid}-${Math.floor(performance.now())}`);
  mkdirSync(join(root, "domains", "health"), { recursive: true });
  writeFileSync(join(root, "domains", "health", "_state.md"), "# state");
  mkdirSync(join(root, "_meta"), { recursive: true });
  writeFileSync(join(root, "_meta", "intents_distilled.json"), JSON.stringify({
    intents: [
      { title: "Buy a car", goal: "transport", domains: ["wealth"], status: "active" },
      { title: "Old", domains: ["career"], status: "resolved" }, // resolved → ignored
      { title: "Existing", domains: ["health"], status: "active" }, // have it → no rec
    ],
  }));
  try {
    const recs = buildRecommendations(root);
    const ids = recs.map((r) => r.id);
    expect(ids).toContain("domain:wealth");        // missing area from an active intent
    expect(ids).not.toContain("domain:career");    // resolved intent ignored
    expect(ids).not.toContain("domain:health");    // already a domain
    expect(ids).toContain("app:health");           // health has no feeding app
    const dom = recs.find((r) => r.id === "domain:wealth")!;
    expect(dom.action).toEqual({ kind: "create_domain", domain: "wealth" });
    expect(dom.detail).toContain("Buy a car");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
