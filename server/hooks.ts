// What comes back after a message is sent: delivery reports and bounces from the providers, opens, clicks and
// unsubscribes from the person. Provider webhooks are checked before they are read: SNS messages by their signature,
// WhatsApp's by X-Hub-Signature-256, and the SMS providers', which sign nothing, by a random secret in their address.
import { timingSafeEqual } from "node:crypto";
import type { Channel } from "./config.ts";
import { iso, mask, one, parseJson, run, type Core } from "./core.ts";
import { MsgError } from "./errors.ts";
import type { MessageRow, People } from "./people.ts";
import { escapeHtml } from "./render.ts";
import { isStop, readSmsInbound, readSmsPush } from "./sms.ts";
import { readSesEvent, snsHostOk, SnsError, verifySns } from "./sns.ts";
import type { Templates } from "./templates.ts";
import { readWhatsAppWebhook, whatsappSignatureOk } from "./whatsapp.ts";

export function createResults(core: Core, people: People, templates: Templates) {
  const { db } = core;
  const now = () => iso(core.clock());
  const byProvider = (channel: Channel, providerId: string) =>
    one<MessageRow & { bounced_at: string | null }>(db, "SELECT * FROM messages WHERE channel = ? AND provider_id = ? LIMIT 1", channel, providerId);

  /** A delivery report or a bounce for a sent message, by the provider's id. */
  function report(
    channel: Channel,
    providerId: string,
    r: { state: "delivered" | "failed" | "waiting" | "read"; hard: boolean; reason: string | null },
    source: string,
  ) {
    const m = byProvider(channel, providerId);
    if (!m) return false;
    const at = now();
    if (r.state === "delivered" || r.state === "read") {
      run(
        db,
        "UPDATE messages SET state = CASE WHEN state = 'sent' THEN 'delivered' ELSE state END, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?",
        at,
        m.id,
      );
      if (r.state === "read") opened(m);
    } else if (r.state === "failed") {
      if (m.bounced_at) return true;
      run(db, "UPDATE messages SET state = 'bounced', reason = ?, bounced_at = ? WHERE id = ?", r.reason, at, m.id);
      people.bounce(channel, m.address, r.hard, r.reason ?? "Not delivered", m.id, source);
    }
    return true;
  }

  function opened(m: MessageRow) {
    const r = run(db, "UPDATE messages SET opened_at = ? WHERE id = ? AND opened_at IS NULL", now(), m.id);
    if (Number(r.changes)) people.audienceEvent(m, "message_opened", `Opened ${m.utm_campaign}`);
  }

  const message = (id: string) =>
    /^[A-Za-z0-9_-]{8,40}$/.test(id) ? one<MessageRow & { unsubscribed_at: string | null }>(db, "SELECT * FROM messages WHERE id = ?", id) : undefined;

  /** The open pixel: counted once per message. Image proxies and privacy features open many emails on their own. */
  function open(id: string) {
    const m = message(id);
    if (m && m.channel === "email" && m.address) opened(m);
  }

  /** A tracked link: counted, then the person goes on to the tagged address. Null when there is no such link. */
  function click(id: string, n: number): string | null {
    const m = message(id);
    const url = m ? parseJson<string[]>(m.links, [])[n] : undefined;
    if (!m || !url) return null;
    if (!m.address) return url;
    run(db, "INSERT INTO clicks (message_id, url, at) VALUES (?, ?, ?)", m.id, url, now());
    const first = Number(run(db, "UPDATE messages SET clicked_at = ? WHERE id = ? AND clicked_at IS NULL", now(), m.id).changes);
    // A click on an email is also an open, whether or not its images were shown.
    if (m.channel === "email") opened(m);
    if (first) people.audienceEvent(m, "message_clicked", `Clicked a link in ${m.utm_campaign}`);
    return url;
  }

  // ---------------------------------------------------------------- Unsubscribe page

  const PAGE_WORDS: Record<
    string,
    { title: string; ask: (a: string, s: string) => string; button: string; done: (a: string, s: string) => string; gone: string }
  > = {
    en: {
      title: "Unsubscribe",
      ask: (a, s) => `Stop emails from ${s} to ${a}?`,
      button: "Unsubscribe",
      done: (a, s) => `${a} will get no more emails from ${s}. It takes effect at once.`,
      gone: "This link is not valid any more.",
    },
    tr: {
      title: "Abonelikten çık",
      ask: (a, s) => `${s} e-postaları ${a} adresine artık gelmesin mi?`,
      button: "Abonelikten çık",
      done: (a, s) => `${a} adresine ${s} e-postası artık gelmeyecek. Hemen geçerlidir.`,
      gone: "Bu bağlantı artık geçerli değil.",
    },
    de: {
      title: "Abmelden",
      ask: (a, s) => `Keine E-Mails mehr von ${s} an ${a}?`,
      button: "Abmelden",
      done: (a, s) => `${a} erhält keine E-Mails mehr von ${s}. Das gilt sofort.`,
      gone: "Dieser Link ist nicht mehr gültig.",
    },
  };

  function page(lang: string, title: string, body: string) {
    return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f5f5f4;color:#1c1917}main{max-width:28rem;margin:4rem auto;padding:1.5rem;background:#fff;border:1px solid #e7e5e4;border-radius:.5rem}h1{font-size:1.125rem;margin:0 0 .75rem}p{line-height:1.5}button{font:inherit;padding:.5rem 1rem;border-radius:.375rem;border:1px solid #1c1917;background:#1c1917;color:#fff;cursor:pointer}</style></head><body><main>${body}</main></body></html>`;
  }

  /** GET /u/<id>: asks first, so a link checker that opens every link does not unsubscribe anyone. */
  function unsubscribePage(id: string, posted: boolean): { status: number; html: string } {
    const m = message(id);
    const lang = (m && templates.row(m.template_id)?.lang.slice(0, 2)) || "en";
    const w = PAGE_WORDS[lang] ?? PAGE_WORDS.en!;
    if (!m || !m.address) return { status: 404, html: page(lang, w.title, `<h1>${escapeHtml(w.title)}</h1><p>${escapeHtml(w.gone)}</p>`) };
    const sender = core.hasConfig() ? core.config().sender.name : "us";
    const shown = mask(m.address);
    if (posted || m.unsubscribed_at) {
      if (posted) people.optOut(m.channel, m.address, "unsubscribe", m.id);
      return { status: 200, html: page(lang, w.title, `<h1>${escapeHtml(w.title)}</h1><p role="status">${escapeHtml(w.done(shown, sender))}</p>`) };
    }
    return {
      status: 200,
      html: page(
        lang,
        w.title,
        `<h1>${escapeHtml(w.title)}</h1><p>${escapeHtml(w.ask(shown, sender))}</p><form method="post"><button type="submit">${escapeHtml(w.button)}</button></form>`,
      ),
    };
  }

  /** POST /u/<id>: the page's button, and RFC 8058 one-click (List-Unsubscribe=One-Click) from mail apps. */
  function unsubscribe(id: string) {
    return unsubscribePage(id, true);
  }

  return { report, open, click, unsubscribePage, unsubscribe };
}

export type Results = ReturnType<typeof createResults>;

// ---------------------------------------------------------------- Provider webhooks

export function createHooks(core: Core, people: People, results: Results, templates: Templates) {
  const sesTopics = () => {
    const e = core.hasConfig() ? core.config().providers.email : null;
    return [e?.primary, e?.fallback].filter((p) => p?.kind === "ses").map((p) => (p as { topic: string | null }).topic);
  };

  /** POST /hooks/ses: SNS messages carrying SES events. */
  async function ses(raw: string): Promise<{ status: number; body: unknown }> {
    const topics = sesTopics();
    if (!topics.length) throw new MsgError(404, "not-configured", "No Amazon SES provider is set in messages.yaml.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new MsgError(400, "invalid-json", "The body must be an SNS message in JSON.");
    }
    let m;
    try {
      // The topic is compared below, against every SES provider's sns_topic.
      m = await verifySns(parsed, null, core.http);
      const allowed = topics.filter(Boolean) as string[];
      if (allowed.length && !allowed.includes(m.TopicArn)) throw new SnsError(`The SNS topic ${m.TopicArn} is not the one in messages.yaml.`);
    } catch (err) {
      if (err instanceof SnsError) {
        core.log("warn", "SNS message refused", { error: err.message });
        throw new MsgError(403, "invalid-signature", err.message);
      }
      throw err;
    }
    if (m.Type === "SubscriptionConfirmation") {
      if (!snsHostOk(m.SubscribeURL)) throw new MsgError(403, "invalid-signature", "SubscribeURL is not an SNS address.");
      const res = await core.http(m.SubscribeURL!, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      core.log("info", "SNS subscription confirmed", { topic: m.TopicArn, status: res.status });
      return { status: 200, body: { status: "subscribed", topic: m.TopicArn } };
    }
    if (m.Type !== "Notification") return { status: 200, body: { status: "ignored" } };
    const e = readSesEvent(m.Message);
    if (!e) return { status: 200, body: { status: "ignored" } };
    let matched = false;
    if (e.kind === "delivery") matched = results.report("email", e.messageId, { state: "delivered", hard: false, reason: null }, "ses");
    else if (e.kind === "bounce") matched = results.report("email", e.messageId, { state: "failed", hard: e.hard, reason: e.reason }, "ses");
    else if (e.kind === "reject") matched = results.report("email", e.messageId, { state: "failed", hard: false, reason: e.reason }, "ses");
    else if (e.kind === "complaint") {
      const row = one<{ id: string; address: string }>(core.db, "SELECT id, address FROM messages WHERE channel = 'email' AND provider_id = ?", e.messageId);
      if (row?.address) {
        people.optOut("email", row.address, "complaint", row.id);
        matched = true;
      }
    }
    return { status: 200, body: { status: matched ? "recorded" : "unknown-message" } };
  }

  const secretOk = (given: string) => {
    const a = Buffer.from(given);
    const b = Buffer.from(core.hookSecret());
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /** POST or GET /hooks/sms/<secret>: a delivery report pushed by the SMS provider. */
  function smsReport(secret: string, fields: Record<string, unknown>) {
    if (!secretOk(secret)) throw new MsgError(404, "not-found", "Not found.");
    const sms = core.hasConfig() ? core.config().providers.sms : null;
    if (!sms) throw new MsgError(404, "not-configured", "providers.sms is not set in messages.yaml.");
    const r = readSmsPush(sms.kind, fields);
    if (!r) throw new MsgError(422, "invalid-body", "A report names the message (jobid or id) and its status.");
    const matched = r.state === "waiting" ? true : results.report("sms", r.providerId, r, sms.kind);
    return { status: matched ? "recorded" : "unknown-message" };
  }

  /** POST or GET /hooks/sms/<secret>/inbound: an SMS sent back. STOP and its kin opt the number out at once. */
  function smsInbound(secret: string, fields: Record<string, unknown>) {
    if (!secretOk(secret)) throw new MsgError(404, "not-found", "Not found.");
    const r = readSmsInbound(fields);
    if (!r) throw new MsgError(422, "invalid-body", "An inbound SMS names the number (gsmno or from) and the text (msg or text).");
    if (!isStop(r.text)) return { status: "ignored" };
    const last = one<{ id: string }>(
      core.db,
      "SELECT id FROM messages WHERE channel = 'sms' AND address = ? AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1",
      r.from,
    );
    people.optOut("sms", r.from, "stop", last?.id ?? null);
    return { status: "opted-out" };
  }

  /** GET /hooks/whatsapp: Meta's check when the webhook is set, answered with the challenge if the verify token matches. */
  function whatsappVerify(q: URLSearchParams): string {
    const w = core.hasConfig() ? core.config().providers.whatsapp : null;
    const expected = w ? core.env[w.verifyToken] : undefined;
    const given = q.get("hub.verify_token") ?? "";
    if (q.get("hub.mode") !== "subscribe" || !expected || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected)))
      throw new MsgError(403, "invalid-token", "The verify token does not match.");
    return q.get("hub.challenge") ?? "";
  }

  /** POST /hooks/whatsapp: statuses, replies and template approvals, after the signature is checked. */
  function whatsapp(raw: Buffer, signature: string | undefined) {
    const w = core.hasConfig() ? core.config().providers.whatsapp : null;
    if (!w) throw new MsgError(404, "not-configured", "providers.whatsapp is not set in messages.yaml.");
    if (!whatsappSignatureOk(raw, signature, core.env[w.appSecret]))
      throw new MsgError(403, "invalid-signature", "X-Hub-Signature-256 does not match the app secret.");
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new MsgError(400, "invalid-json", "The body must be JSON.");
    }
    let n = 0;
    for (const e of readWhatsAppWebhook(payload)) {
      n++;
      if (e.kind === "status") {
        if (e.status === "delivered" || e.status === "read")
          results.report("whatsapp", e.providerId, { state: e.status, hard: false, reason: null }, "whatsapp");
        else if (e.status === "failed") results.report("whatsapp", e.providerId, { state: "failed", hard: e.hard, reason: e.reason }, "whatsapp");
      } else if (e.kind === "reply" && isStop(e.text)) {
        const last = one<{ id: string }>(
          core.db,
          "SELECT id FROM messages WHERE channel = 'whatsapp' AND address = ? AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1",
          e.from,
        );
        people.optOut("whatsapp", e.from, "stop", last?.id ?? null);
      } else if (e.kind === "template") templates.approval(e.name, e.language, e.status);
    }
    return { received: n };
  }

  return { ses, smsReport, smsInbound, whatsappVerify, whatsapp };
}

export type Hooks = ReturnType<typeof createHooks>;
