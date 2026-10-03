// `prevail missions ...`: the CLI over missions.ts and closeout.ts.

import { readFileSync } from "node:fs";

import { parseModArgs } from "./cli-args.ts";
import { applyCloseout, planCloseout, readReceipts, undoCloseout, type CloseoutPlan } from "./closeout.ts";
import {
  attach, createMission, detach, linkEvent, listMissions, logLine, migrateProjects, milestone, missionTasks, missionView,
  parseDomainArg, readMission, renamePurposeHeading, setBudgetLine, setMission, spend, transition,
  type AttachKind, type MissionDomain, type MissionResult, type MissionStatus, type MissionView,
} from "./missions.ts";

const USAGE = [
  "prevail projects list [--status active|paused|completed|archived|all] --json",
  "prevail projects create --name N [--outcome O] [--target YYYY-MM-DD] [--owner d] [--consult d]... [--inform d]...",
  "        [--app a]... [--specialist s]... [--person id]... [--budget-usd N] [--milestone T]... [--from-prompt-project slug] --json",
  "prevail projects create --from-draft --json   (stdin: the draft from projects draft; checked again)",
  "prevail projects draft --json   (stdin: {\"turns\":[{\"role\":\"user\",\"text\":\"...\"}],\"draft\":{...},\"kind\":\"trip|purchase|learning|build|remodel\"}; creates nothing)",
  "prevail projects starters --json   (the starters per kind: opening, specialists, milestones, questions)",
  "prevail projects show <slug> --json",
  "prevail projects set <slug> [--name N] [--outcome O] [--target D] [--cadence C] [--ceiling C] [--notes T] [--local-only true|false]",
  "        [--match-calendar a,b] [--match-email-from a,b] [--match-merchants a,b] --json",
  "prevail projects attach|detach <slug> --domain d[:role] | --app a | --specialist s | --person id | --entity id | --prompt-project slug | --repo path",
  "prevail projects milestone <slug> add|done|undone|move --title T [--id ms-x] [--due D] [--check C] [--weight N]",
  "prevail projects budget <slug> set-line --line L --usd N [--label T] | spend --line L --usd N --what T [--ref R]",
  "prevail projects event <slug> link|create --title T --start ISO [--event id] [--kind K] [--milestone ms-x]",
  "prevail projects pause|resume|archive|reopen <slug> [--target D] --json",
  "prevail projects complete <slug> --plan-only [--result met|partly|not-met|changed] [--note T] | --apply plan.json --json",
  "prevail projects undo <slug> <n> --json      (a close-out line, within 7 days)",
  "prevail projects tasks <slug> --json",
  "prevail projects log <slug> --text T --json",
  "prevail projects context <slug> [--message M] --json",
  "prevail projects migrate [--dry-run] --json",
  "prevail projects sync | radar | metrics <slug> | track <slug> <key> | events-pending <slug> | event-approve <slug> <id>",
  "prevail projects link-path <slug> <path-id> | from-path <path-id> --json",
].join("\n");

/** Every value of a repeatable flag. */
function all(a: string[], flag: string): string[] {
  return a.flatMap((x, i) => (x === flag && a[i + 1] !== undefined && !a[i + 1]!.startsWith("--") ? [a[i + 1]!] : x.startsWith(`${flag}=`) ? [x.slice(flag.length + 1)] : []));
}

function summary(v: MissionView): string {
  const p = v.progress;
  return `${v.id}  ${v.status}  ${v.name}  day ${p.days.day} of ${p.days.total}, ${p.days.left}d left  milestones ${p.milestones.done}/${p.milestones.total}${p.budget.planned ? `  $${p.budget.used} of $${p.budget.planned}` : ""}`;
}

export async function missionsCommand(argv: string[], vault: string): Promise<number> {
  const args = parseModArgs(argv);
  const sub = args.pos[0] ?? "list";
  const slug = args.pos[1] ?? "";
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (msg: string) => { if (args.json) out({ ok: false, error: msg }); else console.error(`prevail projects: ${msg}`); return 1; };
  const show = (v: MissionView | null) => { if (!v) return fail(`no project "${slug}"`); if (args.json) out(v); else console.log(summary(v)); return 0; };
  const num = (k: string) => { const v = args.get(k); if (v === undefined) return undefined; const n = Number(v); if (!Number.isFinite(n)) throw new Error(`--${k} must be a number`); return n; };
  // Missions MS4: progress without data entry (mission-progress.ts).
  if (["sync", "metrics", "track", "event-create", "event-approve", "events-pending", "link-path", "from-path", "radar"].includes(sub)) return (await import("./mission-progress.ts")).progressCommand(sub, argv, vault);
  try {
    if (sub === "list") {
      const status = (args.get("status") ?? "all") as MissionStatus | "all";
      const l = listMissions(vault, { status });
      if (args.json) out(l); else for (const v of l) console.log(summary(v));
      return 0;
    }
    if (sub === "create" && args.has("from-draft")) {
      let draft: unknown = {};
      try { draft = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { return fail("--from-draft reads the draft JSON on stdin"); }
      const r = await (await import("./mission-draft.ts")).createFromDraft(vault, (draft as { draft?: unknown }).draft ?? draft);
      if (args.json) out({ ...r.mission, dropped: r.dropped }); else console.log(summary(r.mission));
      return 0;
    }
    if (sub === "create") {
      const name = args.get("name");
      if (!name) return fail(`usage:\n${USAGE}`);
      const domains: MissionDomain[] = [
        ...all(argv, "--owner").map((d) => parseDomainArg(d, "owner")),
        ...all(argv, "--consult").map((d) => parseDomainArg(d, "consulted")),
        ...all(argv, "--inform").map((d) => parseDomainArg(d, "informed")),
        ...all(argv, "--domain").map((d) => parseDomainArg(d)),
      ];
      const pp = args.get("from-prompt-project");
      return show(createMission(vault, {
        name, outcome: args.get("outcome"), why: args.get("why"), target: args.get("target"), domains,
        apps: all(argv, "--app"), specialists: all(argv, "--specialist"), people: all(argv, "--person"), entities: all(argv, "--entity"),
        budgetUsd: num("budget-usd"), hoursWk: num("hours-wk"), ceiling: args.get("ceiling") as never,
        milestones: all(argv, "--milestone").map((t) => ({ title: t })),
        promptProjects: pp ? [pp] : [], from: pp ? `from the prompt project ${pp}` : args.get("from-suggestion") ? `from the suggestion ${args.get("from-suggestion")}` : undefined,
      }));
    }
    // Chat-first New mission: the fields from what was said, checked; never creates.
    if (sub === "draft") {
      let input: { turns?: unknown; draft?: unknown; kind?: unknown } = {};
      try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { return fail("draft reads JSON on stdin: {turns, draft, kind?}"); }
      const { draftMission } = await import("./mission-draft.ts");
      out(await draftMission(vault, { turns: Array.isArray(input.turns) ? input.turns as never : [], draft: (input.draft && typeof input.draft === "object" ? input.draft : {}) as never, ...(typeof input.kind === "string" ? { kind: input.kind } : {}) }));
      return 0;
    }
    // Starters per kind: a trip, a purchase, learning, a build, a remodel.
    if (sub === "starters") { out((await import("./mission-draft.ts")).STARTERS); return 0; }
    if (!slug && sub !== "migrate") return fail(`usage:\n${USAGE}`);
    if (sub === "show") return show(missionView(vault, slug));
    if (sub === "set") {
      const lo = args.get("local-only");
      return show(setMission(vault, slug, {
        name: args.get("name"), outcome: args.get("outcome"), why: args.get("why"), target: args.get("target"), cadence: args.get("cadence"),
        ceiling: args.get("ceiling"), notes: args.get("notes"), goal: args.get("goal"), path: args.get("path"),
        ...(lo !== undefined ? { localOnly: lo === "true" } : {}), budgetUsd: num("budget-usd"), hoursWk: num("hours-wk"),
        nudgesPerWeek: num("nudges"),
        // Match rules (MS4): comma-separated; an empty value clears that rule.
        ...(["match-calendar", "match-email-from", "match-merchants"].some((k) => args.get(k) !== undefined) ? { match: {
          ...(args.get("match-calendar") !== undefined ? { calendar: args.get("match-calendar")!.split(",").map((x) => x.trim()).filter(Boolean) } : {}),
          ...(args.get("match-email-from") !== undefined ? { email_from: args.get("match-email-from")!.split(",").map((x) => x.trim()).filter(Boolean) } : {}),
          ...(args.get("match-merchants") !== undefined ? { merchants: args.get("match-merchants")!.split(",").map((x) => x.trim()).filter(Boolean) } : {}),
        } } : {}),
      }));
    }
    if (sub === "attach" || sub === "detach") {
      const kinds: AttachKind[] = ["domain", "app", "specialist", "person", "entity", "prompt-project", "repo"];
      const kind = kinds.find((k) => args.get(k) !== undefined);
      if (!kind) return fail(`usage: prevail projects ${sub} <slug> --domain d[:role] | --app a | --specialist s | --person id | --entity id | --prompt-project slug | --repo path`);
      return show((sub === "attach" ? attach : detach)(vault, slug, kind, args.get(kind)!));
    }
    if (sub === "milestone") {
      const op = args.pos[2] as "add" | "done" | "undone" | "move";
      if (!["add", "done", "undone", "move"].includes(op)) return fail("usage: prevail projects milestone <slug> add|done|undone|move --title T [--id ms-x] [--due D] [--check C]");
      const ms = milestone(vault, slug, op, { title: args.get("title"), id: args.get("id"), due: args.get("due"), check: args.get("check"), weight: num("weight") });
      if (args.json) out({ ok: true, milestones: ms }); else for (const m of ms) console.log(`[${m.done ? "x" : " "}] ${m.title}${m.due ? `  ${m.due}` : ""}  ${m.id}`);
      return 0;
    }
    if (sub === "budget") {
      const op = args.pos[2];
      const line = args.get("line") ?? "";
      const usd = num("usd");
      if (usd === undefined || !line) return fail("usage: prevail projects budget <slug> set-line --line L --usd N | spend --line L --usd N --what T [--ref R]");
      if (op === "set-line") return show(setBudgetLine(vault, slug, line, usd, args.get("label")));
      if (op === "spend") {
        const r = spend(vault, slug, { line, usd, what: args.get("what") ?? line, ref: args.get("ref") });
        if (args.json) out({ ok: true, ...r, mission: missionView(vault, slug) }); else console.log(r.added ? `recorded $${usd} on ${r.row.line}` : `already recorded (${r.row.ref})`);
        return 0;
      }
      return fail("budget takes set-line or spend");
    }
    if (sub === "event") {
      const op = args.pos[2];
      if (op !== "link" && op !== "create") return fail("usage: prevail projects event <slug> link|create --title T --start ISO");
      // Create is a hold that asks (or, with other people, a draft invite): mission-progress createEvent.
      if (op === "create") { const e = (await import("./mission-progress.ts")).createEvent(vault, slug, { title: args.get("title") ?? "", start: args.get("start") ?? "", end: args.get("end"), attendees: args.get("attendees")?.split(",").map((x) => x.trim()).filter(Boolean), milestone: args.get("milestone") }); if (args.json) out({ ok: true, pending: e, note: e.status === "draft" ? "a draft invite; Prevail never sends it" : "a hold that waits for your yes; nothing was added to a calendar" }); else console.log(e.status === "draft" ? "Drafted." : "A hold waits for your yes."); return 0; }
      const l = linkEvent(vault, slug, { title: args.get("title") ?? "", start: args.get("start") ?? "", event: args.get("event"), app: args.get("app"), kind: args.get("kind"), milestone: args.get("milestone") });
      if (args.json) out({ ok: true, links: l }); else console.log(`${l.calendar.length} event(s) linked`);
      return 0;
    }
    if (sub === "pause" || sub === "resume" || sub === "archive" || sub === "reopen") return show(transition(vault, slug, sub, { target: args.get("target") }));
    if (sub === "complete") {
      if (args.has("plan-only") || !args.has("apply")) {
        const plan = planCloseout(vault, slug, { result: args.get("result") as MissionResult | undefined, resultNote: args.get("note") });
        if (args.json) out(plan); else { console.log(plan.summary); for (const f of plan.filings) console.log(`  ${f.n}. [${f.apply ? "x" : " "}] ${f.kind} -> ${f.domain}: ${f.text}`); }
        return 0;
      }
      const file = args.get("apply") ?? args.pos[2];
      if (!file) return fail("usage: prevail projects complete <slug> --apply plan.json");
      const plan = JSON.parse(file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8")) as CloseoutPlan;
      if (plan.slug !== readMission(vault, slug)?.slug) return fail("the plan is for another project");
      const r = applyCloseout(vault, plan);
      if (args.json) out({ ok: true, ...r }); else console.log(`completed ${r.mission.id}; ${r.receipts.length} line(s) filed`);
      return 0;
    }
    if (sub === "undo") {
      const r = undoCloseout(vault, slug, Number(args.pos[2] ?? args.get("n")));
      if (args.json) out({ ok: true, receipt: r }); else console.log(`undone: ${r.text}`);
      return 0;
    }
    if (sub === "filed") { const r = readReceipts(vault, slug); if (args.json) out(r); else for (const x of r) console.log(`${x.n}. ${x.undone ? "(undone) " : ""}${x.domain}: ${x.text}`); return 0; }
    if (sub === "tasks") { const t = missionTasks(vault, slug); if (args.json) out(t); else for (const x of t) console.log(`[${x.done ? "x" : " "}] ${x.text}  (${x.domain})`); return 0; }
    if (sub === "log") {
      const text = args.get("text") ?? args.pos.slice(2).join(" ");
      if (!text.trim()) return fail("usage: prevail projects log <slug> --text T");
      if (!readMission(vault, slug)) return fail(`no project "${slug}"`);
      const line = logLine(vault, slug, text);
      if (args.json) out({ ok: true, line }); else console.log(line);
      return 0;
    }
    if (sub === "context") {
      const { resolveScope } = await import("./scope.ts");
      const s = await resolveScope(vault, { mission: slug, message: args.get("message") ?? "" });
      if (args.json) out({ ok: true, label: s.label, cwd: s.cwd, key: s.key, blocks: s.blocks, dispatch: s.dispatch, apps: s.appIds, privacy: s.privacy });
      else console.log(s.blocks.map((b) => b.text).join("\n\n---\n\n"));
      return 0;
    }
    if (sub === "migrate") {
      const { entityThreads } = await import("./entities.ts");
      const r = migrateProjects(vault, { dryRun: args.has("dry-run"), threadsOf: (id) => entityThreads(vault, id) });
      const purpose = args.has("dry-run") ? { renamed: false } : await renamePurposeHeading(vault);
      if (!args.has("dry-run") && r.migrated.length) { try { (await import("./entities.ts")).buildIndex(vault); } catch { /* refresh rebuilds it */ } }
      if (args.json) out({ ...r, purpose });
      else {
        for (const m of r.migrated) console.log(`${m.from} -> data/missions/${m.slug}${m.conflict ? " (beside an existing mission: mission.conflict.md)" : ""}`);
        if (!r.migrated.length) console.log("no entity projects to migrate");
        if (purpose.renamed) console.log("build/compass.md: ## Mission is now ## Purpose (the prior text is in compass.versions/)");
      }
      return r.ok ? 0 : 1;
    }
  } catch (e) { return fail((e as Error).message); }
  return fail(`usage:\n${USAGE}`);
}
