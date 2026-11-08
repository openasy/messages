// Sending. Every second, each channel takes the messages that are due, a few seconds' worth at its provider's rate,
// and for that batch, right before it goes out:
//   1. drops the addresses on the opt-out list or with an unfixed hard bounce;
//   2. asks Consent, in one POST /api/v1/check, whether each person may be reached on that channel now; a person
//      whose latest answer is not yes is held back. If Consent cannot be asked, nothing is sent: the batch waits;
//   3. claims each message (state sending, committed) before the provider is called, so a restart can never send it
//      again: a message still "sending" when Messages starts is set to unknown and left for a person to look at.
// Messages leave at the provider's rate (a token bucket per provider), SMS and WhatsApp wait out quiet hours, and a
// provider that could not take a message is tried again later, or through the email fallback, with the same row.
import type { Channel } from "./config.ts";
import { all, iso, one, parseJson, run, type Core, type Person } from "./core.ts";
import { consentCheck, LinkError } from "./links.ts";
import { consentChannel, type MessageRow, type People } from "./people.ts";
import { SendError, type EmailSender, type Sender, type SmsSender, type WhatsAppSender } from "./providers.ts";
import { renderEmail, renderSms, renderWhatsApp } from "./render.ts";
import { toTemplate, type Templates } from "./templates.ts";

export interface ProviderHealth {
  okAt: string | null;
  error: string | null;
  errorAt: string | null;
  sent: number;
}

const MAX_ATTEMPTS = 6;

/** Minutes after midnight in a time zone. */
export function localMinutes(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

export function inQuietHours(ms: number, q: { start: number; end: number } | null, timeZone: string): boolean {
  if (!q) return false;
  const m = localMinutes(ms, timeZone);
  return q.start < q.end ? m >= q.start && m < q.end : m >= q.start || m < q.end;
}

export function createDispatcher(core: Core, people: People, templates: Templates) {
  const { db } = core;
  const now = () => iso(core.clock());
  const health = new Map<string, ProviderHealth>();
  const buckets = new Map<string, { tokens: number; at: number }>();
  const busy = new Set<Channel>();
  /** Why a channel's messages are waiting, when they are: no provider, quiet hours, Consent away. */
  const waiting = new Map<Channel, string>();

  const h = (key: string) => {
    let x = health.get(key);
    if (!x) health.set(key, (x = { okAt: null, error: null, errorAt: null, sent: 0 }));
    return x;
  };

  /** Waits until the provider's bucket has a message to spend; at most `rate` a second, with a second's burst. */
  async function take(key: string, rate: number) {
    const cap = Math.max(1, rate);
    const b = buckets.get(key) ?? { tokens: cap, at: core.clock() };
    const t = core.clock();
    b.tokens = Math.min(cap, b.tokens + ((t - b.at) / 1000) * rate);
    b.at = t;
    if (b.tokens < 1) {
      await core.sleep(Math.ceil(((1 - b.tokens) / rate) * 1000));
      b.tokens = 1;
      b.at = core.clock();
    }
    b.tokens -= 1;
    buckets.set(key, b);
  }

  /** Called once at start: messages left "sending" by a stop may have reached the provider, so they are not sent again. */
  function recover(): number {
    const r = run(
      db,
      "UPDATE messages SET state = 'unknown', reason = 'Messages stopped while sending it, so it may have been sent; it is not sent again, so nobody gets it twice.' WHERE state = 'sending'",
    );
    return Number(r.changes);
  }

  const later = (attempts: number) => iso(core.clock() + Math.min(3_600_000, 60_000 * 2 ** Math.max(0, attempts - 1)));

  function senderFor(channel: Channel): { primary: Sender; fallback: Sender | null; rate: number; fallbackRate: number } | null {
    const s = core.senders();
    const c = core.config().providers;
    if (channel === "email")
      return s.email && c.email
        ? { primary: s.email.primary, fallback: s.email.fallback, rate: c.email.primary.rate, fallbackRate: c.email.fallback?.rate ?? 1 }
        : null;
    if (channel === "sms") return s.sms && c.sms ? { primary: s.sms, fallback: null, rate: c.sms.rate, fallbackRate: 1 } : null;
    return s.whatsapp && c.whatsapp ? { primary: s.whatsapp, fallback: null, rate: c.whatsapp.rate, fallbackRate: 1 } : null;
  }

  /** The rows due on a channel whose campaign is sending or whose journey is live. */
  function due(channel: Channel, limit: number): MessageRow[] {
    return all<MessageRow>(
      db,
      `SELECT m.* FROM messages m
         LEFT JOIN campaigns c ON c.id = m.campaign_id
         LEFT JOIN journeys j ON j.id = m.journey_id
        WHERE m.state = 'queued' AND m.channel = ? AND m.next_at <= ?
          AND (m.campaign_id IS NULL OR c.state = 'sending')
          AND (m.journey_id IS NULL OR j.state = 'live')
        ORDER BY m.next_at, m.rowid LIMIT ?`,
      channel,
      now(),
      limit,
    );
  }

  const setState = (id: string, state: string, reason: string | null) => run(db, "UPDATE messages SET state = ?, reason = ? WHERE id = ?", state, reason, id);

  async function channelTick(channel: Channel): Promise<number> {
    if (busy.has(channel) || !core.hasConfig()) return 0;
    busy.add(channel);
    try {
      const cfg = core.config();
      const s = senderFor(channel);
      if (!s) {
        const n = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM messages WHERE state = 'queued' AND channel = ?", channel)!.n;
        if (n) waiting.set(channel, `providers.${channel} is not set in messages.yaml.`);
        else waiting.delete(channel);
        return 0;
      }
      if (channel !== "email" && inQuietHours(core.clock(), cfg.limits.quietHours, cfg.limits.timezone)) {
        waiting.set(channel, `Quiet hours (${cfg.limits.quietHours!.text}).`);
        return 0;
      }
      const batch = due(channel, Math.min(1000, Math.max(10, Math.ceil(s.rate * 5))));
      if (!batch.length) {
        if (!one(db, "SELECT 1 FROM messages WHERE state = 'queued' AND channel = ? LIMIT 1", channel)) waiting.delete(channel);
        return 0;
      }

      // 1. The opt-out list and hard bounces.
      const open: MessageRow[] = [];
      for (const m of batch) {
        const why = people.suppressed(channel, m.address);
        if (why) setState(m.id, "suppressed", why);
        else open.push(m);
      }

      // 2. Consent, for the whole batch at once, now.
      let allowed = open;
      if (cfg.consent.check === "consent" && open.length) {
        let results;
        try {
          results = await consentCheck(
            core.links.client("consent"),
            cfg.consent.purpose,
            consentChannel(core, channel),
            open.map((m) => (channel === "email" ? { email: m.address } : { phone: m.address })),
          );
        } catch (err) {
          // Nothing goes out without an answer: the batch waits a minute.
          const msg = err instanceof LinkError ? err.message : String(err);
          waiting.set(channel, `Waiting for Consent: ${msg}`);
          const at = iso(core.clock() + 60_000);
          for (const m of open) run(db, "UPDATE messages SET next_at = ? WHERE id = ? AND state = 'queued'", at, m.id);
          core.log("warn", "consent could not be asked; nothing is sent until it can", { channel, error: msg });
          return 0;
        }
        allowed = [];
        open.forEach((m, i) => {
          const r = results[i]!;
          if (r.allowed) allowed.push(m);
          else
            setState(
              m.id,
              "held",
              r.status === "withdrawn"
                ? "Said no in Consent."
                : r.status === "renew"
                  ? "Said yes to an earlier text; Consent asks again."
                  : r.person === null && r.status === "none"
                    ? "No answer in Consent."
                    : `No yes for ${channel === "whatsapp" ? "WhatsApp" : channel} in Consent.`,
            );
        });
      }
      waiting.delete(channel);

      // 3. Claim, send, record.
      let sent = 0;
      for (const m of allowed) {
        // An unsubscribe that came in while this batch was going out still counts.
        const late = people.suppressed(channel, m.address);
        if (late) {
          setState(m.id, "suppressed", late);
          continue;
        }
        await take(`${channel}:primary`, s.rate);
        if (await sendOne(channel, m, s)) sent++;
      }
      return sent;
    } finally {
      busy.delete(channel);
    }
  }

  async function sendOne(channel: Channel, m: MessageRow, s: NonNullable<ReturnType<typeof senderFor>>): Promise<boolean> {
    const claimed = run(db, "UPDATE messages SET state = 'sending', attempts = attempts + 1 WHERE id = ? AND state = 'queued'", m.id);
    if (Number(claimed.changes) !== 1) return false;
    const attempts = m.attempts + 1;
    const cfg = core.config();
    const t = templates.row(m.template_id);
    if (!t) {
      setState(m.id, "failed", "Its template was deleted.");
      return false;
    }
    const tpl = toTemplate(t);
    const person = parseJson<Person>(m.person, { profile: null, userId: null, email: null, phone: null, name: null, fields: {} });
    const ctx = { config: cfg, publicUrl: core.publicUrl, messageId: m.id, utmCampaign: m.utm_campaign, variant: m.variant };
    let links: string[] = [];
    const attempt = async (sender: Sender) => {
      if (sender.channel === "email") {
        const subjectB =
          m.variant === "b" && m.campaign_id
            ? parseJson<{ subject?: string }>(one<{ ab: string }>(db, "SELECT ab FROM campaigns WHERE id = ?", m.campaign_id)?.ab, {}).subject
            : null;
        const e = renderEmail(tpl, person, ctx, subjectB ?? null);
        links = e.links;
        return (sender as EmailSender).send({
          id: m.id,
          from: { name: cfg.sender.name, email: cfg.sender.email! },
          replyTo: cfg.sender.replyTo,
          to: m.address,
          subject: e.subject,
          text: e.text,
          html: e.html,
          // RFC 8058 one-click unsubscribe: mail providers show an unsubscribe button that POSTs to the link.
          headers: { "List-Unsubscribe": `<${e.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "X-OpenAsy-Message": m.id },
        });
      }
      if (sender.channel === "sms") {
        const r = renderSms(tpl, person, ctx, cfg.providers.sms!.stop);
        links = r.links;
        return (sender as SmsSender).send({ id: m.id, to: m.address, text: r.text });
      }
      if (t.approval && t.approval !== "APPROVED")
        throw new SendError(`The WhatsApp template ${tpl.waName} is ${t.approval.toLowerCase()} at Meta, not approved.`, "refused");
      const r = renderWhatsApp(tpl, person, ctx);
      links = r.links;
      return (sender as WhatsAppSender).send({ id: m.id, to: m.address, template: tpl.waName ?? tpl.name, lang: tpl.lang, params: r.params });
    };
    let used = "primary";
    try {
      let result;
      try {
        result = await attempt(s.primary);
      } catch (err) {
        // The fallback only when the primary surely did not take it.
        if (!(err instanceof SendError) || err.outcome !== "retry" || !s.fallback) throw err;
        noteError(`${channel}:primary`, err.message);
        used = "fallback";
        await take(`${channel}:fallback`, s.fallbackRate);
        result = await attempt(s.fallback);
      }
      const at = now();
      run(
        db,
        "UPDATE messages SET state = 'sent', reason = NULL, provider = ?, provider_id = ?, sent_at = ?, links = ? WHERE id = ?",
        `${channel}:${used}`,
        result.providerId,
        at,
        JSON.stringify(links),
        m.id,
      );
      const x = h(`${channel}:${used}`);
      Object.assign(x, { okAt: at, error: null, errorAt: null, sent: x.sent + 1 });
      people.audienceEvent(m, "message_sent", `${channel === "email" ? "Email" : channel === "sms" ? "SMS" : "WhatsApp message"} sent: ${m.utm_campaign}`, at);
      return true;
    } catch (err) {
      const e = err instanceof SendError ? err : new SendError(String(err), "unknown");
      noteError(`${channel}:${used}`, e.message);
      if (e.outcome === "retry") {
        if (attempts >= MAX_ATTEMPTS) setState(m.id, "failed", `${e.message} Tried ${attempts} times.`);
        else run(db, "UPDATE messages SET state = 'queued', reason = ?, next_at = ? WHERE id = ?", e.message, later(attempts), m.id);
      } else if (e.outcome === "refused") {
        if (e.hard) {
          run(db, "UPDATE messages SET state = 'bounced', reason = ?, bounced_at = ? WHERE id = ?", e.message, now(), m.id);
          people.bounce(channel, m.address, true, e.message, m.id, `${channel}:${used}`);
        } else setState(m.id, "failed", e.message);
      } else setState(m.id, "unknown", `${e.message} It may have been sent, so it is not sent again.`);
      core.log("warn", "message not sent", { channel, outcome: e.outcome, error: e.message });
      return false;
    }
  }

  function noteError(key: string, error: string) {
    Object.assign(h(key), { error, errorAt: now() });
  }

  /** Every channel at once; the number sent. */
  async function tick(): Promise<number> {
    const n = await Promise.all(
      (["email", "sms", "whatsapp"] as const).map((c) =>
        channelTick(c).catch((err) => (core.log("error", "send tick failed", { channel: c, error: String(err) }), 0)),
      ),
    );
    return n.reduce((a, b) => a + b, 0);
  }

  /** Reads SMS delivery reports for messages sent in the last three days that have none yet. */
  async function pullSmsReports(apply: (providerId: string, r: { state: "delivered" | "failed" | "waiting"; hard: boolean; reason: string | null }) => void) {
    if (!core.hasConfig()) return 0;
    const sms = core.senders().sms as SmsSender | null;
    if (!sms) return 0;
    const ids = all<{ provider_id: string }>(
      db,
      "SELECT provider_id FROM messages WHERE channel = 'sms' AND state = 'sent' AND provider_id IS NOT NULL AND sent_at >= ? ORDER BY sent_at LIMIT 200",
      iso(core.clock() - 3 * 86_400_000),
    ).map((r) => r.provider_id);
    if (!ids.length) return 0;
    try {
      const reports = await sms.reports(ids);
      for (const r of reports) apply(r.providerId, r);
      return reports.length;
    } catch (err) {
      core.log("warn", "SMS delivery reports could not be read", { error: (err as Error).message });
      return 0;
    }
  }

  return { tick, recover, pullSmsReports, health: () => health, waiting: () => waiting, take };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
