// =============================================================================
// artifact-router — classify a dropped file/artifact to a domain so the gateway
// can route it into that domain's _drop/ inbox.
//
// TRACK E8 (additive). This is a deterministic keyword classifier over each
// domain's manifest.routing.keywords — the model never picks the destination.
// It is intentionally a STUB: it resolves a target domain name (or null) but
// does NOT move files. The file-moving side belongs to a later track that owns
// _drop/ writes (and must honor manifest.ts assertWritable, which makes _drop/
// agent-read-only — so only this gateway/human side may deposit there).
// =============================================================================

import { scanVault } from "../vault.ts";
import { readManifest } from "../manifest.ts";

/** A scored classification candidate. Exposed so callers can show *why* a file
 *  was routed (which keyword matched) without re-running the match. */
export interface ArtifactClassification {
  /** Target domain name, or null when nothing matched. */
  domain: string | null;
  /** The manifest keyword that won the match, or null for a default/no match. */
  matchedKeyword: string | null;
  /** How the domain was chosen: "keyword" | "default" | "none". */
  reason: "keyword" | "default" | "none";
}

/** Lowercase + collapse whitespace so matching is case/format insensitive. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Classify a dropped artifact to a domain by keyword-matching its filename and
 * a content snippet against every domain's manifest.routing.keywords. Returns
 * the first domain whose keyword appears in (filename + snippet); on no match,
 * falls back to the domain flagged manifest.routing.default; else null.
 *
 * Deterministic: domains are scanned in their canonical sidebar order and
 * keywords are checked in manifest order, so the same inputs always pick the
 * same domain. The model is never consulted.
 *
 * @param vaultPath  Absolute vault root.
 * @param filename   The dropped file's basename (e.g. "Q3-1099.pdf").
 * @param snippet    Optional leading text extracted from the file's contents.
 */
export function classifyArtifact(
  vaultPath: string,
  filename: string,
  snippet = "",
): ArtifactClassification {
  const haystack = norm(`${filename} ${snippet}`);
  if (haystack.length === 0) {
    return { domain: null, matchedKeyword: null, reason: "none" };
  }

  let domains: { name: string }[];
  try {
    domains = scanVault(vaultPath);
  } catch {
    return { domain: null, matchedKeyword: null, reason: "none" };
  }

  let defaultDomain: string | null = null;

  for (const d of domains) {
    const m = readManifest(vaultPath, d.name);
    if (!m) continue;
    if (m.routing.default && defaultDomain === null) defaultDomain = d.name;
    for (const kw of m.routing.keywords) {
      const k = norm(kw);
      if (k.length > 0 && haystack.includes(k)) {
        return { domain: d.name, matchedKeyword: kw, reason: "keyword" };
      }
    }
  }

  if (defaultDomain) {
    return { domain: defaultDomain, matchedKeyword: null, reason: "default" };
  }
  return { domain: null, matchedKeyword: null, reason: "none" };
}
