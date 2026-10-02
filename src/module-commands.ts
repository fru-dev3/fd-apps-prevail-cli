// Top-level commands that live in their own module. index.tsx hands them the
// arguments after the command name; each module is imported only when used.

export async function runModuleCommand(name: string, args: string[], vault: string): Promise<number> {
  // Which vault this engine resolved (--vault, PREVAIL_VAULT_ROOT, the config):
  // run before anything meant for a copy, to be sure it is the copy.
  if (name === "whereis") { process.stdout.write(`${JSON.stringify({ vault: (await import("node:path")).resolve(vault), env: process.env.PREVAIL_VAULT_ROOT ?? null })}\n`); return 0; }
  if (name === "chief") return (await import("./chief-of-staff.ts")).chiefCommand(args, vault);
  if (name === "fold") return (await import("./fold.ts")).foldCommand(args, vault);
  if (name === "compass") return (await import("./compass.ts")).compassCommand(args, vault);
  if (name === "metrics") return (await import("./metrics.ts")).metricsCommand(args, vault);
  if (name === "specialists") return (await import("./specialists.ts")).specialistsCommand(args, vault);
  if (name === "job") return (await import("./jobs.ts")).jobCommand(args, vault);
  if (name === "review") return (await import("./review.ts")).reviewCommand(args, vault);
  if (name === "today") return (await import("./today.ts")).todayCommand(args, vault);
  if (name === "missions" || name === "mission") return (await import("./missions-cli.ts")).missionsCommand(args, vault);
  if (name === "sources") return (await import("./sources.ts")).sourcesCommand(args, vault);
  if (name === "decide") return (await import("./decision-records.ts")).decideCommand(args, vault);
  if (name === "commitments") return (await import("./commitments.ts")).commitmentsCommand(args, vault);
  if (name === "tell") return (await import("./tell.ts")).tellCommand(args, vault);
  if (name === "forgetting") return (await import("./tell.ts")).tellCommand(args, vault, "forgetting");
  if (name === "time") return (await import("./time.ts")).timeCommand(args, vault);
  if (name === "radar") return (await import("./radar.ts")).radarCommand(args, vault);
  if (name === "packs") return (await import("./packs.ts")).packsCommand(args, vault);
  console.error(`unknown command: ${name}`);
  return 1;
}
