// Human-friendly labels for the live step checklist shown while a chat turn runs.
// Display-only and best-effort: turns a raw tool_use (name + input) into a short
// present-tense phrase like "Reading Gmail" or "Creating a Google Doc" so the
// user can see WHAT a long multi-step job is doing instead of an opaque spinner.
// Never throws; an unknown tool falls back to a prettified name.

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Pull the gws argv out of a google_workspace tool input ({ args: string[] }).
function gwsArgs(input: unknown): string[] | null {
  if (input && typeof input === "object" && "args" in (input as Record<string, unknown>)) {
    const a = (input as Record<string, unknown>).args;
    if (Array.isArray(a) && a.every((x) => typeof x === "string")) return a as string[];
  }
  return null;
}

const GWS_SERVICE_LABEL: Record<string, string> = {
  gmail: "Gmail",
  drive: "Drive",
  docs: "Google Docs",
  sheets: "Google Sheets",
  slides: "Google Slides",
  calendar: "your calendar",
  contacts: "Contacts",
  tasks: "Google Tasks",
  forms: "Google Forms",
};

// A first action token that mutates. Kept broad on purpose: display defaults to a
// "write"-flavored verb when unsure, matching the connector's write-wins rule.
const WRITE_HINT = /send|create|insert|update|delete|trash|modify|append|patch|add|move|batch/i;

function gwsLabel(args: string[]): string {
  const svc = (args[0] ?? "").toLowerCase();
  // The gws grammar is "<service> <resource> <verb>" or "<service> <verb>", so
  // the verb can be the 2nd OR 3rd token. Collect every non-flag token after the
  // service and test them all, rather than assuming a fixed position.
  const tokens: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const t = args[i] ?? "";
    if (t.startsWith("-")) break;
    tokens.push(t.replace(/^\+/, "").toLowerCase());
  }
  const has = (re: RegExp) => tokens.some((t) => re.test(t));
  const isWrite = tokens.some((t) => WRITE_HINT.test(t));
  switch (svc) {
    case "gmail":
      if (has(/send/)) return "Sending an email";
      if (has(/draft/)) return "Drafting an email";
      if (has(/label|modify|trash|delete|archive/)) return "Updating Gmail";
      return "Reading Gmail";
    case "docs":
      return isWrite ? "Creating a Google Doc" : "Reading a Google Doc";
    case "drive":
      return isWrite ? "Saving to Drive" : "Searching Drive";
    case "calendar":
      return isWrite ? "Updating your calendar" : "Checking your calendar";
    case "sheets":
      return isWrite ? "Updating a Sheet" : "Reading a Sheet";
    case "contacts":
      return isWrite ? "Updating Contacts" : "Reading Contacts";
    case "tasks":
      return isWrite ? "Updating Google Tasks" : "Reading Google Tasks";
    default: {
      const label = GWS_SERVICE_LABEL[svc] ?? (svc ? cap(svc) : "Google Workspace");
      return `${isWrite ? "Updating" : "Reading"} ${label}`;
    }
  }
}

const BUILTIN_LABEL: Record<string, string> = {
  Read: "Reading a file",
  Write: "Writing a file",
  Edit: "Editing a file",
  Bash: "Running a command",
  Glob: "Searching files",
  Grep: "Searching code",
  WebSearch: "Searching the web",
  WebFetch: "Fetching a page",
  Task: "Working on a subtask",
  TodoWrite: "Updating the plan",
};

// The public entry point. `name` is the tool_use name (may be prefixed
// "mcp__<server>__<tool>"); `input` is its raw input object (used only for gws).
export function stepLabel(name: string, input?: unknown): string {
  if (!name) return "Working";
  if (BUILTIN_LABEL[name]) return BUILTIN_LABEL[name];
  const bare = name.replace(/^mcp__/, "");
  if (bare.includes("google_workspace")) {
    const args = gwsArgs(input);
    if (args && args.length) return gwsLabel(args);
    return "Using Google Workspace";
  }
  if (bare.includes("prevail_acts") || bare.includes("acts_")) return "Saving to your vault";
  // Connected MCP server tool: "server__tool" -> "Server tool".
  const stripped = bare.replace(/__/g, " ").replace(/[_-]+/g, " ").trim();
  return stripped ? cap(stripped) : "Working";
}
