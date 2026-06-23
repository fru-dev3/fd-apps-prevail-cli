// action-policy — the typed action taxonomy for the Action Authorization story
// (C1 / O94 / A-05). The first shared, enforced piece of the broker's vocabulary:
// classify an action by its risk class so the audit ledger (and a future policy
// engine + approval UI) can reason about it instead of treating every action the
// same. Heuristic for now (keyword-based); the broker will later carry a typed
// class on structured actions rather than re-deriving it from prose.

export type ActionClass =
  | "read" // read-only / informational
  | "reversible" // a writable change that can be undone (file edit, draft)
  | "external_send" // sends/contacts outside the vault (email, message, post)
  | "financial" // spends money / payments
  | "irreversible" // delete/destroy/overwrite without easy undo
  | "credential" // changes auth/secrets/settings
  | "unknown";

// Ordered most-consequential → least, so the FIRST match wins (an action that
// both "sends" and "deletes" is treated at the higher risk).
const RULES: Array<{ cls: ActionClass; re: RegExp }> = [
  { cls: "financial", re: /\b(pay|purchase|buy|charge|invoice|transfer (?:money|funds)|refund|wire|checkout|subscribe)\b/i },
  { cls: "irreversible", re: /\b(delete|destroy|erase|wipe|remove permanently|overwrite|drop (?:table|database)|revoke)\b/i },
  { cls: "credential", re: /\b(password|api[ _-]?key|token|secret|credential|2fa|oauth|rotate (?:the )?(?:api )?key|change (?:login|auth))\b/i },
  { cls: "external_send", re: /\b(send|email|e-mail|message|text|dm|post|publish|tweet|reply to|notify|share with|contact)\b/i },
  { cls: "reversible", re: /\b(create|add|write|update|edit|draft|file|schedule|move|rename|tag|save)\b/i },
  { cls: "read", re: /\b(read|list|search|find|show|get|fetch|summari[sz]e|check|look up|review)\b/i },
];

export function classifyAction(text: string): ActionClass {
  const t = (text ?? "").trim();
  if (!t) return "unknown";
  for (const { cls, re } of RULES) {
    if (re.test(t)) return cls;
  }
  return "unknown";
}

// Whether a class is "consequential" — i.e. should require explicit user
// approval and never be performed autonomously by default (B7/O5).
export function isConsequential(cls: ActionClass): boolean {
  return cls === "financial" || cls === "irreversible" || cls === "external_send" || cls === "credential";
}
