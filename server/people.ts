// What Messages knows about people besides their messages: who opted out, which addresses bounce, and what it owes
// the linked products. An unsubscribe or a STOP takes effect at once: the address goes on Messages' own opt-out list,
// which is checked before every send whether or not Consent is linked; every message still waiting for that address
// is cancelled; the person leaves their journeys; and the refusal is recorded in Consent and sent to Audience through
// the outbox, which tries again until they take it.
import type { Channel } from "./config.ts";
import { all, hashAddress, iso, one, parseJson, run, tx, type Actor, type Core, type Person } from "./core.ts";
import { bad, isObj } from "./errors.ts";
import { normalEmail, normalPhone, normalUserId } from "./identity.ts";
import { audienceEvents, consentRecord, LinkError, type ConsentChannel } from "./links.ts";

export interface MessageRow {
  id: string;
  campaign_id: string | null;
  journey_id: string | null;
  run_id: string | null;
  step_id: string | null;
  variant: string | null;
  channel: Channel;
  address: string;
  person: string;
  template_id: string;
  utm_campaign: string;
  state: string;
  attempts: number;
  provider_id: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  delivered_at: string | null;
  links: string | null;
}

export type OptOutSource = "unsubscribe" | "stop" | "complaint";

/** The Consent channel a message channel's answer is kept on. */
export const consentChannel = (core: Core, c: Channel): ConsentChannel => (c === "whatsapp" ? core.config().consent.whatsapp : c);

export function createPeople(core: Core) {
  const { db } = core;
  const now = () => iso(core.clock());

  /** Why an address may not be sent to on a channel: opted out here, or bounced hard and not fixed. */
  function suppressed(channel: Channel, address: string): string | null {
    const h = hashAddress(channel, address);
    const o = one<{ source: string; at: string }>(db, "SELECT source, at FROM optouts WHERE channel = ? AND hash = ?", channel, h);
    if (o) return o.source === "complaint" ? "Marked a message as spam; not sent to again." : "Opted out here; not sent to again.";
    const b = one<{ reason: string }>(
      db,
      "SELECT reason FROM bounces WHERE channel = ? AND hash = ? AND kind = 'hard' AND cleared_at IS NULL ORDER BY id DESC LIMIT 1",
      channel,
      h,
    );
    return b ? `Bounced hard (${b.reason}); not sent to again until fixed.` : null;
  }

  // ---------------------------------------------------------------- Outbox

  function queue(target: "audience" | "consent", body: unknown) {
    run(db, "INSERT INTO outbox (target, body, next_at, created_at) VALUES (?, ?, ?, ?)", target, JSON.stringify(body), now(), now());
  }

  /** An event about a message for Audience, once per message and type (its id makes Audience keep it once). */
  function audienceEvent(m: Pick<MessageRow, "id" | "channel" | "person" | "utm_campaign">, type: string, text: string, at = now()) {
    const a = core.hasConfig() ? core.config().products.audience : null;
    if (!a?.events) return;
    const p = parseJson<Person>(m.person, { profile: null, userId: null, email: null, phone: null, name: null, fields: {} });
    const person = {
      ...(p.email && { email: p.email }),
      ...(p.phone && { phone: p.phone }),
      ...(p.userId && { userId: p.userId }),
      ...(p.name && { name: p.name }),
    };
    if (!Object.keys(person).length) return;
    queue("audience", {
      source: "messages",
      type,
      id: `${m.id}:${type}`,
      at,
      person,
      properties: { campaign: m.utm_campaign, channel: m.channel },
      text: text.slice(0, 300),
    });
  }

  let flushing = false;
  /** Sends what is due in the outbox: Audience events in batches of up to 500, Consent answers one person at a time. */
  async function flush() {
    if (flushing || !core.hasConfig()) return;
    flushing = true;
    try {
      for (const target of ["audience", "consent"] as const) {
        if (!core.links.has(target)) continue;
        const due = all<{ id: number; body: string; attempts: number }>(
          db,
          "SELECT id, body, attempts FROM outbox WHERE target = ? AND next_at <= ? ORDER BY id LIMIT 500",
          target,
          now(),
        );
        if (!due.length) continue;
        const done = (ids: number[]) => ids.length && run(db, `DELETE FROM outbox WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
        const later = (rows: typeof due, err: LinkError | Error) => {
          for (const r of rows) {
            const wait = Math.min(6 * 3_600_000, 60_000 * 2 ** Math.min(r.attempts, 10));
            run(db, "UPDATE outbox SET attempts = attempts + 1, next_at = ?, error = ? WHERE id = ?", iso(core.clock() + wait), err.message, r.id);
          }
        };
        try {
          const c = core.links.client(target);
          if (target === "audience") {
            try {
              await audienceEvents(
                c,
                due.map((r) => JSON.parse(r.body)),
              );
              done(due.map((r) => r.id));
            } catch (err) {
              // A batch Audience cannot read (422) is tried one event at a time, and an event it refuses is dropped.
              if (!(err instanceof LinkError) || err.status !== 422) throw err;
              for (const r of due) {
                try {
                  await audienceEvents(c, [JSON.parse(r.body)]);
                } catch (e) {
                  if (!(e instanceof LinkError) || e.status !== 422) throw e;
                  core.log("warn", "Audience refused an event; it is dropped", { error: e.message });
                }
                done([r.id]);
              }
            }
          } else
            for (const r of due) {
              try {
                await consentRecord(c, JSON.parse(r.body));
                done([r.id]);
              } catch (err) {
                if (err instanceof LinkError && err.status === 422) {
                  core.log("warn", "Consent refused an answer from Messages; it is dropped", { error: err.message });
                  done([r.id]);
                } else throw err;
              }
            }
        } catch (err) {
          later(
            all<{ id: number; body: string; attempts: number }>(
              db,
              "SELECT id, body, attempts FROM outbox WHERE target = ? AND next_at <= ? ORDER BY id LIMIT 500",
              target,
              now(),
            ),
            err as Error,
          );
          core.log("warn", `could not reach ${target}; its outbox waits`, { error: (err as Error).message });
        }
      }
    } finally {
      flushing = false;
    }
  }

  // ---------------------------------------------------------------- Opt-outs

  /**
   * An unsubscribe, a STOP reply or a spam complaint. At once: the address is on the opt-out list, the messages waiting
   * for it are cancelled, the person leaves their journeys, and Consent and Audience are told.
   */
  function optOut(channel: Channel, address: string, source: OptOutSource, messageId: string | null): { already: boolean } {
    const at = now();
    const m = messageId ? one<MessageRow>(db, "SELECT * FROM messages WHERE id = ?", messageId) : undefined;
    const already = tx(db, () => {
      const h = hashAddress(channel, address);
      const ins = run(
        db,
        "INSERT OR IGNORE INTO optouts (channel, hash, address, source, message_id, at) VALUES (?, ?, ?, ?, ?, ?)",
        channel,
        h,
        address,
        source,
        messageId,
        at,
      );
      run(
        db,
        "UPDATE messages SET state = 'cancelled', reason = 'Opted out before it was sent.' WHERE channel = ? AND address = ? AND state IN ('queued', 'waiting')",
        channel,
        address,
      );
      if (m && !(m as { unsubscribed_at?: string }).unsubscribed_at) run(db, "UPDATE messages SET unsubscribed_at = ? WHERE id = ?", at, m.id);
      // Opting out of any channel ends the person's journeys.
      const col = channel === "email" ? "email" : "phone";
      run(db, `UPDATE journey_runs SET state = 'exited', reason = 'opted-out', left_at = ? WHERE state = 'active' AND ${col} = ?`, at, address);
      return Number(ins.changes) === 0;
    });
    if (already) return { already };
    const cfg = core.config();
    if (core.links.has("consent")) {
      const p = m ? parseJson<Person>(m.person, {} as Person) : null;
      queue("consent", {
        person: channel === "email" ? { email: address } : { phone: address },
        source: "api",
        via: `messages/${m?.utm_campaign ?? channel}`.slice(0, 128),
        answers: [
          {
            purpose: cfg.consent.purpose,
            channel: consentChannel(core, channel),
            granted: false,
            at,
            proof: (source === "unsubscribe"
              ? `Unsubscribe link in a Messages email${m ? ` (${m.utm_campaign})` : ""}`
              : source === "stop"
                ? `Replied STOP to ${channel === "sms" ? "an SMS" : "a WhatsApp message"}${p?.name ? ` (${p.name})` : ""}`
                : "Marked an email as spam"
            ).slice(0, 500),
          },
        ],
      });
    }
    if (m) audienceEvent(m, "unsubscribed", source === "stop" ? `Replied STOP to ${channel}` : `Unsubscribed from ${m.utm_campaign}`, at);
    core.log("info", "opted out", { channel, source });
    return { already };
  }

  // ---------------------------------------------------------------- Bounces

  /** A bounce. A hard one stops the address at once; soft ones do too after limits.soft_bounce_tries in a row. */
  function bounce(channel: Channel, address: string, hard: boolean, reason: string, messageId: string | null, source: string) {
    const h = hashAddress(channel, address);
    const at = now();
    let kind: "hard" | "soft" = hard ? "hard" : "soft";
    tx(db, () => {
      if (!hard) {
        // Soft bounces in a row, since the last message that arrived or the last fix.
        const lastGood = one<{ at: string | null }>(
          db,
          "SELECT MAX(delivered_at) AS at FROM messages WHERE channel = ? AND address = ? AND delivered_at IS NOT NULL",
          channel,
          address,
        )?.at;
        const lastFix = one<{ at: string | null }>(db, "SELECT MAX(cleared_at) AS at FROM bounces WHERE channel = ? AND hash = ?", channel, h)?.at;
        const since = [lastGood, lastFix].filter(Boolean).sort().at(-1) ?? "";
        const soft = one<{ n: number }>(
          db,
          "SELECT COUNT(*) AS n FROM bounces WHERE channel = ? AND hash = ? AND kind = 'soft' AND at > ?",
          channel,
          h,
          since,
        )!.n;
        if (soft + 1 >= core.config().limits.softBounceTries) {
          kind = "hard";
          reason = `${reason}; soft bounce ${soft + 1} in a row`;
        }
      }
      run(
        db,
        "INSERT INTO bounces (channel, hash, address, kind, reason, message_id, source, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        channel,
        h,
        address,
        kind,
        reason.slice(0, 300),
        messageId,
        source,
        at,
      );
      if (kind === "hard")
        run(
          db,
          "UPDATE messages SET state = 'suppressed', reason = 'The address bounced hard before it was sent.' WHERE channel = ? AND address = ? AND state IN ('queued', 'waiting')",
          channel,
          address,
        );
    });
    if (messageId) {
      const m = one<MessageRow>(db, "SELECT * FROM messages WHERE id = ?", messageId);
      if (m) audienceEvent(m, "message_bounced", `${kind === "hard" ? "Hard" : "Soft"} bounce: ${reason}`.slice(0, 300), at);
    }
    return kind;
  }

  function listBounces() {
    const rows = all<{
      id: number;
      channel: Channel;
      address: string | null;
      kind: "hard" | "soft";
      reason: string;
      message_id: string | null;
      at: string;
      cleared_at: string | null;
      campaign: string | null;
    }>(
      db,
      `SELECT b.id, b.channel, b.address, b.kind, b.reason, b.message_id, b.at, b.cleared_at,
              COALESCE(c.name, j.name) AS campaign
         FROM bounces b LEFT JOIN messages m ON m.id = b.message_id
         LEFT JOIN campaigns c ON c.id = m.campaign_id LEFT JOIN journeys j ON j.id = m.journey_id
        WHERE b.cleared_at IS NULL AND (b.kind = 'hard' OR b.at >= ?)
        ORDER BY b.at DESC LIMIT 1000`,
      iso(core.clock() - 30 * 86_400_000),
    );
    // One row per address: the latest hard bounce stops it, and soft ones are listed as they come.
    const seen = new Set<string>();
    return rows
      .filter((r) => {
        if (r.kind !== "hard") return true;
        const k = `${r.channel}:${r.address}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((r) => ({ id: r.id, channel: r.channel, address: r.address ?? "(erased)", kind: r.kind, reason: r.reason, from: r.campaign, at: r.at }));
  }

  /** "Fixed, send again": every hard bounce of the address is cleared, so it may be sent to again. */
  function clearBounce(id: number, who: Actor) {
    const b = one<{ channel: string; hash: string; address: string | null }>(db, "SELECT channel, hash, address FROM bounces WHERE id = ?", id);
    if (!b) return null;
    run(db, "UPDATE bounces SET cleared_at = ?, cleared_by = ? WHERE channel = ? AND hash = ? AND cleared_at IS NULL", now(), who.name, b.channel, b.hash);
    core.log("info", "bounce cleared", { by: who.id, channel: b.channel });
    return { address: b.address ?? "(erased)" };
  }

  function listOptOuts() {
    return all<{ channel: Channel; address: string | null; source: OptOutSource; at: string }>(
      db,
      "SELECT channel, address, source, at FROM optouts ORDER BY at DESC LIMIT 1000",
    ).map((o) => ({ ...o, address: o.address ?? "(erased)" }));
  }

  // ---------------------------------------------------------------- Erasure

  /**
   * Audience's erasure contract (its openapi.json webhooks, erasure): delete everything Messages keeps about the
   * people with these identifiers. Opt-outs and hard bounces keep only the sha256 of the address, so the person is not
   * written to again; campaign counts stay, without the person.
   */
  function erase(raw: unknown, who: Actor) {
    if (!isObj(raw) || typeof raw.reference !== "string" || raw.reference.trim().length < 3 || !isObj(raw.people))
      throw bad("The body is { reference, product, people: { emails, phones, userIds } }.");
    const reference = raw.reference.trim().slice(0, 200);
    const before = one<{ deleted: number }>(db, "SELECT deleted FROM erasures WHERE reference = ?", reference);
    if (before) return { status: "done" as const, deleted: before.deleted };
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    const country = core.hasConfig() ? core.config().limits.phoneCountry : "TR";
    const emails = list(raw.people.emails).map(normalEmail).filter(Boolean) as string[];
    const phones = list(raw.people.phones)
      .map((p) => normalPhone(p, country))
      .filter(Boolean) as string[];
    const userIds = list(raw.people.userIds).map(normalUserId).filter(Boolean) as string[];
    const addresses = [...emails, ...phones];
    const q = (n: number) => Array.from({ length: n }, () => "?").join(",");
    let deleted = 0;
    tx(db, () => {
      if (addresses.length || userIds.length) {
        const where = [
          ...(addresses.length ? [`address IN (${q(addresses.length)})`] : []),
          ...(userIds.length ? [`json_extract(person, '$.userId') IN (${q(userIds.length)})`] : []),
        ].join(" OR ");
        const ids = all<{ id: string }>(db, `SELECT id FROM messages WHERE ${where}`, ...addresses, ...userIds).map((r) => r.id);
        for (const id of ids) {
          run(
            db,
            "UPDATE messages SET address = '', person = '{}', links = NULL, state = CASE WHEN state IN ('queued', 'waiting') THEN 'cancelled' ELSE state END WHERE id = ?",
            id,
          );
          run(db, "DELETE FROM clicks WHERE message_id = ?", id);
        }
        deleted += ids.length;
        const lm = [
          ...(emails.length ? [`email IN (${q(emails.length)})`] : []),
          ...(phones.length ? [`phone IN (${q(phones.length)})`] : []),
          ...(userIds.length ? [`user_id IN (${q(userIds.length)})`] : []),
        ].join(" OR ");
        deleted += Number(run(db, `DELETE FROM list_members WHERE ${lm}`, ...emails, ...phones, ...userIds).changes);
        deleted += Number(run(db, `DELETE FROM journey_runs WHERE ${lm}`, ...emails, ...phones, ...userIds).changes);
        run(db, "UPDATE lists SET size = (SELECT COUNT(*) FROM list_members WHERE list_id = lists.id)");
        if (addresses.length) {
          run(db, `UPDATE bounces SET address = NULL WHERE address IN (${q(addresses.length)})`, ...addresses);
          run(db, `UPDATE optouts SET address = NULL WHERE address IN (${q(addresses.length)})`, ...addresses);
        }
        // Pending calls that name them; Consent and Audience erase the person themselves.
        for (const a of [...addresses, ...userIds]) run(db, "DELETE FROM outbox WHERE body LIKE ?", `%${JSON.stringify(a).slice(1, -1)}%`);
      }
      run(
        db,
        "INSERT INTO erasures (reference, product, deleted, at, actor) VALUES (?, ?, ?, ?, ?)",
        reference,
        String(raw.product ?? "audience").slice(0, 40),
        deleted,
        now(),
        who.name,
      );
    });
    core.log("info", "erasure done", { reference, deleted, by: who.id });
    return { status: "done" as const, deleted };
  }

  return { suppressed, optOut, bounce, listBounces, clearBounce, listOptOuts, erase, audienceEvent, flush, queue };
}

export type People = ReturnType<typeof createPeople>;
