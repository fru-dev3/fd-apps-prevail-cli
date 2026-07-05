// The Prevail notification design system (email). Every outbound notification
// - briefings, loop results, alerts - renders through ONE branded template
// instead of dumping raw markdown into an email body:
//   header   the Prevail wordmark + a kind chip (LOOP BRIEFING / ALERT / ...)
//   meta     what produced it: domain, source loop/routine, cadence
//   body     the markdown, actually rendered (headings, bold, lists)
//   footer   full provenance: source id, machine, engine version, timestamp,
//            and the in-app path to the thing that sent it
// Email-safe by construction: table layout, inline styles only, no external
// assets, no scripts, plain-text fallback. No emojis (house rule).

import { hostname } from "node:os";
import { VERSION } from "./version.ts";

export interface NotificationMeta {
  /** What produced this: "loop-briefing" | "loop-result" | "alert" | ... */
  kind: string;
  /** Human name of the producer (loop/routine name). */
  name: string;
  domain?: string;
  cadence?: string;
  /** In-app navigation hint rendered in the footer, e.g. "Domains > PostHog > Loops". */
  appPath?: string;
}

const ACCENT = "#4f46e5";
const INK = "#1f2430";
const MUTED = "#6b7280";
const BORDER = "#e5e7eb";
const BG = "#f6f6f8";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Minimal, dependency-free markdown -> email HTML: headings, bold, italics,
// bullet lists, paragraphs. Anything unrecognized stays readable text.
export function markdownToEmailHtml(md: string): string {
  const inline = (t: string) =>
    esc(t)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\s)\*([^*\s][^*]*)\*(?=\s|$)/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, `<code style="background:${BG};padding:1px 4px;border-radius:3px;font-size:13px;">$1</code>`);
  // Line-run processing (not whole-block): briefings routinely mix a bold
  // lead-in and bullets inside ONE block ("**Next steps**:\n- a\n- b"), so we
  // walk lines and open/close lists and paragraphs as the shape changes.
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p style="margin:8px 0;line-height:1.55;color:${INK};">${para.map(inline).join("<br/>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push(`<ul style="margin:8px 0;padding-left:22px;color:${INK};">${list.join("")}</ul>`);
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara(); flushList();
      const level = h[1]!.length;
      const size = level <= 2 ? 18 : 15;
      out.push(`<h${level} style="margin:18px 0 6px;font-size:${size}px;line-height:1.3;color:${INK};">${inline(h[2]!)}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushPara();
      list.push(`<li style="margin:4px 0;">${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return out.join("\n");
}

function kindLabel(kind: string): string {
  return kind.replace(/[-_]+/g, " ").toUpperCase();
}

export interface RenderedNotification {
  subject: string;
  html: string;
  text: string; // plain-text fallback (the original markdown + provenance)
}

// Render one notification. `bodyMarkdown` is the model/loop output verbatim.
export function renderNotificationEmail(meta: NotificationMeta, bodyMarkdown: string, now = new Date()): RenderedNotification {
  const subject = `Prevail · ${meta.name}${meta.domain ? ` · ${titleCaseWord(meta.domain)}` : ""}`;
  const when = now.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const provenance = [
    `Sent by ${meta.kind.includes("loop") ? "the loop" : "routine"} "${meta.name}"${meta.cadence ? ` (${meta.cadence})` : ""}${meta.domain ? ` in your ${titleCaseWord(meta.domain)} domain` : ""}.`,
    `Machine ${hostname()} · Prevail engine v${VERSION} · ${when}`,
    meta.appPath ? `Open in Prevail: ${meta.appPath}` : "",
  ].filter(Boolean);
  const html = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">
      <tr>
        <td style="padding:18px 28px;border-bottom:1px solid ${BORDER};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:17px;font-weight:700;letter-spacing:0.12em;color:${INK};">PREV<span style="color:${ACCENT};">AI</span>L</td>
            <td align="right"><span style="display:inline-block;padding:3px 10px;border:1px solid ${ACCENT};border-radius:999px;font-size:10px;font-weight:600;letter-spacing:0.1em;color:${ACCENT};">${esc(kindLabel(meta.kind))}</span></td>
          </tr></table>
        </td>
      </tr>
      <tr>
        <td style="padding:10px 28px;border-bottom:1px solid ${BORDER};font-size:12px;color:${MUTED};">
          ${esc(meta.name)}${meta.domain ? ` &middot; ${esc(titleCaseWord(meta.domain))} domain` : ""}${meta.cadence ? ` &middot; ${esc(meta.cadence)}` : ""}
        </td>
      </tr>
      <tr><td style="padding:20px 28px;font-size:14px;">${markdownToEmailHtml(bodyMarkdown)}</td></tr>
      <tr>
        <td style="padding:14px 28px;border-top:1px solid ${BORDER};background:${BG};font-size:11px;line-height:1.6;color:${MUTED};">
          ${provenance.map(esc).join("<br/>")}
        </td>
      </tr>
    </table>
  </td></tr>
</table>`.trim();
  const text = `${bodyMarkdown.trim()}\n\n----\n${provenance.join("\n")}`;
  return { subject, html, text };
}

function titleCaseWord(s: string): string {
  return s.split(/[\s-]+/).map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}
