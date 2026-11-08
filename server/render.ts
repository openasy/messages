// A template with a person's fields, as each channel sends it. {{first_name}} takes the field, and {{first_name|there}}
// a word for people without it. Every link is tagged with utm_source, utm_medium and utm_campaign, the parameters
// Analytics keeps, so visits and goals count the campaign; with click tracking, the link in the message goes through
// Messages first, which counts the click and sends the person on to the tagged address. Every email ends with an
// unsubscribe link, and every SMS with how to stop.
import type { Channel, Config } from "./config.ts";
import type { Person } from "./core.ts";

export interface Template {
  id: string;
  name: string;
  channel: Channel;
  lang: string;
  subject: string | null;
  body: string;
  format: "text" | "html";
  waName: string | null;
  waParams: string[];
}

export type Fields = Record<string, string | number | boolean | null | undefined>;

export function fieldsOf(p: Person): Fields {
  const [first, ...rest] = (p.name ?? "").split(/\s+/).filter(Boolean);
  return {
    first_name: first,
    last_name: rest.join(" ") || undefined,
    name: p.name ?? undefined,
    email: p.email ?? undefined,
    phone: p.phone ?? undefined,
    user_id: p.userId ?? undefined,
    ...p.fields,
  };
}

const FIELD = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

/** The field names a text uses. */
export const fieldNames = (text: string) => [...new Set([...text.matchAll(FIELD)].map((m) => m[1]!))];

export function fill(text: string, fields: Fields, escape: (s: string) => string = (s) => s): string {
  return text.replace(FIELD, (_m, key: string, fallback: string | undefined) => {
    const v = fields[key];
    return escape(v === undefined || v === null || v === "" ? (fallback ?? "") : String(v));
  });
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface Tags {
  source: string;
  medium: Channel;
  campaign: string;
  content?: string | null;
}

/** The address with utm_source, utm_medium and utm_campaign (and utm_content for an A/B variant), unless it has them. */
export function tagUrl(url: string, t: Tags): string {
  const u = URL.parse(url);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return url;
  const set = (k: string, v: string | null | undefined) => v && !u.searchParams.has(k) && u.searchParams.set(k, v);
  set("utm_source", t.source);
  set("utm_medium", t.medium);
  set("utm_campaign", t.campaign);
  set("utm_content", t.content);
  return u.href;
}

const WORDS: Record<string, { unsubscribe: string; why: (sender: string) => string }> = {
  en: { unsubscribe: "Unsubscribe", why: (s) => `You get this email because you agreed to hear from ${s}.` },
  tr: { unsubscribe: "Abonelikten çık", why: (s) => `Bu e-postayı ${s} iletilerine onay verdiğiniz için alıyorsunuz.` },
  de: { unsubscribe: "Abmelden", why: (s) => `Sie erhalten diese E-Mail, weil Sie Nachrichten von ${s} zugestimmt haben.` },
};
export const wordsFor = (lang: string) => WORDS[lang.slice(0, 2)] ?? WORDS.en!;

export interface RenderContext {
  config: Config;
  publicUrl: string;
  /** The message's id: tracked links, the open pixel and the unsubscribe link carry it. Null for a preview. */
  messageId: string | null;
  utmCampaign: string;
  variant: string | null;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

/** Keeps each link the message has, in order, and gives the address the message shows for it. */
function linker(ctx: RenderContext, channel: Channel) {
  const links: string[] = [];
  const track = !!ctx.messageId && ctx.config.tracking.clicks;
  const tags: Tags = { source: ctx.config.tracking.utmSource, medium: channel, campaign: ctx.utmCampaign, content: ctx.variant };
  return {
    links,
    link(url: string): string {
      const tagged = tagUrl(url, tags);
      if (!track) return tagged;
      links.push(tagged);
      return `${ctx.publicUrl}/c/${ctx.messageId}/${links.length - 1}`;
    },
  };
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  links: string[];
  unsubscribeUrl: string | null;
}

export function renderEmail(t: Template, p: Person, ctx: RenderContext, subjectOverride?: string | null): RenderedEmail {
  const f = fieldsOf(p);
  const { links, link } = linker(ctx, "email");
  const w = wordsFor(t.lang);
  const sender = ctx.config.sender;
  const unsub = ctx.messageId ? `${ctx.publicUrl}/u/${ctx.messageId}` : null;
  const subject = fill(subjectOverride ?? t.subject ?? "", f)
    .replace(/[\r\n]+/g, " ")
    .trim();

  let bodyHtml: string;
  let bodyText: string;
  if (t.format === "html") {
    const html = fill(t.body, f, escapeHtml);
    bodyHtml = html.replace(/href\s*=\s*"(https?:\/\/[^"]+)"/gi, (_m, url: string) => `href="${escapeHtml(link(url.replace(/&amp;/g, "&")))}"`);
    bodyText = html
      .replace(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis, "$2 ($1)")
      .replace(/<(br|\/p|\/h\d|\/li|\/div)\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    // Text: paragraphs at blank lines, [words](https://...) and bare addresses as links.
    const filled = fill(t.body, f);
    const paragraphs = filled
      .split(/\n\s*\n/)
      .map((para) => para.trim())
      .filter(Boolean);
    const textLinks: string[] = [];
    bodyHtml = paragraphs
      .map((para) => {
        const parts: string[] = [];
        let last = 0;
        const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])/g;
        for (const m of para.matchAll(re)) {
          parts.push(escapeHtml(para.slice(last, m.index)).replace(/\n/g, "<br>"));
          const url = m[2] ?? m[3]!;
          const shown = link(url);
          textLinks.push(shown);
          parts.push(`<a href="${escapeHtml(shown)}">${escapeHtml(m[1] ?? url)}</a>`);
          last = m.index + m[0].length;
        }
        parts.push(escapeHtml(para.slice(last)).replace(/\n/g, "<br>"));
        return `<p style="margin:0 0 14px">${parts.join("")}</p>`;
      })
      .join("\n");
    let i = 0;
    bodyText = paragraphs.join("\n\n").replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])/g, (_m, words?: string) => {
      const shown = textLinks[i++]!;
      return words ? `${words} (${shown})` : shown;
    });
  }

  const footerHtml = [
    `<p style="margin:24px 0 0;font-size:12px;color:#6b7280">${escapeHtml(w.why(sender.name))}`,
    sender.address ? `<br>${escapeHtml(sender.address)}` : "",
    `<br><a href="${escapeHtml(unsub ?? "#")}" style="color:#6b7280">${escapeHtml(w.unsubscribe)}</a>`,
    ctx.messageId && ctx.config.tracking.opens
      ? `<img src="${ctx.publicUrl}/o/${ctx.messageId}.gif" width="1" height="1" alt="" style="display:block;border:0">`
      : "",
    "</p>",
  ].join("");
  const html = `<!doctype html><html lang="${escapeHtml(t.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111827"><div style="max-width:600px;margin:0 auto">${bodyHtml}${footerHtml}</div></body></html>`;
  const text = [bodyText, "", "--", w.why(sender.name), ...(sender.address ? [sender.address] : []), `${w.unsubscribe}: ${unsub ?? "#"}`].join("\n");
  return { subject, html, text, links, unsubscribeUrl: unsub };
}

export function renderSms(t: Template, p: Person, ctx: RenderContext, stop: string): { text: string; links: string[] } {
  const { links, link } = linker(ctx, "sms");
  let text = fill(t.body, fieldsOf(p))
    .replace(URL_IN_TEXT, (url) => link(url))
    .trim();
  // Every SMS says how to stop, unless the template already ends with it.
  if (!text.includes(stop)) text = `${text}\n${stop}`;
  return { text, links };
}

/** The texts for a WhatsApp template's {{1}}, {{2}}..., and the body with them, for previews and the record. */
export function renderWhatsApp(t: Template, p: Person, ctx: RenderContext): { params: string[]; text: string; links: string[] } {
  const f = fieldsOf(p);
  const { links, link } = linker(ctx, "whatsapp");
  const params = t.waParams.map(
    (x) =>
      fill(x, f)
        .replace(URL_IN_TEXT, (url) => link(url))
        .slice(0, 1024) || "-",
  );
  const text = t.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => params[Number(n) - 1] ?? "");
  return { params, text, links };
}
