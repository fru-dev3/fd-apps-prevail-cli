import { describe, expect, test } from "bun:test";
import { applyEmailPolicy, extractRecipients, DEFAULT_EMAIL_POLICY } from "./email-policy.ts";

// The global outbound-email guardrail. Policy and self-set are passed explicitly
// in every test so nothing touches ~/.prevail/config.json or live gws profiles.
const SELF = new Set(["me@example.com", "me2@other.com"]);

describe("extractRecipients", () => {
  test("space-separated and = flag forms, comma lists, case-folded", () => {
    expect(extractRecipients(["gmail", "+send", "--to", "A@x.com,b@y.com", "--cc", "c@z.com"]))
      .toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(extractRecipients(["gmail", "+send", "--to=Me@Example.com", "--bcc=d@w.com"]))
      .toEqual(["me@example.com", "d@w.com"]);
  });
  test("non-address values and non-recipient flags are ignored", () => {
    expect(extractRecipients(["gmail", "+send", "--to", "not-an-address", "--subject", "x@y.com in subject? no: --subject is not a recipient flag"]))
      .toEqual([]);
  });
});

describe("applyEmailPolicy", () => {
  test("default policy is draft-others (locked down out of the box)", () => {
    expect(DEFAULT_EMAIL_POLICY).toBe("draft-others");
  });

  test("non-send gws commands pass through untouched under every policy", () => {
    for (const policy of ["self-only", "draft-others", "allow"] as const) {
      const args = ["calendar", "+insert", "--summary", "Dinner", "--attendee", "x@y.com"];
      const d = applyEmailPolicy(args, policy, SELF);
      expect(d.action).toBe("allow");
      expect(d.args).toBe(args);
    }
  });

  test("all-self recipients send normally, including across the user's own accounts", () => {
    const d = applyEmailPolicy(
      ["gmail", "+send", "--to", "Me@Example.com", "--cc", "me2@other.com", "--subject", "s", "--body", "b"],
      "draft-others",
      SELF,
    );
    expect(d.action).toBe("allow");
    expect(d.args).not.toContain("--draft");
  });

  test("draft-others: a third-party recipient downgrades the send to a Gmail draft", () => {
    const d = applyEmailPolicy(
      ["gmail", "+send", "--to", "them@corp.com", "--subject", "s", "--body", "b"],
      "draft-others",
      SELF,
    );
    expect(d.action).toBe("draft");
    expect(d.args.filter((a) => a === "--draft")).toHaveLength(1);
    expect(d.reason).toContain("them@corp.com");
    expect(d.reason.toLowerCase()).toContain("draft");
  });

  test("draft-others: an already-drafted argv is not double-flagged", () => {
    const d = applyEmailPolicy(
      ["gmail", "+send", "--to", "them@corp.com", "--body", "b", "--draft"],
      "draft-others",
      SELF,
    );
    expect(d.action).toBe("draft");
    expect(d.args.filter((a) => a === "--draft")).toHaveLength(1);
  });

  test("mixed self + third-party is treated as third-party (cc leaks count)", () => {
    const d = applyEmailPolicy(
      ["gmail", "+send", "--to", "me@example.com", "--cc", "them@corp.com"],
      "draft-others",
      SELF,
    );
    expect(d.action).toBe("draft");
  });

  test("self-only refuses third-party sends and names the recipients", () => {
    const d = applyEmailPolicy(
      ["gmail", "+send", "--to", "them@corp.com", "--bcc", "boss@corp.com"],
      "self-only",
      SELF,
    );
    expect(d.action).toBe("refuse");
    expect(d.reason).toContain("them@corp.com");
    expect(d.reason).toContain("boss@corp.com");
  });

  test("reply/forward without explicit recipients is conservative: third-party", () => {
    for (const verb of ["+reply", "+reply-all", "+forward"]) {
      const drafted = applyEmailPolicy(["gmail", verb, "--id", "abc123"], "draft-others", SELF);
      expect(drafted.action).toBe("draft");
      const refused = applyEmailPolicy(["gmail", verb, "--id", "abc123"], "self-only", SELF);
      expect(refused.action).toBe("refuse");
    }
  });

  test("raw API send (gmail ... send) is guarded too, not just the +helpers", () => {
    const d = applyEmailPolicy(
      ["gmail", "messages", "send", "--params", "{}"],
      "self-only",
      SELF,
    );
    expect(d.action).toBe("refuse");
  });

  test("allow policy is the pre-guardrail behavior: sends run as approved", () => {
    const d = applyEmailPolicy(["gmail", "+send", "--to", "them@corp.com"], "allow", SELF);
    expect(d.action).toBe("allow");
    expect(d.args).not.toContain("--draft");
  });
});
