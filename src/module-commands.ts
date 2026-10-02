// Top-level commands that live in their own module. index.tsx hands them the
// arguments after the command name; each module is imported only when used.

export async function runModuleCommand(name: string, args: string[], vault: string): Promise<number> {
  if (name === "chief") return (await import("./chief-of-staff.ts")).chiefCommand(args, vault);
  if (name === "fold") return (await import("./fold.ts")).foldCommand(args, vault);
  if (name === "compass") return (await import("./compass.ts")).compassCommand(args, vault);
  if (name === "metrics") return (await import("./metrics.ts")).metricsCommand(args, vault);
  if (name === "specialists") return (await import("./specialists.ts")).specialistsCommand(args, vault);
  if (name === "job") return (await import("./jobs.ts")).jobCommand(args, vault);
  if (name === "review") return (await import("./review.ts")).reviewCommand(args, vault);
  if (name === "today") return (await import("./today.ts")).todayCommand(args, vault);
  if (name === "decide") return (await import("./decision-records.ts")).decideCommand(args, vault);
  console.error(`unknown command: ${name}`);
  return 1;
}
