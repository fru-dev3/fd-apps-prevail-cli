import { describe, expect, test } from "bun:test";
import { buildVerifiedFooter, type VerifiedLedgerRec } from "./agent-run.ts";

// Golden-run eval for the load-bearing TRUST contract: the "what I actually
// did" footer is built from the verified action ledger, never the model's
// prose - so a reply that merely sounds like it acted cannot claim it did.
// These cases lock that behavior against any refactor.
const rec = (o: Partial<VerifiedLedgerRec>): VerifiedLedgerRec => ({ ts: 1, tool: "t", ok: true, detail: "did a thing", ...o });

describe("buildVerifiedFooter — the no-fabricated-success contract", () => {
  test("lists real actions with success/queued/failed marks", () => {
    const f = buildVerifiedFooter(
      [rec({ detail: "sent the digest", ok: true }), rec({ detail: "queued an invoice", queued: true }), rec({ detail: "delete failed", ok: false })],
      true, "claude",
    );
    expect(f).toContain("What I actually did (verified by Prevail):");
    expect(f).toContain("✓ sent the digest");     // check
    expect(f).toContain("⏳ queued an invoice");   // hourglass
    expect(f).toContain("✗ delete failed");       // cross
  });

  test("act on, NO tool ran, claude: states plainly that nothing happened", () => {
    const f = buildVerifiedFooter([], true, "claude");
    expect(f).toContain("no actions were taken");
    expect(f).toContain("Nothing was created, sent, queued, or changed");
  });

  test("empty ledger on a NON-claude runtime makes NO 'no actions' claim (would be false)", () => {
    // codex/gemini act via their own file tools the ledger can't see - claiming
    // 'no actions' there would itself be a fabrication.
    expect(buildVerifiedFooter([], true, "codex")).toBe("");
    expect(buildVerifiedFooter([], true, "gemini")).toBe("");
  });

  test("non-act (advisory) turn with empty ledger adds no footer at all", () => {
    expect(buildVerifiedFooter([], false, "claude")).toBe("");
  });

  test("a real action ALWAYS reports, even on a non-claude runtime", () => {
    const f = buildVerifiedFooter([rec({ detail: "wrote the note" })], true, "codex");
    expect(f).toContain("✓ wrote the note");
  });

  test("the footer text can never be empty-but-claim: no records => no 'did' line unless the plain-nothing case", () => {
    // Guards against a regression where an empty ledger prints an empty
    // 'What I actually did:' header (which reads as success with no detail).
    const f = buildVerifiedFooter([], true, "claude");
    expect(f.includes("What I actually did (verified by Prevail):\n✓")).toBe(false);
  });
});
