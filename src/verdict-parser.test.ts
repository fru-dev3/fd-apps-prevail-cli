import { describe, expect, test } from "bun:test";
import { parseVerdict, verdictHeadline } from "./verdict-parser.ts";

const STRUCTURED = `## What each panelist said
- **Claude**: file in June — May filing rule applies.
- **Codex**: file in August — August 15 is the actual deadline.
- **Gemini**: file in June — IRS Publication 559 says June.

## Consensus
- Form 1041 must be filed.
- Filing late triggers a 5%/month penalty.

## Divergence
- Filing month: Claude: June, Codex: August, Gemini: June → majority: June (2 of 3).

## Verdict
VERDICT: File the 1041 in June, before the 15th.
Why: Claude and Gemini both cite June with explicit IRS guidance; Codex argued August but did not cite a source.`;

describe("parseVerdict", () => {
  test("splits a properly structured verdict into 4 sections", () => {
    const p = parseVerdict(STRUCTURED);
    expect(p.structured).toBe(true);
    expect(p.panelistSaid).toContain("Claude");
    expect(p.consensus).toContain("Form 1041");
    expect(p.divergence).toContain("majority: June");
    expect(p.verdict).toContain("File the 1041 in June");
    expect(p.hasDivergence).toBe(true);
  });

  test("flags 'None — see divergence' as no real disagreement", () => {
    const raw = STRUCTURED.replace(
      /## Divergence\n[^#]+/,
      "## Divergence\nNone — see divergence.\n\n",
    );
    const p = parseVerdict(raw);
    expect(p.hasDivergence).toBe(false);
  });

  test("returns structured=false when chair ignored the format", () => {
    const p = parseVerdict("Looks like everyone agrees: file in June. Done.");
    expect(p.structured).toBe(false);
    expect(p.verdict).toBeNull();
  });

  test("handles bolded section headers (## **Verdict**)", () => {
    const raw = STRUCTURED.replace(/## Verdict/, "## **Verdict**");
    const p = parseVerdict(raw);
    expect(p.verdict).toContain("File the 1041 in June");
  });

  test("verdictHeadline extracts the VERDICT: line", () => {
    const p = parseVerdict(STRUCTURED);
    expect(verdictHeadline(p, STRUCTURED)).toBe(
      "File the 1041 in June, before the 15th.",
    );
  });

  test("verdictHeadline falls back to first line when no VERDICT: prefix", () => {
    const p = parseVerdict("just a bare reply, no structure");
    const head = verdictHeadline(p, "just a bare reply, no structure");
    expect(head).toContain("just a bare reply");
  });
});
