// Mapping signals to apps, the unknown inbox and app records. Apps plan A2.
//
// A signal is an identifier seen somewhere: a Mac bundle id, a web domain, a
// card merchant, an email sender, a CLI binary. It maps to one app id by, in
// order: the identifiers on the app records in data/entities/products/<id>/manifest.json
// (the user's corrections land there, so they win and sync), the built-in
// alias table below, then nothing: an unmatched signal goes to the unknown
// inbox (build/_meta/apps/unknown.json) until the user maps or ignores it.
// Ignores live in build/_meta/apps/mapping.json with the computed index.
//
// Web domains are reduced to their registrable domain (a Public Suffix List
// subset); login, CDN and tracker hosts are dropped; health, finance, adult
// and dating domains are never recorded at all.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasAppContent, productArchiveDirs, productDir, productFolders, productWriteDir, runtimePath } from "./path-safety.ts";

// ── Domains ─────────────────────────────────────────────────────────────────

const TWO_LEVEL = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "edu.au", "co.nz", "co.jp", "ne.jp", "or.jp", "com.br", "com.mx", "co.in", "co.za", "com.sg", "com.cn", "com.hk", "com.tw", "co.kr", "com.tr", "com.ar", "co.il", "com.ng", "co.ke", "com.cm"]);
// Private suffixes where each subdomain is its own site.
const PRIVATE = new Set(["github.io", "vercel.app", "netlify.app", "herokuapp.com", "pages.dev", "web.app", "firebaseapp.com", "workers.dev", "fly.dev", "onrender.com", "glitch.me", "replit.app", "streamlit.app", "substack.com", "medium.com", "blogspot.com", "wordpress.com", "notion.site", "framer.website", "webflow.io", "myshopify.com"]);

/** host -> registrable domain ("mail.google.com" -> "google.com"); "" for IPs, localhost and junk. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/^www\d?\./, "");
  if (!h || !h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || h.endsWith(".local") || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".ts.net")) return "";
  const parts = h.split(".");
  for (let n = 3; n >= 2; n--) {
    const suf = parts.slice(-n).join(".");
    if (PRIVATE.has(suf) && parts.length > n) return parts.slice(-(n + 1)).join(".");
  }
  const last2 = parts.slice(-2).join(".");
  if (PRIVATE.has(last2) && parts.length > 2) return parts.slice(-3).join(".");
  if (TWO_LEVEL.has(last2)) return parts.length >= 3 ? parts.slice(-3).join(".") : "";
  return last2;
}

// Never recorded: health, finance, adult and dating (apps plan decision 2).
// Finance shows up through charges instead, health through its own sources.
const NEVER_DOMAINS = new Set([
  "mychart.com", "mychart.org", "webmd.com", "healthline.com", "mayoclinic.org", "zocdoc.com", "goodrx.com", "cvs.com", "walgreens.com", "teladoc.com", "betterhelp.com", "talkspace.com", "23andme.com", "ancestry.com", "patientportal.com", "followmyhealth.com", "kaiserpermanente.org", "onemedical.com", "headspace.com", "calm.com",
  "chase.com", "bankofamerica.com", "wellsfargo.com", "usbank.com", "capitalone.com", "americanexpress.com", "citi.com", "discover.com", "fidelity.com", "vanguard.com", "schwab.com", "etrade.com", "robinhood.com", "coinbase.com", "paypal.com", "venmo.com", "zelle.com", "mint.com", "creditkarma.com", "experian.com", "equifax.com", "transunion.com", "irs.gov", "turbotax.com", "intuit.com", "betterment.com", "wealthfront.com", "sofi.com", "ally.com", "plaid.com", "stripe.com", "wise.com", "revolut.com", "monarchmoney.com", "rocketmoney.com", "ynab.com",
  "tinder.com", "bumble.com", "hinge.co", "match.com", "okcupid.com", "grindr.com", "pof.com", "eharmony.com", "zoosk.com", "feeld.co", "her.app", "coffeemeetsbagel.com",
  "onlyfans.com", "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "chaturbate.com", "redtube.com", "youporn.com", "fansly.com",
]);
const NEVER_WORDS = /(bank|credit ?union|creditunion|brokerage|mortgage|loan|insur|pharma|clinic|hospital|health|medic|patient|therapy|dental|porn|xxx|sex|escort|dating|hookup)/i;
// Login, CDN, tracker and ad hosts: plumbing, not a service the user chose.
const PLUMBING = new Set(["gstatic.com", "googleusercontent.com", "googleapis.com", "googlesyndication.com", "googletagmanager.com", "google-analytics.com", "doubleclick.net", "cloudfront.net", "akamaihd.net", "akamaized.net", "fastly.net", "cloudflare.com", "cloudflare-dns.com", "jsdelivr.net", "unpkg.com", "cdnjs.com", "fbcdn.net", "twimg.com", "ytimg.com", "ggpht.com", "gvt1.com", "gvt2.com", "msftauth.net", "live.net", "office.net", "azureedge.net", "sentry.io", "segment.io", "hotjar.com", "intercom.io", "stripecdn.com", "recaptcha.net", "hcaptcha.com", "okta.com", "auth0.com", "onelogin.com", "duosecurity.com"]);
const LOGIN_HOST = /^(accounts|login|auth|signin|sso|id|oauth|myaccount|passport)\./i;

/** May a visit to this host be counted at all? */
export function webDomainAllowed(host: string, domain = registrableDomain(host)): boolean {
  if (!domain) return false;
  if (NEVER_DOMAINS.has(domain) || NEVER_WORDS.test(domain)) return false;
  if (PLUMBING.has(domain) || LOGIN_HOST.test(host.toLowerCase())) return false;
  return true;
}

// ── The built-in alias table ────────────────────────────────────────────────
// Well-known vendors only. An app record's own identifiers always win.

export type AppKind = "ai-tool" | "app" | "web" | "subscription-only" | "device" | "service";
export interface KnownApp { id: string; name: string; kind: AppKind; category: string; bundles?: string[]; domains?: string[]; merchants?: string[]; senders?: string[]; binaries?: string[]; status?: string }

export const KNOWN_APPS: KnownApp[] = [
  { id: "anthropic", name: "Claude", kind: "ai-tool", category: "ai", bundles: ["com.anthropic.claudefordesktop"], domains: ["claude.ai", "anthropic.com", "claude.com"], merchants: ["ANTHROPIC", "CLAUDE.AI"], senders: ["anthropic.com", "mail.anthropic.com"], binaries: ["claude"], status: "https://status.anthropic.com" },
  { id: "openai", name: "ChatGPT and Codex", kind: "ai-tool", category: "ai", bundles: ["com.openai.chat", "com.openai.codex", "com.openai.atlas"], domains: ["chatgpt.com", "openai.com"], merchants: ["OPENAI", "CHATGPT"], senders: ["openai.com", "tm.openai.com"], binaries: ["codex"], status: "https://status.openai.com" },
  { id: "google", name: "Google", kind: "service", category: "productivity", bundles: ["com.google.Chrome", "com.google.antigravity", "com.google.GeminiMacOS"], domains: ["google.com", "gemini.google.com", "youtube.com", "youtu.be", "gmail.com", "docs.new", "antigravity.google"], merchants: ["GOOGLE"], senders: ["google.com", "accounts.google.com", "payments-noreply@google.com"], binaries: ["agy", "gemini", "gws"] },
  { id: "cursor", name: "Cursor", kind: "ai-tool", category: "ai-coding", bundles: ["com.todesktop.230313mzl4w4u92"], domains: ["cursor.com", "cursor.sh"], merchants: ["CURSOR"], senders: ["cursor.com", "cursor.sh"], binaries: ["cursor-agent", "agent"] },
  { id: "github", name: "GitHub", kind: "service", category: "dev", bundles: ["com.github.GitHubClient"], domains: ["github.com"], merchants: ["GITHUB"], senders: ["github.com", "noreply@github.com"], binaries: ["gh"], status: "https://www.githubstatus.com" },
  { id: "vercel", name: "Vercel", kind: "service", category: "dev", domains: ["vercel.com"], merchants: ["VERCEL"], senders: ["vercel.com"], binaries: ["vercel"], status: "https://www.vercel-status.com" },
  { id: "netlify", name: "Netlify", kind: "service", category: "dev", domains: ["netlify.com"], merchants: ["NETLIFY"], senders: ["netlify.com"], binaries: ["netlify"], status: "https://www.netlifystatus.com" },
  { id: "notion", name: "Notion", kind: "app", category: "notes", bundles: ["notion.id"], domains: ["notion.so", "notion.com"], merchants: ["NOTION"], senders: ["notion.so", "mail.notion.so"], status: "https://www.notion-status.com" },
  { id: "obsidian", name: "Obsidian", kind: "app", category: "notes", bundles: ["md.obsidian"], domains: ["obsidian.md"], merchants: ["OBSIDIAN"], senders: ["obsidian.md"] },
  { id: "linear", name: "Linear", kind: "app", category: "dev", bundles: ["com.linear"], domains: ["linear.app"], merchants: ["LINEAR"], senders: ["linear.app"] },
  { id: "figma", name: "Figma", kind: "app", category: "design", bundles: ["com.figma.Desktop"], domains: ["figma.com"], merchants: ["FIGMA"], senders: ["figma.com"] },
  { id: "canva", name: "Canva", kind: "web", category: "design", bundles: ["com.canva.CanvaDesktop"], domains: ["canva.com"], merchants: ["CANVA"], senders: ["canva.com"] },
  { id: "slack", name: "Slack", kind: "app", category: "chat", bundles: ["com.tinyspeck.slackmacgap"], domains: ["slack.com"], merchants: ["SLACK"], senders: ["slack.com"] },
  { id: "discord", name: "Discord", kind: "app", category: "chat", bundles: ["com.hnc.Discord"], domains: ["discord.com"], merchants: ["DISCORD"], senders: ["discord.com"] },
  { id: "zoom", name: "Zoom", kind: "app", category: "meetings", bundles: ["us.zoom.xos"], domains: ["zoom.us"], merchants: ["ZOOM"], senders: ["zoom.us"] },
  { id: "spotify", name: "Spotify", kind: "app", category: "music", bundles: ["com.spotify.client"], domains: ["spotify.com"], merchants: ["SPOTIFY"], senders: ["spotify.com"] },
  { id: "netflix", name: "Netflix", kind: "subscription-only", category: "video", domains: ["netflix.com"], merchants: ["NETFLIX"], senders: ["netflix.com"] },
  { id: "dropbox", name: "Dropbox", kind: "app", category: "storage", bundles: ["com.getdropbox.dropbox"], domains: ["dropbox.com"], merchants: ["DROPBOX"], senders: ["dropbox.com"] },
  { id: "adobe", name: "Adobe", kind: "app", category: "design", bundles: ["com.adobe.acc.AdobeCreativeCloud", "com.adobe.Reader"], domains: ["adobe.com"], merchants: ["ADOBE"], senders: ["adobe.com"] },
  { id: "descript", name: "Descript", kind: "app", category: "content", bundles: ["com.descript.beachcube"], domains: ["descript.com"], merchants: ["DESCRIPT"], senders: ["descript.com"] },
  { id: "elevenlabs", name: "ElevenLabs", kind: "web", category: "content", domains: ["elevenlabs.io"], merchants: ["ELEVENLABS"], senders: ["elevenlabs.io"] },
  { id: "wispr-flow", name: "Wispr Flow", kind: "ai-tool", category: "ai", bundles: ["com.electron.wispr-flow"], domains: ["wisprflow.ai"], merchants: ["WISPR"], senders: ["wisprflow.ai"] },
  { id: "aionui", name: "AionUi", kind: "ai-tool", category: "ai", bundles: ["com.aionui.app"] },
  { id: "opencode", name: "opencode", kind: "ai-tool", category: "ai-coding", domains: ["opencode.ai"], binaries: ["opencode"] },
  { id: "huggingface", name: "Hugging Face", kind: "web", category: "ai", domains: ["huggingface.co"], merchants: ["HUGGINGFACE", "HUGGING FACE"], senders: ["huggingface.co"] },
  { id: "perplexity", name: "Perplexity", kind: "ai-tool", category: "ai", bundles: ["ai.perplexity.mac"], domains: ["perplexity.ai"], merchants: ["PERPLEXITY"], senders: ["perplexity.ai"] },
  { id: "midjourney", name: "Midjourney", kind: "web", category: "ai", domains: ["midjourney.com"], merchants: ["MIDJOURNEY"], senders: ["midjourney.com"] },
  { id: "fal", name: "fal", kind: "service", category: "ai", domains: ["fal.ai"], merchants: ["FAL.AI", "FEATURELESS"], senders: ["fal.ai"] },
  { id: "firecrawl", name: "Firecrawl", kind: "service", category: "dev", domains: ["firecrawl.dev"], merchants: ["FIRECRAWL"], senders: ["firecrawl.dev"] },
  { id: "turso", name: "Turso", kind: "service", category: "dev", domains: ["turso.tech"], merchants: ["TURSO", "CHISELSTRIKE"], senders: ["turso.tech"], binaries: ["turso"] },
  { id: "tailscale", name: "Tailscale", kind: "app", category: "network", bundles: ["io.tailscale.ipn.macsys", "io.tailscale.ipn.macos"], domains: ["tailscale.com"], merchants: ["TAILSCALE"], senders: ["tailscale.com"], binaries: ["tailscale"] },
  { id: "orbstack", name: "OrbStack", kind: "app", category: "dev", bundles: ["dev.kdrag0n.MacVirt"], domains: ["orbstack.dev"], merchants: ["ORBSTACK"] },
  { id: "jump-desktop", name: "Jump Desktop", kind: "app", category: "network", bundles: ["com.p5sys.jump.mac.viewer"], domains: ["jumpdesktop.com"], merchants: ["JUMP DESKTOP", "PHASE FIVE"] },
  { id: "soundsource", name: "SoundSource", kind: "app", category: "audio", bundles: ["com.rogueamoeba.soundsource"], domains: ["rogueamoeba.com"], merchants: ["ROGUE AMOEBA"] },
  { id: "lm-studio", name: "LM Studio", kind: "ai-tool", category: "ai", bundles: ["ai.elementlabs.lmstudio"], domains: ["lmstudio.ai"] },
  { id: "ollama", name: "Ollama", kind: "ai-tool", category: "ai", bundles: ["com.electron.ollama"], domains: ["ollama.com"], binaries: ["ollama"] },
  { id: "warp", name: "Warp", kind: "app", category: "dev", bundles: ["dev.warp.Warp-Stable"], domains: ["warp.dev"], merchants: ["WARP"] },
  { id: "cmux", name: "cmux", kind: "app", category: "dev", bundles: ["com.cmuxterm.app"], binaries: ["cmux"] },
  { id: "xcode", name: "Xcode", kind: "app", category: "dev", bundles: ["com.apple.dt.Xcode"] },
  { id: "microsoft", name: "Microsoft", kind: "app", category: "productivity", bundles: ["com.microsoft.edgemac", "com.microsoft.Word", "com.microsoft.Excel", "com.microsoft.Powerpoint", "com.microsoft.VSCode", "com.microsoft.teams2"], domains: ["microsoft.com", "office.com", "live.com", "bing.com", "linkedin.com"], merchants: ["MICROSOFT", "MSFT"], senders: ["microsoft.com"] },
  { id: "amazon", name: "Amazon", kind: "service", category: "shopping", domains: ["amazon.com", "aws.amazon.com"], merchants: ["AMAZON", "AMZN", "AWS"], senders: ["amazon.com"] },
  { id: "apple", name: "Apple", kind: "service", category: "platform", domains: ["apple.com", "icloud.com"], merchants: ["APPLE.COM/BILL", "APPLE.COM"], senders: ["email.apple.com", "no_reply@email.apple.com", "apple.com"] },
  { id: "1password", name: "1Password", kind: "app", category: "security", bundles: ["com.1password.1password"], merchants: ["1PASSWORD", "AGILEBITS"], senders: ["1password.com"], binaries: ["op"] },
  { id: "x", name: "X", kind: "web", category: "social", domains: ["x.com", "twitter.com"], merchants: ["X CORP", "TWITTER"], senders: ["x.com"] },
  { id: "reddit", name: "Reddit", kind: "web", category: "social", domains: ["reddit.com"], senders: ["reddit.com", "redditmail.com"] },
  { id: "substack", name: "Substack", kind: "web", category: "content", domains: ["substack.com"], merchants: ["SUBSTACK"], senders: ["substack.com"] },
  { id: "medium", name: "Medium", kind: "web", category: "content", domains: ["medium.com"], merchants: ["MEDIUM"], senders: ["medium.com"] },
  { id: "beehiiv", name: "beehiiv", kind: "web", category: "content", domains: ["beehiiv.com"], merchants: ["BEEHIIV"], senders: ["beehiiv.com"] },
  { id: "posthog", name: "PostHog", kind: "web", category: "dev", domains: ["posthog.com"], merchants: ["POSTHOG"], senders: ["posthog.com"] },
  { id: "resend", name: "Resend", kind: "service", category: "dev", domains: ["resend.com"], merchants: ["RESEND"], senders: ["resend.com"] },
  { id: "cloudflare", name: "Cloudflare", kind: "service", category: "dev", domains: ["dash.cloudflare.com"], merchants: ["CLOUDFLARE"], senders: ["cloudflare.com"] },
  { id: "namecheap", name: "Namecheap", kind: "service", category: "dev", domains: ["namecheap.com"], merchants: ["NAMECHEAP"], senders: ["namecheap.com"] },
  { id: "strava", name: "Strava", kind: "app", category: "fitness", domains: ["strava.com"], merchants: ["STRAVA"], senders: ["strava.com"] },
  { id: "garmin-connect", name: "Garmin Connect", kind: "app", category: "fitness", domains: ["garmin.com", "connect.garmin.com"], merchants: ["GARMIN"], senders: ["garmin.com"] },
  { id: "oura-ring", name: "Oura", kind: "device", category: "fitness", domains: ["ouraring.com"], merchants: ["OURA"], senders: ["ouraring.com"] },
  { id: "alltrails", name: "AllTrails", kind: "app", category: "fitness", domains: ["alltrails.com"], merchants: ["ALLTRAILS"], senders: ["alltrails.com"] },
  { id: "airbnb", name: "Airbnb", kind: "service", category: "travel", domains: ["airbnb.com"], senders: ["airbnb.com"] },
  { id: "uber", name: "Uber", kind: "service", category: "travel", domains: ["uber.com"], merchants: ["UBER"], senders: ["uber.com"] },
  { id: "youtube-premium", name: "YouTube Premium", kind: "subscription-only", category: "video", merchants: ["GOOGLE *YOUTUBE", "YOUTUBE PREMIUM"] },
  { id: "privacy-com", name: "Privacy.com", kind: "service", category: "money", domains: ["privacy.com"], merchants: ["PRIVACY.COM"], senders: ["privacy.com"] },
];

// ── The index ───────────────────────────────────────────────────────────────

export type SignalKind = "bundle" | "domain" | "merchant" | "sender" | "binary";
const IDENT_FIELD: Record<SignalKind, string> = { bundle: "bundle_ids", domain: "domains", merchant: "merchants", sender: "email_senders", binary: "binaries" };
const KNOWN_FIELD: Record<SignalKind, keyof KnownApp> = { bundle: "bundles", domain: "domains", merchant: "merchants", sender: "senders", binary: "binaries" };

export interface AppRecord { id: string; name: string; kind?: AppKind; category?: string; identifiers: Partial<Record<string, string[]>>; archived?: boolean; manifest: Record<string, unknown> }

/** Every app record (and archived ones, flagged), with its identifiers. */
export function readRecords(vault: string): AppRecord[] {
  const out: AppRecord[] = [];
  const push = (id: string, dir: string, inArchive: boolean) => {
    // A product with no app parts (a page only) is not an app record.
    if (!hasAppContent(dir)) return;
    let m: Record<string, unknown> = {};
    try { m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>; } catch { /* parts without a manifest */ }
    const ident = (m.identifiers && typeof m.identifiers === "object" ? m.identifiers : {}) as Record<string, string[]>;
    const archived = inArchive || m.lifecycle === "archived";
    out.push({ id, name: String(m.name ?? m.title ?? id), kind: m.kind as AppKind | undefined, category: typeof m.category === "string" ? m.category : undefined, identifiers: ident, archived, manifest: m });
  };
  for (const { id, dir } of productFolders(vault)) push(id, dir, false);
  const seen = new Set(out.map((r) => r.id));
  for (const arch of productArchiveDirs(vault)) {
    let ids: string[] = [];
    try { ids = readdirSync(arch); } catch { continue; }
    for (const id of ids) if (!id.startsWith(".") && !id.startsWith("_") && !seen.has(id)) { seen.add(id); push(id, join(arch, id), true); }
  }
  return out;
}

const norm = (kind: SignalKind, v: string) => {
  const s = v.trim();
  if (kind === "merchant") return s.toUpperCase().replace(/\s+/g, " ");
  if (kind === "bundle") return s;
  return s.toLowerCase();
};

export interface Mapping { ignore: Partial<Record<SignalKind, string[]>> }
const mappingPath = (vault: string) => join(runtimePath(vault, "_meta"), "apps", "mapping.json");
export function readMapping(vault: string): Mapping {
  try { const j = JSON.parse(readFileSync(mappingPath(vault), "utf8")) as Mapping; return { ignore: j.ignore ?? {} }; } catch { return { ignore: {} }; }
}

export interface Matcher { match(kind: SignalKind, value: string): string | null; ignored(kind: SignalKind, value: string): boolean; known(id: string): KnownApp | undefined }

/**
 * Build the matcher. A record's identifiers win over the alias table; an
 * archived record still matches (so a vendor seen again is not "new"). A
 * merchant matches by prefix (bank lines carry suffixes); a sender matches
 * an address or its domain; a domain matches itself or a parent.
 */
export function buildMatcher(vault: string, records = readRecords(vault)): Matcher {
  const exact = new Map<string, string>();
  const merchants: [string, string][] = [];
  const put = (kind: SignalKind, v: string, id: string, force = false) => {
    const k = `${kind}\t${norm(kind, v)}`;
    if (kind === "merchant") { merchants.push([norm(kind, v), id]); if (!force) return; }
    if (force || !exact.has(k)) exact.set(k, id);
  };
  for (const r of records) for (const kind of Object.keys(IDENT_FIELD) as SignalKind[]) for (const v of r.identifiers[IDENT_FIELD[kind]] ?? []) put(kind, v, r.id, true);
  const recIds = new Set(records.map((r) => r.id));
  for (const a of KNOWN_APPS) for (const kind of Object.keys(KNOWN_FIELD) as SignalKind[]) for (const v of (a[KNOWN_FIELD[kind]] as string[] | undefined) ?? []) put(kind, v, a.id);
  // Record merchants first (sorted longest first so a specific line wins).
  merchants.sort((a, b) => (recIds.has(b[1]) ? 1 : 0) - (recIds.has(a[1]) ? 1 : 0) || b[0].length - a[0].length);
  const mp = readMapping(vault);
  const ign = new Map<string, Set<string>>(Object.entries(mp.ignore).map(([k, v]) => [k, new Set((v ?? []).map((x) => norm(k as SignalKind, x)))]));
  return {
    match(kind, value) {
      const v = norm(kind, value);
      if (!v) return null;
      if (kind === "merchant") { const hit = merchants.find(([m]) => v.startsWith(m) || v.includes(` ${m}`) || v.includes(`*${m}`)); return hit?.[1] ?? null; }
      const direct = exact.get(`${kind}\t${v}`);
      if (direct) return direct;
      if (kind === "sender") { const at = v.lastIndexOf("@"); const dom = at >= 0 ? v.slice(at + 1) : v; const d = exact.get(`sender\t${dom}`) ?? exact.get(`sender\t${registrableDomain(dom)}`); if (d) return d; return exact.get(`domain\t${registrableDomain(dom)}`) ?? null; }
      if (kind === "domain") { const parts = v.split("."); for (let i = 1; i < parts.length - 1; i++) { const d = exact.get(`domain\t${parts.slice(i).join(".")}`); if (d) return d; } }
      return null;
    },
    ignored(kind, value) { return ign.get(kind)?.has(norm(kind, value)) ?? false; },
    known(id) { return KNOWN_APPS.find((a) => a.id === id); },
  };
}

// ── Corrections become rules ────────────────────────────────────────────────

export const APP_ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
export const slugApp = (name: string) => name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "app";

function writeJsonAtomic(p: string, v: unknown): void {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(`${p}.tmp`, `${JSON.stringify(v, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
}

/**
 * The user maps a signal to an app (or ignores it). Mapping adds the
 * identifier to the app record (creating a minimal record if needed), so the
 * rule syncs with the vault and wins over the alias table. Ignoring writes
 * build/_meta/apps/mapping.json on this Mac.
 */
export function correctSignal(vault: string, kind: SignalKind, value: string, target: string): { app?: string; ignored?: boolean } {
  if (!(kind in IDENT_FIELD)) throw new Error(`kind must be one of ${Object.keys(IDENT_FIELD).join(", ")}`);
  const v = value.trim();
  if (!v || v.length > 200) throw new Error("value is required (200 characters at most)");
  if (target === "ignore") {
    const mp = readMapping(vault);
    const list = new Set(mp.ignore[kind] ?? []);
    list.add(v);
    mp.ignore[kind] = [...list].sort();
    writeJsonAtomic(mappingPath(vault), { ...mp, updated: new Date().toISOString() });
    return { ignored: true };
  }
  if (!APP_ID.test(target)) throw new Error(`not an app id: ${target}`);
  const known = KNOWN_APPS.find((a) => a.id === target);
  upsertRecord(vault, { id: target, name: known?.name ?? target, ...(known ? { kind: known.kind, category: known.category } : {}), identifiers: { [IDENT_FIELD[kind]]: [v] }, found_by: `you mapped ${kind} ${v}` });
  return { app: target };
}

// ── Records ─────────────────────────────────────────────────────────────────

export interface RecordPatch { id: string; name: string; kind?: AppKind; category?: string; surfaces?: string[]; identifiers?: Record<string, string[]>; found_by?: string; first_seen?: string; lifecycle?: string }

/**
 * Create data/entities/products/<id>/manifest.json or add to it. Existing values are never
 * overwritten: missing fields are filled and identifiers are unioned. Returns
 * "created", "updated" or "unchanged". An archived app is never recreated.
 */
export function upsertRecord(vault: string, p: RecordPatch): "created" | "updated" | "unchanged" | "archived" {
  if (!APP_ID.test(p.id)) throw new Error(`not an app id: ${p.id}`);
  const live = productDir(vault, p.id);
  if (!existsSync(live) && productArchiveDirs(vault).some((a) => existsSync(join(a, p.id)))) return "archived";
  const file = join(productWriteDir(vault, p.id), "manifest.json");
  let m: Record<string, unknown> = {};
  const existed = existsSync(join(live, "manifest.json"));
  try { m = JSON.parse(readFileSync(join(live, "manifest.json"), "utf8")) as Record<string, unknown>; } catch { m = {}; }
  const before = JSON.stringify(m);
  const fill = (k: string, v: unknown) => { if (v !== undefined && (m[k] === undefined || m[k] === null || m[k] === "")) m[k] = v; };
  fill("id", p.id);
  if (m.name === undefined && m.title === undefined) m.name = p.name;
  fill("kind", p.kind);
  fill("category", p.category);
  fill("integration", "manual");
  fill("domains", []);
  fill("lifecycle", p.lifecycle ?? "in use");
  // When and how it was found belong to the record's creation only.
  if (!existed) { fill("first_seen", p.first_seen ?? new Date().toISOString().slice(0, 10)); fill("found_by", p.found_by); }
  if (p.surfaces?.length) m.surfaces = [...new Set([...(Array.isArray(m.surfaces) ? (m.surfaces as string[]) : []), ...p.surfaces])].sort();
  if (p.identifiers) {
    const cur = (m.identifiers && typeof m.identifiers === "object" ? m.identifiers : {}) as Record<string, string[]>;
    for (const [k, vs] of Object.entries(p.identifiers)) cur[k] = [...new Set([...(cur[k] ?? []), ...vs])].sort();
    m.identifiers = cur;
  }
  if (JSON.stringify(m) === before) return "unchanged";
  writeJsonAtomic(file, m);
  return existed ? "updated" : "created";
}
