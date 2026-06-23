import { describe, expect, test } from "bun:test";
import { classifyAction, isConsequential } from "./action-policy.ts";

describe("classifyAction — action risk taxonomy (C1/A-05)", () => {
  test("classifies by highest-risk match", () => {
    expect(classifyAction("Pay the $200 invoice")).toBe("financial");
    expect(classifyAction("Delete the old tax records")).toBe("irreversible");
    expect(classifyAction("Email the recruiter back")).toBe("external_send");
    expect(classifyAction("Rotate the API key")).toBe("credential");
    expect(classifyAction("Draft a note in the journal")).toBe("reversible");
    expect(classifyAction("Summarize this week's spending")).toBe("read");
    expect(classifyAction("")).toBe("unknown");
  });

  test("send+delete is treated at the higher risk (irreversible before external_send)", () => {
    expect(classifyAction("delete the account and email them")).toBe("irreversible");
  });

  test("isConsequential flags the action classes needing approval", () => {
    expect(["financial", "irreversible", "external_send", "credential"].every((c) => isConsequential(c as never))).toBe(true);
    expect(isConsequential("read")).toBe(false);
    expect(isConsequential("reversible")).toBe(false);
  });
});
