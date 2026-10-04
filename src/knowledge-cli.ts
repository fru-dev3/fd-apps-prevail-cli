// `prevail sources add|list|check|remove|use|read|query`: knowledge sources
// from the command line (knowledge-sources.ts). With --json every subcommand
// prints exactly one JSON line; errors land in `error` and exit 1.
//
//   sources add <link, path or a sentence> [--kind mcp|web|folder|database]
//       [--name N] [--location L] [--secret-env VAR] [--domains a,b]
//       [--projects p,q] [--briefings on|off] [--general on|off]
//   sources list
//   sources check <id>            look again (and trust here, if from another Mac)
//   sources remove <id>           archive (never deleted)
//   sources use <id> [--briefings on|off] [--general on|off] [--domains a,b|none] [--projects p|none]
//   sources read <id> [path or url]
//   sources query <id> "<SELECT ...>"
//
// A password or token never goes on the command line: --secret-env names an
// environment variable to read it from, and a Postgres URL's password is split
// off into the keychain.

import type { ModArgs } from "./cli-args.ts";
import {
  addKnowledgeSource, checkKnowledgeSource, KNOWLEDGE_KINDS, listKnowledgeSources, removeKnowledgeSource, setSourceScope, sourceToolCall,
  type KnowledgeKind, type KnowledgeScope, type KnowledgeSource,
} from "./knowledge-sources.ts";

const onOff = (v: string | undefined): boolean | undefined => (v === "on" || v === "true" ? true : v === "off" || v === "false" ? false : undefined);
const csv = (v: string | undefined): string[] | undefined => (v === undefined ? undefined : v === "none" ? [] : v.split(",").map((x) => x.trim()).filter(Boolean));

function scopeFlags(args: ModArgs): Partial<KnowledgeScope> {
  const s: Partial<KnowledgeScope> = {};
  const b = onOff(args.get("briefings")); if (b !== undefined) s.briefings = b;
  const g = onOff(args.get("general")); if (g !== undefined) s.general = g;
  const d = csv(args.get("domains")); if (d) s.domains = d;
  const p = csv(args.get("projects")); if (p) s.projects = p;
  return s;
}

const useText = (s: KnowledgeSource) => [s.scope.briefings ? "briefings" : "", s.scope.general ? "general" : "", ...s.scope.domains, ...s.scope.projects.map((p) => `project ${p}`)].filter(Boolean).join(", ") || "chat only";
const line = (s: KnowledgeSource) => `${s.status === "ready" ? "ok " : s.status === "error" ? "err" : "-- "} ${s.id.padEnd(24)} ${s.kind.padEnd(8)} ${useText(s)}${s.found ? `  · ${s.found}` : ""}`;

export async function knowledgeCommand(sub: string, args: ModArgs, vault: string): Promise<number> {
  const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`);
  const fail = (msg: string) => { if (args.json) out({ error: msg }); else console.error(`prevail sources: ${msg}`); return 1; };
  try {
    if (sub === "list") {
      const rows = listKnowledgeSources(vault);
      if (args.json) out(rows); else if (!rows.length) console.log("no knowledge sources yet: prevail sources add <link or path>"); else for (const r of rows) console.log(line(r));
      return 0;
    }
    if (sub === "add") {
      const text = args.pos.slice(1).join(" ");
      const kind = args.get("kind") as KnowledgeKind | undefined;
      if (kind && !KNOWLEDGE_KINDS.includes(kind)) return fail(`--kind must be one of ${KNOWLEDGE_KINDS.join(", ")}`);
      const envName = args.get("secret-env");
      const secret = envName ? process.env[envName] : undefined;
      if (envName && !secret) return fail(`$${envName} is empty`);
      const { listDomainDirs } = await import("./vault-layout-v4.ts");
      let projects: { slug: string; name: string }[] = [];
      try { projects = (await import("./missions.ts")).listMissions(vault, { status: "all" }).map((m) => ({ slug: m.slug, name: m.name })); } catch { /* no projects */ }
      const r = await addKnowledgeSource(vault, {
        text, ...(kind ? { kind } : {}), ...(args.get("name") ? { name: args.get("name") } : {}), ...(args.get("location") ? { location: args.get("location") } : {}),
        ...(secret ? { secret } : {}), scope: scopeFlags(args), domains: listDomainDirs(vault), projects,
      });
      if (args.json) { out(r); return 0; }
      console.log(`${r.adopted ? "checked again" : "added"} ${r.source.name} (${r.source.kind}${r.detected ? `, ${r.detected}` : ""})`);
      console.log(`  found: ${r.found}`);
      console.log(`  used for: ${useText(r.source)}`);
      return r.probe.ok ? 0 : 1;
    }
    const ref = args.pos[1];
    if (!ref) return fail(`usage: prevail sources ${sub} <id>`);
    if (sub === "check") {
      const r = await checkKnowledgeSource(vault, ref);
      if (args.json) out(r); else console.log(`${r.source.name}: ${r.found}`);
      return r.probe.ok ? 0 : 1;
    }
    if (sub === "remove") {
      const r = removeKnowledgeSource(vault, ref);
      if (args.json) out({ ok: true, archived: r }); else console.log(`archived ${r.id} to ${r.to}`);
      return 0;
    }
    if (sub === "use") {
      const s = setSourceScope(vault, ref, scopeFlags(args));
      if (args.json) out(s); else console.log(line(s));
      return 0;
    }
    if (sub === "read") {
      const target = args.pos[2];
      const text = await sourceToolCall(vault, "read_source", { source: ref, ...(target ? (/^https?:/i.test(target) ? { url: target } : { path: target }) : {}), ...(args.get("tool") ? { tool: args.get("tool") } : {}) });
      if (args.json) out({ text }); else console.log(text);
      return 0;
    }
    if (sub === "query") {
      const text = await sourceToolCall(vault, "query_database", { source: ref, sql: args.pos.slice(2).join(" ") });
      if (args.json) out({ text }); else console.log(text);
      return 0;
    }
    return fail(`unknown subcommand ${sub}`);
  } catch (e) {
    return fail((e as Error).message);
  }
}
