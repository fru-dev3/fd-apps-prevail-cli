// Arguments for the module commands (chief, fold, compass, metrics):
// positionals, `--flag value` pairs and bare boolean flags. --vault/-d and its
// value are consumed here so no command mistakes the path for a positional.

const BOOLEAN = new Set(["json", "all", "apply", "force", "backfill", "local-only", "signal"]);

export interface ModArgs {
  pos: string[];
  flags: Record<string, string | true>;
  json: boolean;
  get(name: string): string | undefined;
  has(name: string): boolean;
}

export function parseModArgs(args: string[]): ModArgs {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-d") { i++; continue; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) flags[key] = a.slice(eq + 1);
      else if (!BOOLEAN.has(key) && args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) flags[key] = args[++i]!;
      else flags[key] = true;
      continue;
    }
    pos.push(a);
  }
  delete flags.vault;
  return {
    pos, flags, json: flags.json === true,
    get: (n) => (typeof flags[n] === "string" ? (flags[n] as string) : undefined),
    has: (n) => n in flags,
  };
}
