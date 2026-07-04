import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  appendAttachmentIndex,
  readAttachmentIndex,
  captionPendingAttachments,
  parseCaptionReply,
} from "./attachments.ts";

// Attachment intelligence contract: index lines are vault-relative and carry
// conversation context; captioning stores a caption AND renames the file to a
// semantic date_slug name (collision-safe, original kept); missing files are
// marked so they are not retried forever.
const ROOT = join("/tmp", `prevail-att-${process.pid}`);
const VAULT = join(ROOT, "vault");
const ATT = join(VAULT, "build", "_meta", "attachments");

function seed(files: string[]) {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ATT, { recursive: true });
  for (const f of files) writeFileSync(join(ATT, f), "png-bytes");
}

describe("attachment index + captioning", () => {
  beforeEach(() => seed(["pasted-1000.png", "pasted-2000.png"]));
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

  test("parseCaptionReply: tolerant of prose, strict on shape", () => {
    expect(parseCaptionReply("Lease agreement first page, maple Way | lease-maple-way")).toEqual({
      caption: "Lease agreement first page, maple Way",
      slug: "lease-maple-way",
    });
    expect(parseCaptionReply("Sure! Here you go:\nA bar chart of Q3 spend | q3 Spend Chart!!")!.slug).toBe("q3-spend-chart");
    expect(parseCaptionReply("no separator here")).toBeNull();
  });

  test("index append + read round-trip (vault-relative paths)", () => {
    const n = appendAttachmentIndex(VAULT, [
      { file: "build/_meta/attachments/pasted-1000.png", ts: 1000, domain: "real-estate", message: "look at this lease" },
      { file: "build/_meta/attachments/pasted-2000.png", ts: 2000, domain: "wealth", surface: "council" },
    ]);
    expect(n).toBe(2);
    const rows = readAttachmentIndex(VAULT);
    expect(rows.length).toBe(2);
    expect(rows[0].domain).toBe("real-estate");
    expect(rows[0].caption).toBeUndefined();
  });

  test("captioning stores captions, renames to date_slug, keeps original, respects limit", async () => {
    appendAttachmentIndex(VAULT, [
      { file: "build/_meta/attachments/pasted-1000.png", ts: Date.UTC(2026, 6, 4), domain: "real-estate" },
      { file: "build/_meta/attachments/pasted-2000.png", ts: Date.UTC(2026, 6, 4), domain: "wealth" },
    ]);
    const r = await captionPendingAttachments(VAULT, 1, async () => ({ caption: "Lease first page", slug: "lease-maple-way" }));
    expect(r.captioned).toBe(1);
    expect(r.renamed).toBe(1);
    expect(r.remaining).toBe(1); // limit respected
    const rows = readAttachmentIndex(VAULT);
    const done = rows.find((x) => x.caption === "Lease first page")!;
    expect(done.file).toBe("build/_meta/attachments/2026-07-04_lease-maple-way.png");
    expect(done.original).toBe("build/_meta/attachments/pasted-1000.png");
    expect(existsSync(join(VAULT, done.file))).toBe(true);
    expect(existsSync(join(ATT, "pasted-1000.png"))).toBe(false);
  });

  test("collision-safe rename and missing-file skip", async () => {
    writeFileSync(join(ATT, "2026-07-04_dup.png"), "existing");
    appendAttachmentIndex(VAULT, [
      { file: "build/_meta/attachments/pasted-1000.png", ts: Date.UTC(2026, 6, 4) },
      { file: "build/_meta/attachments/gone.png", ts: Date.UTC(2026, 6, 4) },
    ]);
    const r = await captionPendingAttachments(VAULT, 10, async () => ({ caption: "Dup", slug: "dup" }));
    expect(r.captioned).toBe(1);
    expect(r.skipped).toBe(1); // the missing file
    const rows = readAttachmentIndex(VAULT);
    expect(rows.find((x) => x.caption === "Dup")!.file).toBe("build/_meta/attachments/2026-07-04_dup-2.png");
    expect(rows.find((x) => x.file === "build/_meta/attachments/gone.png")!.caption).toBe("(file missing)");
    // Missing file is not retried: nothing pending afterwards.
    expect(r.remaining).toBe(0);
  });

  test("transient captioner failure leaves the entry pending for the next pass", async () => {
    appendAttachmentIndex(VAULT, [{ file: "build/_meta/attachments/pasted-1000.png", ts: 1 }]);
    const r = await captionPendingAttachments(VAULT, 5, async () => null);
    expect(r.captioned).toBe(0);
    expect(r.remaining).toBe(1);
  });
});
