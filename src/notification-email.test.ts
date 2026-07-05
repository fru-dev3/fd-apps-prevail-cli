import { describe, expect, test } from "bun:test";
import { renderNotificationEmail, markdownToEmailHtml } from "./notification-email.ts";

// The notification design system contract: branded header, rendered markdown
// (never raw ## / ** walls), and a full provenance footer (producer, machine,
// version, in-app path). No emojis anywhere (house rule).
describe("branded notification email", () => {
  const meta = { kind: "loop-briefing", name: "PostHog Briefing", domain: "posthog", cadence: "weekly", appPath: "Domains > PostHog > Loops > PostHog Briefing" };
  const md = "## posthog briefing\n\n**TL;DR**: Nothing tracked yet.\n\n**Next steps**:\n- Decide what matters\n- Set a cadence";

  test("subject is branded and names the producer + domain", () => {
    const r = renderNotificationEmail(meta, md);
    expect(r.subject).toBe("Prevail · PostHog Briefing · Posthog");
  });

  test("markdown actually renders - no raw ## or ** in the html", () => {
    const r = renderNotificationEmail(meta, md);
    expect(r.html).not.toContain("##");
    expect(r.html).not.toContain("**");
    expect(r.html).toContain("<strong>TL;DR</strong>");
    expect(r.html).toContain("<li");
    expect(r.html).toContain("posthog briefing"); // heading text survived
  });

  test("branding + provenance: wordmark, kind chip, producer, machine, version, app path", () => {
    const r = renderNotificationEmail(meta, md, new Date("2026-07-04T22:00:00Z"));
    expect(r.html).toContain("PREV");
    expect(r.html).toContain("LOOP BRIEFING");
    expect(r.html).toContain("Sent by the loop &quot;PostHog Briefing&quot;".replace("&quot;", "\"").replace("&quot;", "\"")); // quotes escape-agnostic
    expect(r.html).toContain("weekly");
    expect(r.html).toContain("Prevail engine v");
    expect(r.html).toContain("Open in Prevail: Domains &gt; PostHog &gt; Loops");
    expect(r.html).toContain("2026-07-04 22:00:00 UTC");
  });

  test("plain-text fallback keeps the body and the provenance", () => {
    const r = renderNotificationEmail(meta, md);
    expect(r.text).toContain("**TL;DR**");
    expect(r.text).toContain("Prevail engine v");
  });

  test("email-safe: no external assets, no scripts, no emoji", () => {
    const r = renderNotificationEmail(meta, md);
    expect(r.html).not.toMatch(/<script|src=|http:\/\/|https:\/\//);
    expect(r.html).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  test("markdownToEmailHtml escapes injected html", () => {
    expect(markdownToEmailHtml("<img onerror=x> **bold**")).not.toContain("<img");
  });
});
