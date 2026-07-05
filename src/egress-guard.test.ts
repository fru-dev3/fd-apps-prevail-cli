import { describe, expect, test } from "bun:test";
import {
  scanSensitive, scrubText, evaluateEgress, gwsEgress, applyEgressGuardToGws,
  DEFAULT_EGRESS_GUARD,
} from "./egress-guard.ts";

// The sensitive-egress guardrail. Mode and selves are passed explicitly so no
// test touches ~/.prevail/config.json or live gws profiles.
const SELF = new Set(["me@example.com"]);

describe("scanSensitive detectors", () => {
  test("SSN, EIN, phone, DOB", () => {
    const cats = (t: string) => scanSensitive(t).map((f) => f.category);
    expect(cats("my ssn is 123-45-6789")).toContain("ssn");
    expect(cats("EIN 12-3456789 for the LLC")).toContain("ein");
    expect(cats("call me at (415) 555-0123")).toContain("phone");
    expect(cats("she was born 3/14/1985 in Ohio")).toContain("dob");
  });

  test("card numbers require Luhn; a random digit run does not match", () => {
    expect(scanSensitive("card 4111 1111 1111 1111").some((f) => f.category === "card")).toBe(true);
    expect(scanSensitive("id 4111 1111 1111 1112").some((f) => f.category === "card")).toBe(false);
  });

  test("routing numbers require the ABA checksum AND banking context", () => {
    expect(scanSensitive("wire to routing 021000021 please").some((f) => f.category === "bank")).toBe(true);
    expect(scanSensitive("ticket 021000021 was filed").some((f) => f.category === "bank")).toBe(false);
  });

  test("money amounts and standalone 6+ digit figures; dates and times are not figures", () => {
    expect(scanSensitive("the offer is $185,000 base").some((f) => f.category === "money")).toBe(true);
    expect(scanSensitive("balance was 1250000 last month").some((f) => f.category === "money")).toBe(true);
    expect(scanSensitive("see you 2026-07-04 at 10:30").some((f) => f.category === "money")).toBe(false);
    expect(scanSensitive("zip 94110, in 2026").some((f) => f.category === "money")).toBe(false);
  });

  test("secrets: API keys and private key blocks", () => {
    expect(scanSensitive("token ghp_abcdefghijklmnopqrstuv123456").some((f) => f.category === "secret")).toBe(true);
    expect(scanSensitive("-----BEGIN RSA PRIVATE KEY-----").some((f) => f.category === "secret")).toBe(true);
  });

  test("long verbatim quotes are flagged; short quotes are not", () => {
    expect(scanSensitive('he said "this is a very long confidential remark that spans well over forty characters"').some((f) => f.category === "quote")).toBe(true);
    expect(scanSensitive('the "quick" fix').some((f) => f.category === "quote")).toBe(false);
  });

  test("lexicons: salary, wealth, health, legal, strategy", () => {
    const cats = (t: string) => scanSensitive(t).map((f) => f.category);
    expect(cats("my current salary and equity grant")).toEqual(expect.arrayContaining(["salary"]));
    expect(cats("our net worth crossed a milestone")).toContain("wealth");
    expect(cats("the diagnosis and medication list")).toContain("health");
    expect(cats("her visa status is pending")).toContain("legal");
    expect(cats("this roadmap is internal only")).toContain("strategy");
    expect(cats("lunch at noon, nothing else")).toEqual([]);
  });

  test("previews are masked, never the full value", () => {
    const f = scanSensitive("ssn 123-45-6789")[0]!;
    expect(f.preview).not.toContain("123-45-6789");
    expect(f.preview).toContain("*");
  });
});

describe("scrubText", () => {
  test("pattern spans become typed placeholders; surrounding text survives", () => {
    const { text } = scrubText("Offer: $185,000 base, SSN 123-45-6789, call (415) 555-0123.");
    expect(text).not.toContain("185,000");
    expect(text).not.toContain("123-45-6789");
    expect(text).toContain("[withheld: a money amount]");
    expect(text).toContain("[withheld: a Social Security number]");
    expect(text).toContain("Offer:");
  });
});

describe("evaluateEgress", () => {
  test("self audience always passes, even with sensitive content", () => {
    const ev = evaluateEgress("self", ["my salary is $185,000 and SSN 123-45-6789"], "on");
    expect(ev.verdict).toBe("allow");
  });
  test("external audience with findings holds and names categories, not values", () => {
    const ev = evaluateEgress("external", ["base salary is $185,000"], "on");
    expect(ev.verdict).toBe("hold");
    expect(ev.reason).not.toContain("185,000");
    expect(ev.categories.join(" ")).toContain("money");
  });
  test("clean external content passes; guard off passes everything", () => {
    expect(evaluateEgress("external", ["see you at the coffee shop tomorrow"], "on").verdict).toBe("allow");
    expect(evaluateEgress("public", ["SSN 123-45-6789"], "off").verdict).toBe("allow");
  });
  test("default mode is on (locked down out of the box)", () => {
    expect(DEFAULT_EGRESS_GUARD).toBe("on");
  });
});

describe("gwsEgress audience classification", () => {
  test("gmail to self = self; to a third party = external; no recipients (reply) = external", () => {
    expect(gwsEgress(["gmail", "+send", "--to", "me@example.com", "--body", "x"], SELF).audience).toBe("self");
    expect(gwsEgress(["gmail", "+send", "--to", "them@corp.com", "--body", "x"], SELF).audience).toBe("external");
    expect(gwsEgress(["gmail", "+reply", "--id", "m1", "--body", "x"], SELF).audience).toBe("external");
  });
  test("a --draft never leaves the account: self", () => {
    expect(gwsEgress(["gmail", "+send", "--to", "them@corp.com", "--body", "x", "--draft"], SELF).audience).toBe("self");
  });
  test("calendar without attendees = self; with attendees = external and scans the description", () => {
    expect(gwsEgress(["calendar", "+insert", "--summary", "dentist"], SELF).audience).toBe("self");
    const eg = gwsEgress(["calendar", "+insert", "--summary", "Comp review", "--description", "salary $185,000", "--attendee", "them@corp.com"], SELF);
    expect(eg.audience).toBe("external");
    expect(eg.texts.join(" ")).toContain("salary $185,000");
  });
  test("drive permission/share writes are external and unscannable", () => {
    const eg = gwsEgress(["drive", "permissions", "create", "--params", "{\"role\":\"reader\"}"], SELF);
    expect(eg.audience).toBe("external");
    expect(eg.unscannable).toBe(true);
  });
  test("raw gmail messages send with recipients in --params is classified", () => {
    const eg = gwsEgress(["gmail", "messages", "send", "--params", JSON.stringify({ to: "them@corp.com", body: "net worth details" })], SELF);
    expect(eg.audience).toBe("external");
    expect(eg.texts.join(" ")).toContain("net worth");
  });
  test("label/task management stays internal", () => {
    expect(gwsEgress(["gmail", "labels", "create", "--params", "{}"], SELF).audience).toBe("self");
    expect(gwsEgress(["tasks", "+add", "--title", "pay rent $2,400"], SELF).audience).toBe("self");
  });
});

describe("applyEgressGuardToGws (the executor decision)", () => {
  test("external send carrying sensitive content holds; clean send passes", () => {
    const hold = applyEgressGuardToGws(["gmail", "+send", "--to", "them@corp.com", "--body", "my salary is $185,000"], SELF, false, "on");
    expect(hold.action).toBe("hold");
    expect(hold.reason).not.toContain("185,000");
    const pass = applyEgressGuardToGws(["gmail", "+send", "--to", "them@corp.com", "--body", "running 10 minutes late"], SELF, false, "on");
    expect(pass.action).toBe("allow");
  });
  test("the explicit --allow-sensitive release lets the exact action through", () => {
    const d = applyEgressGuardToGws(["calendar", "+insert", "--attendee", "them@corp.com", "--description", "budget 1250000"], SELF, true, "on");
    expect(d.action).toBe("allow");
    expect(d.reason).toContain("approval");
  });
  test("document shares always hold (contents unscannable)", () => {
    const d = applyEgressGuardToGws(["drive", "permissions", "create", "--params", "{}"], SELF, false, "on");
    expect(d.action).toBe("hold");
    expect(d.unscannable).toBe(true);
  });
  test("self-directed mail with sensitive content passes: the user's own briefings work", () => {
    const d = applyEgressGuardToGws(["gmail", "+send", "--to", "me@example.com", "--body", "your net worth is $1,250,000"], SELF, false, "on");
    expect(d.action).toBe("allow");
  });
});
