import { describe, expect, test } from "bun:test";
import { normalizeGoogleEvents } from "./calendar-sync.ts";

describe("normalizeGoogleEvents", () => {
  test("normalizes an all-day event and a timed event to the desktop shape", () => {
    const raw = {
      items: [
        {
          id: "allday1",
          summary: "Company Holiday",
          start: { date: "2026-07-04" },
          htmlLink: "https://calendar.google.com/event?eid=allday1",
        },
        {
          id: "timed1",
          summary: "Standup",
          start: { dateTime: "2026-07-01T09:30:00-07:00" },
          htmlLink: "https://calendar.google.com/event?eid=timed1",
        },
      ],
    };

    const events = normalizeGoogleEvents(raw);
    expect(events).toEqual([
      {
        id: "allday1",
        title: "Company Holiday",
        date: "2026-07-04",
        url: "https://calendar.google.com/event?eid=allday1",
      },
      {
        id: "timed1",
        title: "Standup",
        date: "2026-07-01",
        url: "https://calendar.google.com/event?eid=timed1",
      },
    ]);
  });

  test("skips items with no usable date", () => {
    const raw = {
      items: [
        { id: "nodate", summary: "Floating note", start: {} },
        { id: "ok", summary: "Real", start: { date: "2026-01-15" }, htmlLink: "x" },
      ],
    };
    const events = normalizeGoogleEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("ok");
  });

  test("falls back to (untitled) and empty url, tolerates non-object input", () => {
    expect(normalizeGoogleEvents({})).toEqual([]);
    expect(normalizeGoogleEvents(null)).toEqual([]);
    const events = normalizeGoogleEvents({ items: [{ start: { date: "2026-03-03" } }] });
    expect(events).toEqual([{ id: "", title: "(untitled)", date: "2026-03-03", url: "" }]);
  });
});
