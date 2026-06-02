// The council-synthesis prompt asks the chair for four sections:
//   ## What each panelist said
//   ## Consensus
//   ## Divergence
//   ## Verdict
//
// Until now the whole reply was rendered as one wall of text. That made the
// divergence section easy to miss — which is the opposite of what Council
// Mode is supposed to do. The Karpathy / Council AI research papers all
// note that the VALUE of a council is the disagreement, not the consensus;
// hiding it in paragraph 3 of a long bubble defeats the purpose.
//
// parseVerdict pulls the four sections out so the renderer can give each
// its own visual treatment (Divergence in an accent panel, Verdict in a
// gold-edged hero), and so the daemon can ship them as separate Telegram
// messages with their own headers.

export interface ParsedVerdict {
  // Raw text of each section (markdown-ish, as the chair wrote it).
  panelistSaid: string | null;
  consensus: string | null;
  divergence: string | null;
  verdict: string | null;
  // True iff Divergence has substantive content. A chair that detected
  // unanimous panelists writes "None — see divergence." or omits it; we
  // skip the disagreement badge in those cases.
  hasDivergence: boolean;
  // True iff at least one of the four sections was found. When false,
  // the renderer falls back to the raw text — happens when the chair
  // model ignores the format request (rare but possible).
  structured: boolean;
}

// Match `## SECTION NAME` headers loosely — small typos in casing or
// extra whitespace shouldn't break parsing. The chair sometimes bolds
// the section name ("## **Verdict**") so allow that too.
function sectionRegex(name: string): RegExp {
  // Capture from "## NAME" to the next "## " or end-of-string.
  // (?:\*\*)? handles optional bold markdown wrap.
  return new RegExp(
    `##\\s*\\*?\\*?\\s*${name}\\s*\\*?\\*?\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
    "i",
  );
}

function pick(raw: string, name: string): string | null {
  const m = raw.match(sectionRegex(name));
  if (!m) return null;
  const body = m[1]!.trim();
  return body.length === 0 ? null : body;
}

export function parseVerdict(raw: string): ParsedVerdict {
  const panelistSaid = pick(raw, "What each panelist said");
  const consensus = pick(raw, "Consensus");
  const divergence = pick(raw, "Divergence");
  const verdict = pick(raw, "Verdict");
  const structured = Boolean(panelistSaid || consensus || divergence || verdict);
  return {
    panelistSaid,
    consensus,
    divergence,
    verdict,
    hasDivergence: hasSubstantiveDivergence(divergence),
    structured,
  };
}

// "None — see divergence." / "(none)" / empty bullet list all mean
// "panelists agreed". Treat as no disagreement so the UI doesn't show a
// false-alarm divergence badge.
function hasSubstantiveDivergence(d: string | null): boolean {
  if (!d) return false;
  const lower = d.toLowerCase();
  if (lower.includes("none") && lower.length < 80) return false;
  if (lower.replace(/[\s\-*•]/g, "").length < 8) return false;
  return true;
}

// One-line "headline" pulled from the Verdict body — the line that starts
// with "VERDICT:" if present, else the first non-empty line. Used by the
// log writeback and the Telegram delivery as a TL;DR.
export function verdictHeadline(parsed: ParsedVerdict, raw: string): string {
  const body = parsed.verdict ?? raw;
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (/^verdict\s*:/i.test(t)) {
      return t.replace(/^verdict\s*:\s*/i, "").trim();
    }
  }
  // Fallback: first non-empty line of the verdict (or raw if no verdict).
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return raw.trim().slice(0, 200);
}
