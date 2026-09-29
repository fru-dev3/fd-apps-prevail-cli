// Projects: the efforts the owner is working toward, with an outcome and an
// end (learning an instrument, a trip, a build). A project is an entity of kind
// `project` in the usual entity folder, data/entities/projects/<slug>/
// (entity.md, picture, files/, updates.jsonl), so every entity command works
// on `project/<slug>`. Its page frontmatter adds:
//   status: active|paused|done|archived
//   outcome: one line, what done looks like
//   target: YYYY-MM-DD (optional)
//   domains: [slug]
//   intent_project: <Intent project slug> (optional; the one it came from)
// Projects are always "yours" and never fade. Archiving sets status archived;
// nothing is deleted.
//
// Goals link to a project with `~project:<slug>` on their line in any
// domain's source/goals.md.

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  PROJECT_STATUSES, buildIndex, entityDetail, listPages, newPage, parseEntityId, projectFields, readIndex, readPage, slugify, writePage, yamlStr,
  type EntityDetail, type PageDoc, type ProjectFields, type ProjectStatus,
} from "./entities.ts";
import { listDomainDirs } from "./vault-layout-v4.ts";
import { resolveDomainDir } from "./path-safety.ts";
import { vreadFile } from "./vault-session.ts";

export interface ProjectGoal { title: string; status: string; domain: string; id?: string }
export type ProjectDetail = EntityDetail & ProjectFields & { goals: ProjectGoal[] };

export interface ProjectPatch { status?: string; outcome?: string; target?: string; domains?: string[] }
export interface CreateProjectInput extends Omit<ProjectPatch, "status"> { name: string; fromIntent?: string; now?: number }

const iso = (ts: number) => new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");

function checkPatch(vault: string, p: ProjectPatch): Partial<ProjectFields> {
  const out: Partial<ProjectFields> = {};
  if (p.status !== undefined) {
    if (!PROJECT_STATUSES.includes(p.status as ProjectStatus)) throw new Error(`status must be ${PROJECT_STATUSES.join(", ")}, not "${p.status}"`);
    out.status = p.status as ProjectStatus;
  }
  if (p.outcome !== undefined) out.outcome = p.outcome.replace(/\s+/g, " ").trim().slice(0, 300);
  if (p.target !== undefined) {
    const t = p.target.trim();
    if (t && (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t)))) throw new Error(`target must be YYYY-MM-DD, not "${p.target}"`);
    out.target = t;
  }
  if (p.domains !== undefined) {
    const have = new Set(listDomainDirs(vault).map((d) => d.toLowerCase()));
    const want = [...new Set(p.domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
    const bad = want.filter((d) => !have.has(d));
    if (bad.length) throw new Error(`no domain ${bad.map((d) => `"${d}"`).join(", ")}`);
    out.domains = want;
  }
  return out;
}

// Rewrite the project frontmatter keys in the page's extra fields.
function applyFields(doc: PageDoc, f: Partial<ProjectFields>) {
  const next = { ...projectFields(doc), ...f };
  doc.extra.status = next.status;
  doc.extra.outcome = yamlStr(next.outcome);
  if (next.target) doc.extra.target = next.target;
  else delete doc.extra.target;
  doc.extra.domains = `[${next.domains.join(", ")}]`;
  if (next.intent_project) doc.extra.intent_project = yamlStr(next.intent_project);
  else delete doc.extra.intent_project;
}

function projectSlug(id: string): string {
  const p = parseEntityId(id);
  if (!p || (p.kind && p.kind !== "project")) throw new Error(`not a project: "${id}"`);
  return p.slug;
}

/** The tracked project pages. */
export function listProjectPages(vault: string) {
  return listPages(vault).filter((p) => p.kind === "project");
}

export function createProject(vault: string, i: CreateProjectInput): ProjectDetail {
  const now = i.now ?? Date.now();
  const name = i.name.replace(/\s+/g, " ").trim();
  const slug = slugify(name);
  if (!slug) throw new Error("a project needs a name");
  if (readPage(vault, "project", slug)) throw new Error(`project/${slug} already exists`);
  const from = i.fromIntent?.trim();
  if (from) {
    const have = listProjectPages(vault).find((p) => projectFields(p.doc).intent_project === from);
    if (have) throw new Error(`the Intent project "${from}" is already tracked as ${have.id}`);
  }
  const f = checkPatch(vault, { outcome: i.outcome ?? "", target: i.target, domains: i.domains ?? [] });
  const doc = newPage({ name, kind: "project", aliases: [] }, true, now);
  applyFields(doc, { ...f, status: "active", ...(from ? { intent_project: from } : {}) });
  writePage(vault, "project", slug, doc);
  buildIndex(vault, { now });
  return projectDetail(vault, `project/${slug}`)!;
}

export function setProject(vault: string, id: string, patch: ProjectPatch, o: { now?: number } = {}): ProjectDetail {
  const now = o.now ?? Date.now();
  const merged = readIndex(vault).merged ?? {};
  const slug = projectSlug(merged[`project/${projectSlug(id)}`] ?? id);
  const doc = readPage(vault, "project", slug);
  if (!doc) throw new Error(`no project "${id}"`);
  applyFields(doc, checkPatch(vault, patch));
  doc.updated = iso(now);
  writePage(vault, "project", slug, doc);
  buildIndex(vault, { now });
  return projectDetail(vault, `project/${slug}`)!;
}

/** A project with its fields and goals, or null. */
export function projectDetail(vault: string, id: string): ProjectDetail | null {
  const slug = projectSlug(id);
  const idx = readIndex(vault).generated_ts ? readIndex(vault) : buildIndex(vault);
  const d = entityDetail(vault, idx, `project/${slug}`);
  if (!d || d.kind !== "project") return null;
  const realSlug = d.id.slice(d.id.indexOf("/") + 1);
  const doc = readPage(vault, "project", realSlug);
  const { project: _nested, ...rest } = d;
  return { ...rest, ...(doc ? projectFields(doc) : { status: "active", outcome: "", domains: [] }), goals: projectGoals(vault, realSlug) };
}

// ── Goals ───────────────────────────────────────────────────────────────

const GOAL_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/;

/** One source/goals.md line: its title, status and ~key:value tokens. Null when not a goal. */
export function parseGoalLine(line: string): { title: string; status: string; tokens: Record<string, string> } | null {
  const m = line.match(GOAL_RE);
  if (!m) return null;
  const tokens: Record<string, string> = {};
  const title = m[2].replace(/(^|\s)~([a-z_]+):(\S+)/g, (_x, _s, k: string, v: string) => { tokens[k] = v; return ""; }).replace(/\s+/g, " ").trim();
  return { title, status: tokens.status || (m[1].toLowerCase() === "x" ? "done" : "active"), tokens };
}

/** Every goal, in any domain, whose line carries `~project:<slug>` (merged slugs count for their keeper). */
export function projectGoals(vault: string, slug: string): ProjectGoal[] {
  const merged = readIndex(vault).merged ?? {};
  const out: ProjectGoal[] = [];
  for (const domain of listDomainDirs(vault)) {
    const dir = resolveDomainDir(vault, domain);
    const path = [join(dir, "source", "goals.md"), join(dir, "goals.md")].find((p) => existsSync(p));
    if (!path) continue;
    let text = "";
    try { text = vreadFile(path); } catch { continue; }
    for (const line of text.split("\n")) {
      const g = parseGoalLine(line);
      const tag = g?.tokens.project ? slugify(g.tokens.project) : "";
      if (!g || !tag) continue;
      const into = merged[`project/${tag}`];
      if ((into ? into.slice(into.indexOf("/") + 1) : tag) !== slug) continue;
      out.push({ title: g.title, status: g.status, domain, ...(g.tokens.id ? { id: g.tokens.id } : {}) });
    }
  }
  return out;
}

// ── CLI: prevail projects create | set | show project/<slug> ────────────

/**
 * The entity side of `prevail projects`. Returns the exit code, or null when
 * the subcommand is not one of these (the Intent projects handle the rest).
 */
export function projectsEntityCommand(a: string[], vault: string): number | null {
  const sub = a[0];
  const json = a.includes("--json");
  const VALUE = new Set(["--vault", "--name", "--outcome", "--target", "--domain", "--domains", "--from-intent", "--status"]);
  const get = (flag: string): string | undefined => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; };
  const all = (flag: string): string[] => a.flatMap((x, i) => (x === flag && a[i + 1] !== undefined ? [a[i + 1]!] : []));
  const pos = a.filter((x, i) => !x.startsWith("--") && !(i > 0 && VALUE.has(a[i - 1]!)));
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (msg: string) => { if (json) out({ ok: false, error: msg }); else console.error(`prevail projects: ${msg}`); return 1; };
  const show = (d: ProjectDetail) => {
    if (json) out(d);
    else console.log(`${d.id}  ${d.status}${d.target ? `  target ${d.target}` : ""}  ${d.name}${d.outcome ? `\n  ${d.outcome}` : ""}`);
    return 0;
  };
  try {
    if (sub === "create") {
      const name = get("--name");
      if (!name) return fail("usage: prevail projects create --name <name> [--outcome ...] [--target YYYY-MM-DD] [--domain d]... [--from-intent <id>] --json");
      return show(createProject(vault, { name, outcome: get("--outcome"), target: get("--target"), domains: all("--domain"), fromIntent: get("--from-intent") }));
    }
    if (sub === "set") {
      const id = pos[1];
      if (!id) return fail("usage: prevail projects set <id> [--status active|paused|done|archived] [--outcome ...] [--target YYYY-MM-DD] [--domains a,b] --json");
      const domains = get("--domains");
      return show(setProject(vault, id, {
        status: get("--status"), outcome: get("--outcome"), target: get("--target"),
        domains: domains === undefined ? undefined : domains.split(","),
      }));
    }
    if (sub === "show" && pos[1]?.startsWith("project/")) {
      const d = projectDetail(vault, pos[1]);
      return d ? show(d) : fail(`no project "${pos[1]}"`);
    }
  } catch (e) { return fail((e as Error).message); }
  return null;
}
