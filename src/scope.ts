// One scope resolver for every chat (missions-plan.md, "Chat parity"). A
// domain, an app's own space, an entity chat and a mission all go through
// resolveScope: it picks the folder the turn runs in, the key its thread is
// stored under, the context blocks that lead the message, and what dispatch
// may do there. A mission is a scope, never a fork of the chat code.
//
// The constitution, profile, Compass, chief of staff and life goals are added
// by cli-bridge from the turn's folder, the same for every scope. This module
// builds the blocks that depend on the scope: a mission's outcome, progress,
// memory, tasks, calendar and attached apps, people and domains; and the
// entity, app and referenced-domain blocks a turn names.
//
// Domain, app and entity turns produce byte-identical context to before this
// module existed (scope-parity.test.ts).

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appChatBlock, refDomainBlock } from "./app-scope.ts";
import type { MirrorApp } from "./apps-mirror.ts";
import { generalDir } from "./decisions.ts";
import { entityChatBlock } from "./entities.ts";
import { GOOGLE_APP_RE } from "./gws-gateway.ts";
import {
  activeMissions, budgetLeft, domainsWith, missionBrief, missionLocalOnly, missionPointer, missionTasks, missionView, ownerOf,
  type Mission, type MissionDomain,
} from "./missions.ts";
import { APP_SCOPE_PREFIX, appScopeId, MISSION_SCOPE_PREFIX, missionScopeSlug, resolveDomainDir } from "./path-safety.ts";
import type { Ceiling } from "./specialists.ts";
import { scanVault, type Domain } from "./vault.ts";
import { vreadFile } from "./vault-session.ts";

export interface ScopeInput {
  domain?: string;
  scopeApp?: string;
  mission?: string;
  entity?: string | string[];
  apps?: string[];
  refDomains?: string[];
  googleAccount?: string;
  message?: string;
  mirrorApps?: (vault: string) => MirrorApp[];
}

export interface ContextBlock { source: string; text: string }

export interface ScopeDispatch {
  allowed: boolean;
  defaultOwner: string;
  domains?: MissionDomain[];
  specialists?: string[];
  apps?: string[];
  ceiling?: Ceiling;
  budgetLeftUsd?: number | null;
}

export interface ResolvedScope {
  kind: "domain" | "app" | "entity" | "mission";
  /** The thread space key (a domain slug, `_app-<id>` or `_mission-<slug>`). */
  key: string;
  domain: Domain;
  cwd: string;
  label: string;
  appIds: string[];
  apps: MirrorApp[];
  entityIds: string[];
  blocks: ContextBlock[];
  dispatch: ScopeDispatch;
  privacy: { localOnly: boolean };
  goals: { ids: string[] };
  mission?: Mission;
}

const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
// Every referenced entity shares this many characters of context.
const ENTITY_BUDGET = 8000;
// A mission's people and entities share less, beside its other blocks.
const MISSION_PEOPLE_BUDGET = 6000;

const uniq = (xs: (string | undefined)[] | undefined): string[] => [...new Set((xs ?? []).map((x) => (x ?? "").trim()).filter(Boolean))];
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")}\n(cut)` : s);
function readText(p: string): string {
  if (!existsSync(p)) return "";
  try { return vreadFile(p); } catch { try { return readFileSync(p, "utf8"); } catch { return ""; } }
}

export class ScopeError extends Error {}

/** Resolve one chat turn's scope. Throws ScopeError with the message the stream reports. */
export async function resolveScope(vault: string, i: ScopeInput): Promise<ResolvedScope> {
  const missionSlug = (i.mission ?? "").trim() ? missionScopeSlug(`mission/${(i.mission ?? "").trim().replace(/^(mission|project)\//, "")}`) : missionScopeSlug(i.domain ?? "");
  if ((i.mission ?? "").trim() && !missionSlug) throw new ScopeError(`invalid project: ${i.mission}`);
  if (missionSlug) return resolveMission(vault, missionSlug, i);

  // An app's own chat space: --scope-app <id> is the `_app-<id>` scope key,
  // stored under data/apps/<id>/_scope like any other thread space.
  const scopeApp = (i.scopeApp ?? "").trim() || appScopeId(i.domain ?? "") || "";
  if (scopeApp && !APP_ID_RE.test(scopeApp)) throw new ScopeError(`invalid app id: ${scopeApp}`);
  const key = scopeApp ? `${APP_SCOPE_PREFIX}${scopeApp}` : i.domain ?? "";
  const appIds = uniq([...(scopeApp ? [scopeApp] : []), ...(i.apps ?? [])]);
  const badApp = appIds.find((id) => !APP_ID_RE.test(id));
  if (badApp) throw new ScopeError(`invalid app id: ${badApp}`);

  let domain: Domain | null = scopeApp ? null : scanVault(vault).find((d) => d.name === key) ?? null;
  if (scopeApp) {
    const dir = resolveDomainDir(vault, key);
    try { mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
    domain = { name: key, path: dir, hasState: false, openLoopCount: 0, stateMtime: null, skills: [] };
  }
  // General may not be scaffolded on disk yet (no chats stored there). It's a
  // real, addressable space, so synthesize it at general_dir rather than
  // failing; this is what lets domainless General chat run.
  const wantName = (i.domain ?? "").trim();
  if (!domain && (wantName === "general" || wantName === "__general__" || wantName === "")) {
    const gdir = generalDir(vault);
    try { mkdirSync(gdir, { recursive: true }); } catch { /* best effort */ }
    domain = { name: "general", path: gdir, hasState: false, openLoopCount: 0, stateMtime: null, skills: [] };
  }
  if (!domain) throw new ScopeError(`unknown domain: ${i.domain}`);
  const entityIds = uniq(Array.isArray(i.entity) ? i.entity : [i.entity]);
  const apps = appIds.length ? (i.mirrorApps?.(vault) ?? []) : [];
  const blocks = await namedBlocks(vault, { entityIds, appIds, apps, googleAccount: i.googleAccount, refDomains: i.refDomains, self: key, entityBudget: ENTITY_BUDGET });
  // A domain turn that names an active mission gets a one-line pointer to it
  // (it never pulls the whole mission in). Absent when nothing is named.
  if (!scopeApp && !entityIds.length && i.message) {
    try { const p = missionPointer(vault, key, i.message); if (p) blocks.push({ source: "missions", text: p }); } catch { /* a pointer is a nicety */ }
  }
  const kind = scopeApp ? "app" : entityIds.length ? "entity" : "domain";
  return {
    kind, key, domain, cwd: domain.path, label: scopeApp ? scopeApp : domain.name, appIds, apps, entityIds, blocks,
    // Dispatch runs on domain turns only; never on an app or entity chat.
    dispatch: { allowed: kind === "domain", defaultOwner: key || "general" },
    privacy: { localOnly: false },
    goals: { ids: [] },
  };
}

/** The entity, app, Google-accounts and referenced-domain blocks, in this order. */
async function namedBlocks(vault: string, o: { entityIds: string[]; appIds: string[]; apps: MirrorApp[]; googleAccount?: string; refDomains?: string[]; self: string; entityBudget: number }): Promise<ContextBlock[]> {
  const blocks: ContextBlock[] = [];
  const perEntity = o.entityIds.length ? Math.min(6000, Math.floor(o.entityBudget / o.entityIds.length)) : 0;
  // A broken entity lookup never blocks the turn; it just runs unscoped.
  for (const id of o.entityIds) {
    // @ a mission: a short brief of it, never the whole mission.
    if (id.startsWith("mission/")) { const b = missionBrief(vault, id); if (b) blocks.push({ source: `mission-ref:${id}`, text: b }); continue; }
    try { blocks.push({ source: `entity:${id}`, text: entityChatBlock(vault, id, perEntity) }); } catch { /* unscoped */ }
  }
  for (const id of o.appIds) {
    try { blocks.push({ source: `app:${id}`, text: appChatBlock(vault, id, o.apps.find((a) => a.id === id) ?? null) }); } catch { /* skip */ }
  }
  // --google-account all: reads fan out across every gws account, one call per
  // account; drafts and writes go to the default account only, and queue.
  // "claude" names Claude's own one-account connector: no gws pick.
  const googlePick = o.googleAccount?.trim() && o.googleAccount.trim().toLowerCase() !== "claude" ? o.googleAccount.trim() : undefined;
  if (googlePick?.toLowerCase() === "all") {
    try {
      const { googleAccounts } = await import("./gws-gateway.ts");
      const { boundGoogleAccountLabel } = await import("./vault.ts");
      const accts = googleAccounts(o.appIds.find((id) => GOOGLE_APP_RE.test(id)) ?? "google", { bound: boundGoogleAccountLabel(vault) });
      if (accts.length) {
        const def = accts.find((x) => x.default);
        blocks.push({ source: "google-accounts", text: [
          "# GOOGLE ACCOUNTS: all",
          `The user chose all their Google accounts: ${accts.map((x) => x.id).join(", ")}.`,
          "For reads, call the google_workspace tool once per account with account set to that account, and label every result with its account.",
          `Drafts and writes go to exactly one account: ${def ? def.id : "none is the default, so ask the user which one"}. They queue for the user's approval. Never send.`,
        ].join("\n") });
      }
    } catch { /* the connector still refuses unlabeled reads */ }
  }
  for (const d of uniq(o.refDomains)) {
    if (d === o.self) continue;
    try { const b = refDomainBlock(vault, d); if (b) blocks.push({ source: `domain:${d}`, text: b }); } catch { /* skip */ }
  }
  return blocks;
}

function skillNames(dir: string): string[] {
  try { return readdirSync(join(dir, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith(".")).map((e) => e.name).slice(0, 20); } catch { return []; }
}

async function resolveMission(vault: string, slug: string, i: ScopeInput): Promise<ResolvedScope> {
  const v = missionView(vault, slug);
  if (!v) throw new ScopeError(`unknown project: ${slug}`);
  const key = `${MISSION_SCOPE_PREFIX}${slug}`;
  const dir = resolveDomainDir(vault, key);
  const owner = ownerOf(v);
  const ownerDir = owner ? resolveDomainDir(vault, owner) : "";
  const blocks: ContextBlock[] = [];
  const p = v.progress;

  // Who is speaking and what this is. One voice: the user's chief of staff,
  // speaking from inside the mission; the scope decides context and authority.
  const role = (r: string) => domainsWith(v, r as "owner").join(", ") || "none";
  const chain = (await import("./compass-chain.ts")).missionChainText(vault, v.slug);
  blocks.push({ source: "mission", text: clip([
    `# PROJECT: ${v.name}`,
    `This conversation is the project ${v.name} (mission/${v.slug}), ${v.status}. You are the user's chief of staff, speaking from inside this project: bring in its domains, apps and people on your own; the user never has to staff it.`,
    `Outcome: ${v.outcome || "not written yet; ask for it in one line"}`,
    v.why ? `Why, in the user's words: ${v.why}` : "",
    `Day ${p.days.day} of ${p.days.total}; target ${v.target || "none (propose one)"}${p.days.left < 0 ? `, ${-p.days.left} days past it` : `, ${p.days.left} days left`}.`,
    `Owner domain: ${role("owner")}. Reads: ${role("consulted")}. Tells: ${role("informed")}.`,
    v.apps.length ? `Apps: ${v.apps.join(", ")}.` : "",
    v.specialists.length ? `Specialists: ${v.specialists.join(", ")}.` : "",
    chain ? `Carries out (the Compass chain, nearest first): ${chain}.` : v.goal || v.path ? `Carries out: ${[v.goal, v.path].filter(Boolean).join(" > ")}.` : "Unlinked to the Compass.",
    `Anything outside these domains needs the user's yes before you read it. Acting, sending, spending and anything touching other people always ask.`,
    owner ? `\n## Owner domain ideal (${owner})\n${clip(readText(join(ownerDir, "ideal-state.md")).trim(), 1000) || "none written"}` : "",
  ].filter(Boolean).join("\n"), 2600) });

  // Goals: the owner domain's (the life goals come from cli-bridge).
  if (owner) {
    const { readDomainGoals } = await import("./goals.ts");
    const g = readDomainGoals(vault, owner).filter((x) => x.status === "active").slice(0, 6);
    if (g.length) blocks.push({ source: `goals:${owner}`, text: [`# ${owner.toUpperCase()} GOALS (the owner domain)`, ...g.map((x) => `- ${x.title}${x.due ? ` (by ${x.due})` : ""}`)].join("\n") });
  }

  // Progress: milestones, budget, days.
  const open = v.milestones.filter((x) => !x.done);
  blocks.push({ source: "progress", text: clip([
    `# PROJECT PROGRESS`,
    `Milestones: ${p.milestones.done} of ${p.milestones.total} done${p.milestones.next ? `; next: ${p.milestones.next.title}${p.milestones.next.due ? ` by ${p.milestones.next.due}` : ""}` : ""}.`,
    ...open.slice(0, 6).map((x) => `- [ ] ${x.title}${x.due ? ` (due ${x.due})` : ""}${x.check ? ` (completes when ${x.check})` : ""}`),
    p.milestones.overdue.length ? `Overdue: ${p.milestones.overdue.map((x) => x.title).join("; ")}.` : "",
    p.budget.planned ? `Budget: $${p.budget.used.toFixed(2)} of $${p.budget.planned.toFixed(2)} spent (${Math.round(p.budget.share * 100)}%)${p.budget.byLine.length ? `: ${p.budget.byLine.map((l) => `${l.label} $${l.used} of $${l.planned}`).join(", ")}` : ""}.` : "No budget set.",
  ].filter(Boolean).join("\n"), 1500) });

  // Memory and state: the mission's own, the owner's memory, consulted states.
  const log = readText(join(dir, "memory", "log.md")).split("\n").filter((l) => /^\s*-\s/.test(l)).slice(0, 10);
  const mem = [
    `# PROJECT MEMORY`,
    clip(readText(join(dir, "memory", "state.md")).trim(), 1200),
    clip(readText(join(dir, "memory", "memory.md")).trim(), 1500),
    log.length ? `## Recent log\n${log.join("\n")}` : "",
    owner ? `## ${owner} memory (owner)\n${clip(readText(join(ownerDir, "memory", "memory.md")).trim(), 1500) || "Nothing recorded yet."}` : "",
    ...domainsWith(v, "consulted").map((d) => {
      const dd = resolveDomainDir(vault, d);
      return `## ${d} state (consulted)\n${clip((readText(join(dd, "memory", "state.md")) || readText(join(dd, "state.md"))).trim(), 1000) || "Nothing recorded yet."}`;
    }),
  ].filter(Boolean).join("\n\n");
  blocks.push({ source: "memory", text: clip(mem, 5000) });

  // Tasks: the mission's own and ~mission:<slug> tasks in any domain.
  const tasks = missionTasks(vault, slug).filter((t) => !t.done).slice(0, 12);
  if (tasks.length) blocks.push({ source: "tasks", text: [`# PROJECT TASKS`, ...tasks.map((t) => `- ${t.text}${t.due ? ` (due ${t.due})` : ""}${t.own ? "" : ` [${t.domain}]`}`)].join("\n") });

  // Calendar: today's linked events and the next five.
  const today = new Date().toISOString().slice(0, 10);
  const events = v.links.calendar.filter((e) => e.start.slice(0, 10) >= today).slice(0, 5);
  if (events.length) blocks.push({ source: "calendar", text: [`# PROJECT CALENDAR`, ...events.map((e) => `- ${e.start.replace("T", " ")} ${e.title}${e.source === "created" ? " (a hold you drafted)" : ""}`)].join("\n") });

  // Skills: the mission's own (if any) and the owner domain's.
  const skills = uniq([...skillNames(dir), ...(owner ? skillNames(ownerDir) : [])]);
  if (skills.length) blocks.push({ source: "skills", text: `# SKILLS\nAvailable here: ${skills.join(", ")}.` });

  // Prompt groups (build missions): their restart briefs.
  for (const pp of v.prompt_projects.slice(0, 2)) {
    try {
      const { restartText } = await import("./project-restart.ts");
      const t = restartText(vault, pp, "handoff");
      if (t.trim()) blocks.push({ source: `prompt-project:${pp}`, text: clip(`# PROMPT PROJECT: ${pp}\n${t.trim()}`, 2000) });
    } catch { /* not built yet */ }
  }

  // The attached apps and people, then whatever this turn names (@refs).
  const appIds = uniq([...v.apps, ...(i.apps ?? [])]).filter((id) => APP_ID_RE.test(id));
  const apps = appIds.length ? (i.mirrorApps?.(vault) ?? []) : [];
  const people = uniq([...v.people, ...v.entities]);
  const named = uniq(Array.isArray(i.entity) ? i.entity : [i.entity]);
  const peopleBlocks = await namedBlocks(vault, { entityIds: people, appIds: [], apps, self: key, entityBudget: MISSION_PEOPLE_BUDGET });
  const rest = await namedBlocks(vault, { entityIds: named.filter((x) => !people.includes(x)), appIds, apps, googleAccount: i.googleAccount, refDomains: i.refDomains, self: key, entityBudget: ENTITY_BUDGET });
  blocks.push(...peopleBlocks, ...rest);

  return {
    kind: "mission", key,
    domain: { name: key, path: dir, hasState: existsSync(join(dir, "memory", "state.md")), openLoopCount: 0, stateMtime: null, skills: [] },
    cwd: dir, label: v.name, appIds, apps, entityIds: uniq([...people, ...named]), blocks,
    dispatch: {
      allowed: v.status === "active", defaultOwner: v.id, domains: v.domains, specialists: v.specialists, apps: v.apps,
      ceiling: v.ceiling, budgetLeftUsd: budgetLeft(vault, v),
    },
    privacy: { localOnly: missionLocalOnly(vault, v) },
    goals: { ids: [v.goal, v.path].filter((x): x is string => !!x) },
    mission: v,
  };
}

/** The leading context a turn sends ahead of the message, joined as before. */
export function leadText(blocks: ContextBlock[], preamble?: string): string {
  return [...blocks.map((b) => b.text), preamble?.trim() ?? ""].filter(Boolean).join("\n\n---\n\n");
}

/** For `@` and routing: every active mission's id and name. */
export function missionRefs(vault: string): { id: string; name: string }[] {
  return activeMissions(vault).map((m) => ({ id: m.id, name: m.name }));
}
