// Telegram and missions (Missions MS5, Today T6): what the bot does with a
// message before it ever reaches a model, so it can be tested without a
// network (the daemon only sends what these return).
//
//   /m <name>      pin this chat to an active mission (by slug or its words);
//                  /m shows the pin and the active missions; /m off unpins
//   /tell <text>   file anything (tell.ts), in the pinned mission if any
//   /forget        what am I forgetting
//   free text      "what am I forgetting?" and explicit capture ("remind me
//                  to", "note that") are filed by code; practice or a spend
//                  ("practiced 30 min", "paid $120 for the term fee") goes to
//                  the pinned mission, or the mission the words point at;
//                  anything else is a chat turn, inside the pinned mission
//                  (its brief first, its folder as the place to work).

import { CAPTURE, FORGETTING, forgetting, forgettingText, missionForText, tell, toldReply } from "./tell.ts";
import { statedNumbers } from "./said.ts";

export interface Pin { mission?: string }

const PAY = /\b(paid|spent|bought [^$]{0,40}for)\s+(?:about\s+)?\$\s?[\d,]+/i;

/** A /command this module answers, or null when it is not one of ours. */
export async function telegramCommand(head: string, arg: string, vault: string, pin: Pin): Promise<string | null> {
  const m = await import("./missions.ts");
  if (head === "/m" || head === "/mission") {
    const a = arg.trim();
    const active = m.activeMissions(vault);
    if (!a) {
      const cur = pin.mission ? m.readMission(vault, pin.mission) : null;
      return [cur ? `Pinned to the mission ${cur.name}. /m off to unpin.` : "Not pinned to a mission.", active.length ? `Active missions: ${active.map((x) => `${x.name} (/m ${x.slug})`).join(", ")}` : "No active missions."].join("\n");
    }
    if (/^(off|none|clear)$/i.test(a)) { delete pin.mission; return "Unpinned. Messages go to your chief of staff as usual."; }
    const bySlug = active.find((x) => x.slug === m.missionSlugify(a));
    const hit = bySlug ?? (await missionForText(vault, a).then((r) => (r ? active.find((x) => x.slug === r.slug) : undefined)));
    if (!hit) return `No active mission matches "${a}". /m to list them.`;
    pin.mission = hit.slug;
    return `Pinned to the mission ${hit.name}. What you send now goes there; practice and spends count on its progress. /m off to unpin.`;
  }
  if (head === "/tell") {
    if (!arg.trim()) return "Send /tell and anything to keep, like /tell remind me to renew the passport by Friday";
    const r = await tell(vault, arg, { surface: "telegram", ...(pin.mission ? { mission: pin.mission } : {}) });
    return `${toldReply(r)} (undo: prevail tell undo ${r.id})`;
  }
  if (head === "/forget" || head === "/forgetting") return forgettingText(await forgetting(vault));
  return null;
}

/** Free text: a reply filed by code, or the prompt (and folder) for a chat turn. */
export async function telegramText(text: string, vault: string, pin: Pin): Promise<{ reply: string } | { prompt: string; cwd?: string; mission?: string }> {
  const t = text.trim();
  if (FORGETTING.test(t) && t.length < 140) return { reply: forgettingText(await forgetting(vault)) };
  if (CAPTURE.test(t)) {
    const r = await tell(vault, t, { surface: "telegram", ...(pin.mission ? { mission: pin.mission } : {}) });
    return { reply: toldReply(r) };
  }
  const isPractice = statedNumbers(t).some((s) => s.what === "practiced") || PAY.test(t);
  if (isPractice) {
    const target = pin.mission ?? (await missionForText(vault, t))?.slug;
    if (target) {
      const r = await tell(vault, t, { surface: "telegram", mission: target });
      if (r.kind === "practice" || r.kind === "spend") return { reply: toldReply(r) };
    }
  }
  if (pin.mission) {
    const m = await import("./missions.ts");
    const brief = m.missionBrief(vault, pin.mission);
    if (brief) return { prompt: `${brief}\nYou are the user's chief of staff, speaking from inside this mission.\n\n${t}`, cwd: m.missionDir(vault, pin.mission), mission: pin.mission };
  }
  return { prompt: t };
}
