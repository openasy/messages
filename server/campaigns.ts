// Campaigns: one send to a segment from Audience or an imported list. When its time comes, the audience is read a page
// at a time and each person gets one message row, keyed by the campaign and the address, so a person in the segment
// twice, a page read again after a restart, or the same email on two profiles still gets one message. Where reading
// stopped is kept with the campaign, so a restart carries on from there. Consent is not decided here: the dispatcher
// asks it for every message when it is sent.
//
// An A/B test sends the two variants to a share of the audience (half each), waits, and sends the variant with more
// opens (or clicks) to the rest.
import { CHANNELS, type Channel } from "./config.ts";
import { addressOf, all, hashAddress, iso, newId, one, parseJson, run, slugify, tx, type Actor, type Core, type Person } from "./core.ts";
import { bad, conflict, isObj, MsgError, notFound } from "./errors.ts";
import { audienceMembers, audienceSegments, consentCheck, LinkError } from "./links.ts";
import { consentChannel, type People } from "./people.ts";
import type { Lists, Templates } from "./templates.ts";

export interface AbTest {
  /** Variant B: another template, or the same one with another subject. */
  templateId: string | null;
  subject: string | null;
  /** The share of the audience in the test, 2 to 50 percent; half get A, half B. */
  share: number;
  metric: "opened" | "clicked";
  waitHours: number;
  testEndsAt: string | null;
  winner: "a" | "b" | null;
  decidedAt: string | null;
}

interface CampaignRow {
  id: string;
  name: string;
  slug: string;
  channel: Channel;
  audience_kind: "segment" | "list";
  audience_id: string;
  audience_name: string;
  template_id: string;
  ab: string | null;
  state: "draft" | "scheduled" | "sending" | "paused" | "sent";
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  cursor: string | null;
  read_done: number;
  audience_size: number;
  no_address: number;
  problem: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const STATES = ["waiting", "queued", "sending", "sent", "delivered", "held", "suppressed", "failed", "bounced", "unknown", "cancelled"] as const;

export function createCampaigns(core: Core, people: People, templates: Templates, lists: Lists) {
  const { db } = core;
  const now = () => iso(core.clock());
  /** When reading Audience failed, not before this. In memory: a restart simply tries at once. */
  const retryAt = new Map<string, number>();

  function counts(id: string) {
    const by = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<(typeof STATES)[number], number>;
    for (const r of all<{ state: (typeof STATES)[number]; n: number }>(
      db,
      "SELECT state, COUNT(*) AS n FROM messages WHERE campaign_id = ? GROUP BY state",
      id,
    ))
      by[r.state] = r.n;
    const t = one<{ opened: number; clicked: number; unsubscribed: number; bounced: number; delivered: number }>(
      db,
      `SELECT COUNT(opened_at) AS opened, COUNT(clicked_at) AS clicked, COUNT(unsubscribed_at) AS unsubscribed, COUNT(bounced_at) AS bounced, COUNT(delivered_at) AS delivered
         FROM messages WHERE campaign_id = ?`,
      id,
    )!;
    const sent = by.sent + by.delivered + by.bounced;
    return {
      messages: STATES.reduce((a, s) => a + by[s], 0),
      waiting: by.waiting,
      queued: by.queued + by.sending,
      held: by.held,
      suppressed: by.suppressed,
      sent,
      delivered: t.delivered,
      opened: t.opened,
      clicked: t.clicked,
      bounced: t.bounced,
      unsubscribed: t.unsubscribed,
      failed: by.failed,
      unknown: by.unknown,
      cancelled: by.cancelled,
    };
  }

  function variants(id: string, ab: AbTest) {
    const r = all<{ variant: string; sent: number; opened: number; clicked: number }>(
      db,
      `SELECT variant, COUNT(sent_at) AS sent, COUNT(opened_at) AS opened, COUNT(clicked_at) AS clicked
         FROM messages WHERE campaign_id = ? AND variant IN ('a', 'b') GROUP BY variant`,
      id,
    );
    const of = (v: "a" | "b") => {
      const x = r.find((y) => y.variant === v) ?? { sent: 0, opened: 0, clicked: 0 };
      const n = ab.metric === "opened" ? x.opened : x.clicked;
      return { sent: x.sent, opened: x.opened, clicked: x.clicked, rate: x.sent ? Math.round((n / x.sent) * 1000) / 10 : null };
    };
    return { a: of("a"), b: of("b") };
  }

  function view(r: CampaignRow) {
    const ab = parseJson<AbTest | null>(r.ab, null);
    const t = templates.row(r.template_id);
    const tb = ab?.templateId ? templates.row(ab.templateId) : null;
    const since = r.scheduled_at ?? r.created_at;
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      channel: r.channel,
      audience: { kind: r.audience_kind, id: r.audience_id, name: r.audience_name },
      template: { id: r.template_id, name: t?.name ?? "(deleted)", subject: t?.subject ?? null },
      ab: ab && {
        ...ab,
        templateName: tb?.name ?? null,
        a: t?.subject ?? t?.name ?? "A",
        b: ab.subject ?? tb?.subject ?? tb?.name ?? "B",
        results: variants(r.id, ab),
      },
      state: r.state,
      scheduledAt: r.scheduled_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      reading: r.state === "sending" && !r.read_done,
      audienceSize: r.audience_size,
      noAddress: r.no_address,
      problem: r.problem,
      counts: counts(r.id),
      // Opt-outs on this channel since it was scheduled: people left out already, whatever the estimate said.
      optOutsSince: one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM optouts WHERE channel = ? AND at >= ?", r.channel, since)!.n,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  function get(id: string) {
    const r = one<CampaignRow>(db, "SELECT * FROM campaigns WHERE id = ?", id);
    if (!r) throw notFound("The campaign");
    return r;
  }

  async function audienceName(kind: string, id: string, given: unknown): Promise<string> {
    if (kind === "list") {
      const l = lists.name(id);
      if (!l) throw bad("audience.id is not one of the imported lists.");
      return l.name;
    }
    if (typeof given === "string" && given.trim()) return given.trim().slice(0, 120);
    try {
      const s = (await audienceSegments(core.links.client("audience"))).find((x) => x.id === id);
      if (!s) throw bad("audience.id is not a segment in Audience.");
      return s.name;
    } catch (err) {
      if (err instanceof LinkError) throw new MsgError(err.permanent ? 409 : 502, err.permanent ? "not-configured" : "upstream-error", err.message);
      throw err;
    }
  }

  function readAb(raw: unknown, channel: Channel): AbTest | null {
    if (raw === undefined || raw === null) return null;
    if (!isObj(raw)) throw bad("ab is { subject or templateId, share, metric, waitHours }.");
    const subject = raw.subject === undefined || raw.subject === null ? null : raw.subject;
    if (subject !== null && (typeof subject !== "string" || !subject.trim() || subject.length > 200))
      throw bad("ab.subject is variant B's subject, up to 200 characters.");
    if (subject !== null && channel !== "email") throw bad("Only emails have a subject to test; give ab.templateId for another text.");
    const templateId = raw.templateId === undefined || raw.templateId === null ? null : String(raw.templateId);
    if (templateId) {
      const t = templates.row(templateId);
      if (!t || t.channel !== channel) throw bad(`ab.templateId is a ${channel} template.`);
    }
    if (!subject && !templateId) throw bad("ab needs a subject or a templateId for variant B.");
    const share = raw.share ?? 20;
    if (!Number.isInteger(share) || (share as number) < 2 || (share as number) > 50) throw bad("ab.share is 2 to 50 (percent of the audience in the test).");
    const metric = raw.metric ?? (channel === "sms" ? "clicked" : "opened");
    if (metric !== "opened" && metric !== "clicked") throw bad("ab.metric is opened or clicked.");
    if (metric === "opened" && channel === "sms") throw bad("SMS opens are not measured; use ab.metric: clicked.");
    const waitHours = raw.waitHours ?? 4;
    if (typeof waitHours !== "number" || !(waitHours >= 0.25 && waitHours <= 168)) throw bad("ab.waitHours is 0.25 to 168.");
    return { templateId, subject: subject?.trim() ?? null, share: share as number, metric, waitHours, testEndsAt: null, winner: null, decidedAt: null };
  }

  function uniqueSlug(name: string, except?: string) {
    const base = slugify(name);
    let slug = base;
    for (
      let i = 2;
      one(db, "SELECT 1 FROM campaigns WHERE slug = ? AND id <> ?", slug, except ?? "") || one(db, "SELECT 1 FROM journeys WHERE slug = ?", slug);
      i++
    )
      slug = `${base}-${i}`;
    return slug;
  }

  async function create(who: Actor, raw: unknown) {
    if (!isObj(raw)) throw bad("The body is a campaign: name, channel, audience, templateId and ab.");
    if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 120) throw bad("name is 1 to 120 characters.");
    if (!CHANNELS.includes(raw.channel as Channel)) throw bad("channel is email, sms or whatsapp.");
    const channel = raw.channel as Channel;
    const a = raw.audience;
    if (!isObj(a) || (a.kind !== "segment" && a.kind !== "list") || typeof a.id !== "string" || !a.id) throw bad("audience is { kind: segment or list, id }.");
    const t = typeof raw.templateId === "string" ? templates.row(raw.templateId) : null;
    if (!t || t.channel !== channel) throw bad(`templateId is a ${channel} template.`);
    const ab = readAb(raw.ab, channel);
    const name = await audienceName(a.kind, a.id, a.name);
    const id = newId(9);
    run(
      db,
      `INSERT INTO campaigns (id, name, slug, channel, audience_kind, audience_id, audience_name, template_id, ab, state, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      id,
      raw.name.trim(),
      uniqueSlug(raw.name),
      channel,
      a.kind,
      a.id,
      name,
      t.id,
      ab && JSON.stringify(ab),
      who.name,
      now(),
      now(),
    );
    return view(get(id));
  }

  async function update(id: string, raw: unknown) {
    const c = get(id);
    if (c.started_at) throw conflict("A campaign that has started sending cannot be changed; pause it, or make a new one.");
    if (!isObj(raw)) throw bad("The body has the fields to change: name, audience, templateId and ab.");
    const name = raw.name === undefined ? c.name : raw.name;
    if (typeof name !== "string" || !name.trim() || name.length > 120) throw bad("name is 1 to 120 characters.");
    let { audience_kind: kind, audience_id: aid, audience_name: aname } = c;
    if (raw.audience !== undefined) {
      const a = raw.audience;
      if (!isObj(a) || (a.kind !== "segment" && a.kind !== "list") || typeof a.id !== "string" || !a.id)
        throw bad("audience is { kind: segment or list, id }.");
      kind = a.kind;
      aid = a.id;
      aname = await audienceName(a.kind, a.id, a.name);
    }
    const tid = raw.templateId === undefined ? c.template_id : String(raw.templateId);
    const t = templates.row(tid);
    if (!t || t.channel !== c.channel) throw bad(`templateId is a ${c.channel} template.`);
    const ab = raw.ab === undefined ? parseJson<AbTest | null>(c.ab, null) : readAb(raw.ab, c.channel);
    run(
      db,
      "UPDATE campaigns SET name = ?, slug = ?, audience_kind = ?, audience_id = ?, audience_name = ?, template_id = ?, ab = ?, updated_at = ? WHERE id = ?",
      name.trim(),
      name.trim() === c.name ? c.slug : uniqueSlug(name, id),
      kind,
      aid,
      aname,
      tid,
      ab && JSON.stringify(ab),
      now(),
      id,
    );
    return view(get(id));
  }

  function schedule(id: string, raw: unknown) {
    const c = get(id);
    if (c.state !== "draft" && c.state !== "paused") throw conflict(`The campaign is ${c.state}; only a draft or a paused one is scheduled.`);
    const at = isObj(raw) && raw.at !== undefined && raw.at !== null ? raw.at : now();
    const ms = typeof at === "string" ? Date.parse(at) : NaN;
    if (!Number.isFinite(ms)) throw bad("at is a date and time, such as 2026-11-09T07:00:00Z; now by default.");
    if (ms > core.clock() + 366 * 86_400_000) throw bad("at is within a year.");
    run(
      db,
      "UPDATE campaigns SET state = 'scheduled', scheduled_at = ?, problem = NULL, updated_at = ? WHERE id = ?",
      iso(Math.max(ms, core.clock())),
      now(),
      id,
    );
    return view(get(id));
  }

  /** Nothing more is sent: the messages not yet sent wait until it is scheduled again. */
  function pause(id: string) {
    const c = get(id);
    if (c.state !== "scheduled" && c.state !== "sending") throw conflict(`The campaign is ${c.state}; only a scheduled or sending one is paused.`);
    run(db, "UPDATE campaigns SET state = 'paused', updated_at = ? WHERE id = ?", now(), id);
    return view(get(id));
  }

  function remove(id: string) {
    const c = get(id);
    if (c.started_at) throw conflict("A campaign that has sent messages is kept with its results.");
    run(db, "DELETE FROM campaigns WHERE id = ?", id);
  }

  // ---------------------------------------------------------------- Sending a campaign

  const bucketOf = (hash: string) => parseInt(hash.slice(0, 8), 16) % 100;

  function insertPeople(c: CampaignRow, ab: AbTest | null, list: Person[], cursor: string | null, done: boolean) {
    tx(db, () => {
      const ins = db.prepare(
        `INSERT OR IGNORE INTO messages (id, dedupe, campaign_id, variant, channel, address, person, template_id, utm_campaign, state, next_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let noAddress = 0;
      for (const p of list) {
        const address = addressOf(p, c.channel);
        if (!address) {
          noAddress++;
          continue;
        }
        const hash = hashAddress(c.channel, address);
        let variant: string | null = null;
        let state = "queued";
        if (ab && !ab.winner) {
          const b = bucketOf(hash);
          if (b < ab.share) variant = b % 2 ? "b" : "a";
          else state = "waiting";
        } else if (ab?.winner) variant = ab.winner;
        const tid = variant === "b" && ab?.templateId ? ab.templateId : c.template_id;
        ins.run(newId(), `c:${c.id}:${hash}`, c.id, variant, c.channel, address, JSON.stringify(p), tid, c.slug, state, now(), now());
      }
      run(
        db,
        "UPDATE campaigns SET cursor = ?, read_done = ?, audience_size = audience_size + ?, no_address = no_address + ?, updated_at = ? WHERE id = ?",
        cursor,
        done ? 1 : 0,
        list.length,
        noAddress,
        now(),
        c.id,
      );
      if (done && ab && !ab.testEndsAt)
        run(db, "UPDATE campaigns SET ab = ? WHERE id = ?", JSON.stringify({ ...ab, testEndsAt: iso(core.clock() + ab.waitHours * 3_600_000) }), c.id);
    });
  }

  /** Reads the next page of a sending campaign's audience. */
  async function readPage(c: CampaignRow) {
    const ab = parseJson<AbTest | null>(c.ab, null);
    if (c.audience_kind === "list") {
      const after = Number(c.cursor ?? 0);
      const rows = all<{ n: number; email: string | null; phone: string | null; user_id: string | null; name: string | null; fields: string }>(
        db,
        "SELECT n, email, phone, user_id, name, fields FROM list_members WHERE list_id = ? AND n > ? ORDER BY n LIMIT 1000",
        c.audience_id,
        after,
      );
      const list = rows.map((r) => ({ profile: null, userId: r.user_id, email: r.email, phone: r.phone, name: r.name, fields: parseJson(r.fields, {}) }));
      insertPeople(c, ab, list, String(rows.at(-1)?.n ?? after), rows.length < 1000);
      return;
    }
    if ((retryAt.get(c.id) ?? 0) > core.clock()) return;
    try {
      const page = await audienceMembers(core.links.client("audience"), c.audience_id, c.cursor);
      if (!page) {
        run(db, "UPDATE campaigns SET state = 'paused', problem = ?, updated_at = ? WHERE id = ?", "The segment is no longer in Audience.", now(), c.id);
        return;
      }
      const list: Person[] = page.members.map((m) => ({ profile: m.id, userId: m.userId, email: m.email, phone: m.phone, name: m.name, fields: m.traits }));
      insertPeople(c, ab, list, page.nextCursor ?? c.cursor, !page.nextCursor);
      retryAt.delete(c.id);
    } catch (err) {
      if (!(err instanceof LinkError)) throw err;
      retryAt.set(c.id, core.clock() + 30_000);
      run(db, "UPDATE campaigns SET problem = ? WHERE id = ?", `Reading the segment: ${err.message}`, c.id);
      core.log("warn", "campaign could not read its segment; tried again in 30 seconds", { campaign: c.id, error: err.message });
    }
  }

  /** The test is over: the variant with the higher rate goes to the rest. */
  function decide(c: CampaignRow, ab: AbTest) {
    const v = variants(c.id, ab);
    const winner: "a" | "b" = (v.b.rate ?? -1) > (v.a.rate ?? -1) ? "b" : "a";
    const tid = winner === "b" && ab.templateId ? ab.templateId : c.template_id;
    tx(db, () => {
      run(db, "UPDATE campaigns SET ab = ?, updated_at = ? WHERE id = ?", JSON.stringify({ ...ab, winner, decidedAt: now() }), now(), c.id);
      run(
        db,
        "UPDATE messages SET state = 'queued', variant = ?, template_id = ?, next_at = ? WHERE campaign_id = ? AND state = 'waiting'",
        winner,
        tid,
        now(),
        c.id,
      );
    });
    core.log("info", "A/B test decided", { campaign: c.id, winner, a: v.a.rate, b: v.b.rate });
  }

  /** Moves every campaign along: starts what is due, reads audiences, decides tests, finishes what is done. */
  async function tick() {
    if (!core.hasConfig()) return;
    run(
      db,
      "UPDATE campaigns SET state = 'sending', started_at = COALESCE(started_at, ?), updated_at = ? WHERE state = 'scheduled' AND scheduled_at <= ?",
      now(),
      now(),
      now(),
    );
    for (const c of all<CampaignRow>(db, "SELECT * FROM campaigns WHERE state = 'sending'")) {
      if (!c.read_done) {
        await readPage(c);
        continue;
      }
      const ab = parseJson<AbTest | null>(c.ab, null);
      if (ab && !ab.winner) {
        if (ab.testEndsAt && Date.parse(ab.testEndsAt) <= core.clock()) decide(c, ab);
        continue;
      }
      const left = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM messages WHERE campaign_id = ? AND state IN ('waiting', 'queued', 'sending')", c.id)!.n;
      if (!left) run(db, "UPDATE campaigns SET state = 'sent', finished_at = ?, problem = NULL, updated_at = ? WHERE id = ?", now(), now(), c.id);
    }
  }

  /**
   * How many of an audience may get a message on a channel today: read (up to 5,000 people), checked against the
   * opt-out list, bounces and Consent. Only an estimate: consent is asked again for each message when it is sent.
   */
  async function estimate(raw: unknown) {
    if (!isObj(raw) || !CHANNELS.includes(raw.channel as Channel) || !isObj(raw.audience)) throw bad("The body is { channel, audience: { kind, id } }.");
    const channel = raw.channel as Channel;
    const a = raw.audience;
    const found: Person[] = [];
    let size: number | null = null;
    if (a.kind === "list") {
      const l = lists.name(String(a.id));
      if (!l) throw bad("audience.id is not one of the imported lists.");
      size = l.size;
      found.push(
        ...all<{ email: string | null; phone: string | null; user_id: string | null; name: string | null }>(
          db,
          "SELECT email, phone, user_id, name FROM list_members WHERE list_id = ? ORDER BY n LIMIT 5000",
          String(a.id),
        ).map((r) => ({ profile: null, userId: r.user_id, email: r.email, phone: r.phone, name: r.name, fields: {} })),
      );
    } else if (a.kind === "segment") {
      try {
        const c = core.links.client("audience");
        let cursor: string | null = null;
        for (let i = 0; i < 5; i++) {
          const page: Awaited<ReturnType<typeof audienceMembers>> = await audienceMembers(c, String(a.id), cursor);
          if (!page) throw bad("audience.id is not a segment in Audience.");
          found.push(...page.members.map((m) => ({ profile: m.id, userId: m.userId, email: m.email, phone: m.phone, name: m.name, fields: {} })));
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        if (cursor && found.length >= 5000) size = (await audienceSegments(c)).find((s) => s.id === a.id)?.size ?? null;
        else size = found.length;
      } catch (err) {
        if (err instanceof LinkError) throw new MsgError(err.permanent ? 409 : 502, err.permanent ? "not-configured" : "upstream-error", err.message);
        throw err;
      }
    } else throw bad("audience.kind is segment or list.");
    const addresses = [...new Set(found.map((p) => addressOf(p, channel)).filter(Boolean) as string[])];
    const open = addresses.filter((x) => !people.suppressed(channel, x));
    let allowed = open.length;
    const cfg = core.config();
    if (cfg.consent.check === "consent" && open.length) {
      try {
        const r = await consentCheck(
          core.links.client("consent"),
          cfg.consent.purpose,
          consentChannel(core, channel),
          open.map((x) => (channel === "email" ? { email: x } : { phone: x })),
        );
        allowed = r.filter((x) => x.allowed).length;
      } catch (err) {
        if (err instanceof LinkError) throw new MsgError(err.permanent ? 409 : 502, err.permanent ? "not-configured" : "upstream-error", err.message);
        throw err;
      }
    }
    return { size: size ?? found.length, counted: found.length, withAddress: addresses.length, suppressed: addresses.length - open.length, allowed };
  }

  /** The messages of a campaign in one state, for a closer look at unknown, failed or held ones. */
  function messages(id: string, state: string | null) {
    get(id);
    if (state && !(STATES as readonly string[]).includes(state)) throw bad(`state is one of ${STATES.join(", ")}.`);
    return all<{ id: string; address: string; state: string; reason: string | null; variant: string | null; sent_at: string | null; person: string }>(
      db,
      `SELECT id, address, state, reason, variant, sent_at, person FROM messages WHERE campaign_id = ? ${state ? "AND state = ?" : ""} ORDER BY created_at LIMIT 200`,
      ...(state ? [id, state] : [id]),
    ).map((m) => ({
      id: m.id,
      address: m.address,
      name: parseJson<Person>(m.person, {} as Person).name ?? null,
      state: m.state,
      reason: m.reason,
      variant: m.variant,
      sentAt: m.sent_at,
    }));
  }

  return {
    list: () => all<CampaignRow>(db, "SELECT * FROM campaigns ORDER BY COALESCE(scheduled_at, created_at) DESC").map(view),
    get: (id: string) => view(get(id)),
    create,
    update,
    schedule,
    pause,
    remove,
    tick,
    estimate,
    messages,
  };
}

export type Campaigns = ReturnType<typeof createCampaigns>;
