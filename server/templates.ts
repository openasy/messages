// Templates, made in the UI, and the imported lists. A WhatsApp template stands for one Meta approved; its approval
// is read from Meta (Sync) and from the webhook, and one that is not approved is not sent.
import { CHANNELS, type Channel } from "./config.ts";
import { all, iso, newId, one, parseJson, readPerson, run, tx, type Actor, type Core, type Person } from "./core.ts";
import { parseCsv } from "./csv.ts";
import { bad, conflict, isObj, MsgError, notFound } from "./errors.ts";
import { renderEmail, renderSms, renderWhatsApp, type Template } from "./render.ts";
import type { WhatsAppSender } from "./providers.ts";

interface TemplateRow {
  id: string;
  name: string;
  channel: Channel;
  lang: string;
  subject: string | null;
  body: string;
  format: "text" | "html";
  wa_name: string | null;
  wa_params: string;
  approval: string | null;
  approval_at: string | null;
  created_at: string;
  updated_at: string;
}

export const toTemplate = (r: TemplateRow): Template => ({
  id: r.id,
  name: r.name,
  channel: r.channel,
  lang: r.lang,
  subject: r.subject,
  body: r.body,
  format: r.format,
  waName: r.wa_name,
  waParams: parseJson<string[]>(r.wa_params, []),
});

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LANG = /^[a-z]{2,3}(_[A-Z]{2})?$/;

export function createTemplates(core: Core) {
  const { db } = core;
  const now = () => iso(core.clock());

  function usedBy(id: string): string[] {
    const c = all<{ name: string }>(db, "SELECT name FROM campaigns WHERE template_id = ? OR json_extract(ab, '$.templateId') = ?", id, id).map((r) => r.name);
    const j = all<{ name: string; steps: string }>(db, "SELECT name, steps FROM journeys")
      .filter((r) => parseJson<Array<{ templateId?: string }>>(r.steps, []).some((s) => s.templateId === id))
      .map((r) => r.name);
    return [...new Set([...c, ...j])];
  }

  const view = (r: TemplateRow) => ({
    ...toTemplate(r),
    approval: r.approval,
    approvalAt: r.approval_at,
    usedBy: usedBy(r.id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  function get(id: string): TemplateRow {
    const r = one<TemplateRow>(db, "SELECT * FROM templates WHERE id = ?", id);
    if (!r) throw notFound("The template");
    return r;
  }

  function read(raw: unknown, before?: TemplateRow) {
    if (!isObj(raw)) throw bad("The body is a template: name, channel, lang, subject, body, format, waName and waParams.");
    const v = {
      ...(before && {
        name: before.name,
        channel: before.channel,
        lang: before.lang,
        subject: before.subject,
        body: before.body,
        format: before.format,
        waName: before.wa_name,
        waParams: parseJson<string[]>(before.wa_params, []),
      }),
      ...raw,
    } as Record<string, unknown>;
    if (typeof v.name !== "string" || !NAME.test(v.name)) throw bad("name is up to 64 lowercase letters, digits, _ and -, such as welcome-tr.");
    if (!CHANNELS.includes(v.channel as Channel)) throw bad("channel is email, sms or whatsapp.");
    if (before && v.channel !== before.channel) throw bad("A template's channel cannot change; make a new one.");
    const lang = v.lang ?? "tr";
    if (typeof lang !== "string" || !LANG.test(lang)) throw bad("lang is a language code such as tr, en or en_US.");
    const channel = v.channel as Channel;
    const body = v.body ?? "";
    if (typeof body !== "string" || body.length > 100_000 || (channel !== "whatsapp" && !body.trim()))
      throw bad("body is the message's text, up to 100,000 characters.");
    if (channel === "sms" && body.length > 1000) throw bad("An SMS body is at most 1,000 characters (about six SMS).");
    let subject: string | null = null;
    if (channel === "email") {
      if (typeof v.subject !== "string" || !v.subject.trim() || v.subject.length > 200) throw bad("An email template needs a subject of up to 200 characters.");
      subject = v.subject.trim();
    }
    const format = v.format ?? "text";
    if (format !== "text" && format !== "html") throw bad("format is text or html.");
    if (channel !== "email" && format !== "text") throw bad("Only email templates may be HTML.");
    let waName: string | null = null;
    let waParams: string[] = [];
    if (channel === "whatsapp") {
      waName = (v.waName ?? v.name) as string;
      if (typeof waName !== "string" || !/^[a-z0-9_]{1,512}$/.test(waName))
        throw bad("waName is the template's name at Meta: lowercase letters, digits and _.");
      const params = v.waParams ?? [];
      if (!Array.isArray(params) || params.length > 20 || params.some((p) => typeof p !== "string" || p.length > 200))
        throw bad("waParams is a list of up to 20 texts for {{1}}, {{2}}..., such as {{first_name}}.");
      waParams = params as string[];
    }
    return { name: v.name, channel, lang, subject, body: body as string, format: format as "text" | "html", waName, waParams };
  }

  function create(raw: unknown) {
    const t = read(raw);
    if (one(db, "SELECT 1 FROM templates WHERE name = ?", t.name)) throw conflict(`A template is already called ${t.name}.`);
    const id = newId(9);
    run(
      db,
      "INSERT INTO templates (id, name, channel, lang, subject, body, format, wa_name, wa_params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      t.name,
      t.channel,
      t.lang,
      t.subject,
      t.body,
      t.format,
      t.waName,
      JSON.stringify(t.waParams),
      now(),
      now(),
    );
    return view(get(id));
  }

  function update(id: string, raw: unknown) {
    const before = get(id);
    const t = read(raw, before);
    if (t.name !== before.name && one(db, "SELECT 1 FROM templates WHERE name = ? AND id <> ?", t.name, id))
      throw conflict(`A template is already called ${t.name}.`);
    // A new name or language at Meta is a different template there; its approval is asked again.
    const sameAtMeta = t.waName === before.wa_name && t.lang === before.lang;
    run(
      db,
      "UPDATE templates SET name = ?, lang = ?, subject = ?, body = ?, format = ?, wa_name = ?, wa_params = ?, approval = ?, approval_at = ?, updated_at = ? WHERE id = ?",
      t.name,
      t.lang,
      t.subject,
      t.body,
      t.format,
      t.waName,
      JSON.stringify(t.waParams),
      sameAtMeta ? before.approval : null,
      sameAtMeta ? before.approval_at : null,
      now(),
      id,
    );
    return view(get(id));
  }

  function remove(id: string) {
    get(id);
    const used = usedBy(id);
    if (used.length) throw conflict(`The template is used by ${used.join(", ")}.`);
    run(db, "DELETE FROM templates WHERE id = ?", id);
  }

  /** People to preview a template as: those who got messages on its channel lately, else list members, else a sample. */
  function samplePeople(channel: Channel): Person[] {
    const recent = all<{ person: string }>(db, "SELECT person FROM messages WHERE channel = ? AND person <> '{}' ORDER BY created_at DESC LIMIT 50", channel)
      .map((r) => parseJson<Person>(r.person, null as unknown as Person))
      .filter(Boolean);
    const fromLists = all<{ email: string | null; phone: string | null; user_id: string | null; name: string | null; fields: string }>(
      db,
      "SELECT email, phone, user_id, name, fields FROM list_members ORDER BY n DESC LIMIT 20",
    ).map((r) => ({ profile: null, userId: r.user_id, email: r.email, phone: r.phone, name: r.name, fields: parseJson(r.fields, {}) }));
    const seen = new Set<string>();
    const out: Person[] = [];
    for (const p of [...recent, ...fromLists]) {
      const k = `${p.name}|${p.email}|${p.phone}`;
      if (seen.has(k) || !p.name) continue;
      seen.add(k);
      out.push(p);
      if (out.length >= 5) break;
    }
    if (!out.length)
      out.push({ profile: null, userId: null, email: "ayse@example.com", phone: "+905551112233", name: "Ayşe Yılmaz", fields: { company: "Yılmaz Gıda" } });
    return out;
  }

  /** The template as it reaches a person: the first sample, or the one at `as`. Nothing is tracked. */
  function preview(id: string, raw: unknown) {
    const t = toTemplate(get(id));
    const people = samplePeople(t.channel);
    const at = isObj(raw) && Number.isInteger(raw.as) ? Math.min(Math.max(0, raw.as as number), people.length - 1) : 0;
    const p = people[at]!;
    const ctx = { config: core.config(), publicUrl: core.publicUrl, messageId: null, utmCampaign: "preview", variant: null };
    const shown = { as: at, people: people.map((x, i) => ({ index: i, name: x.name ?? `#${i + 1}` })) };
    if (t.channel === "email") {
      const e = renderEmail(t, p, ctx);
      const s = core.config().sender;
      return { ...shown, from: s.email ? `${s.name} <${s.email}>` : s.name, subject: e.subject, text: e.text, html: e.html };
    }
    if (t.channel === "sms") {
      const sms = core.config().providers.sms;
      return { ...shown, from: sms?.sender ?? null, subject: null, text: renderSms(t, p, ctx, sms?.stop ?? "STOP").text, html: null };
    }
    return { ...shown, from: null, subject: null, text: renderWhatsApp(t, p, ctx).text, html: null };
  }

  /** Reads the WhatsApp templates and their approval from Meta: known ones are updated, approved new ones added. */
  async function syncWhatsApp(sender: WhatsAppSender | null) {
    if (!sender) throw new MsgError(409, "not-configured", "providers.whatsapp is not set in messages.yaml.");
    let list;
    try {
      list = await sender.templates();
    } catch (err) {
      throw new MsgError(502, "upstream-error", (err as Error).message);
    }
    let updated = 0;
    let added = 0;
    tx(db, () => {
      for (const t of list) {
        const mine = one<TemplateRow>(db, "SELECT * FROM templates WHERE channel = 'whatsapp' AND wa_name = ? AND lang = ?", t.name, t.language);
        if (mine) {
          run(
            db,
            "UPDATE templates SET approval = ?, approval_at = ?, body = CASE WHEN ? IS NOT NULL THEN ? ELSE body END WHERE id = ?",
            t.status,
            now(),
            t.body,
            t.body,
            mine.id,
          );
          updated++;
        } else if (t.status === "APPROVED" && t.category !== "AUTHENTICATION") {
          let name = t.name.replace(/[^a-z0-9_-]/g, "").slice(0, 64) || "whatsapp";
          if (one(db, "SELECT 1 FROM templates WHERE name = ?", name))
            name = `${name}-${t.language}`
              .toLowerCase()
              .replace(/[^a-z0-9_-]/g, "")
              .slice(0, 64);
          if (one(db, "SELECT 1 FROM templates WHERE name = ?", name)) continue;
          const n = new Set([...(t.body ?? "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
          run(
            db,
            "INSERT INTO templates (id, name, channel, lang, body, format, wa_name, wa_params, approval, approval_at, created_at, updated_at) VALUES (?, ?, 'whatsapp', ?, ?, 'text', ?, ?, ?, ?, ?, ?)",
            newId(9),
            name,
            t.language,
            t.body ?? "",
            t.name,
            JSON.stringify(Array.from({ length: n }, () => "")),
            t.status,
            now(),
            now(),
            now(),
          );
          added++;
        }
      }
    });
    return { updated, added };
  }

  /** A template's approval, from the WhatsApp webhook. */
  function approval(name: string, language: string, status: string) {
    run(
      db,
      "UPDATE templates SET approval = ?, approval_at = ? WHERE channel = 'whatsapp' AND wa_name = ? AND (lang = ? OR ? = '')",
      status,
      now(),
      name,
      language,
      language,
    );
  }

  return {
    list: () => all<TemplateRow>(db, "SELECT * FROM templates ORDER BY name").map(view),
    get: (id: string) => view(get(id)),
    row: (id: string) => one<TemplateRow>(db, "SELECT * FROM templates WHERE id = ?", id) ?? null,
    create,
    update,
    remove,
    preview,
    syncWhatsApp,
    approval,
  };
}

export type Templates = ReturnType<typeof createTemplates>;

// ---------------------------------------------------------------- Lists

export function createLists(core: Core) {
  const { db } = core;
  const view = (r: { id: string; name: string; size: number; created_at: string; created_by: string }) => {
    const c = one<{ email: number; phone: number }>(db, "SELECT COUNT(email) AS email, COUNT(phone) AS phone FROM list_members WHERE list_id = ?", r.id)!;
    const usedBy = all<{ name: string }>(db, "SELECT name FROM campaigns WHERE audience_kind = 'list' AND audience_id = ?", r.id).map((x) => x.name);
    return { id: r.id, name: r.name, size: r.size, withEmail: c.email, withPhone: c.phone, usedBy, createdAt: r.created_at, createdBy: r.created_by };
  };

  /** A CSV of people: email, phone, name (or first_name and last_name) and user_id; every other column is a field. */
  function importCsv(who: Actor, raw: unknown) {
    if (!isObj(raw) || typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 120 || typeof raw.csv !== "string")
      throw bad("The body is { name, csv }: the list's name and the file's text.");
    const listName = raw.name.trim();
    const rows = parseCsv(raw.csv);
    if (rows.length < 2) throw bad("The file needs a header line and at least one person.");
    if (rows.length > 200_001) throw bad("A list holds up to 200,000 people.");
    const header = rows[0]!.map((h) =>
      h
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_"),
    );
    const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
    const ix = {
      email: col("email", "e_mail", "e_posta", "eposta"),
      phone: col("phone", "telefon", "gsm", "mobile"),
      name: col("name", "ad_soyad", "full_name"),
      first: col("first_name", "ad"),
      last: col("last_name", "soyad"),
      user: col("user_id", "userid", "id"),
    };
    if (ix.email < 0 && ix.phone < 0) throw bad("The header needs an email or a phone column.");
    const fieldCols = header.map((h, i) => ({ h, i })).filter(({ h, i }) => !Object.values(ix).includes(i) && /^[a-z][a-z0-9_]{0,63}$/.test(h));
    const country = core.config().limits.phoneCountry;
    const id = newId(9);
    let size = 0;
    let skipped = 0;
    tx(db, () => {
      run(db, "INSERT INTO lists (id, name, created_at, created_by) VALUES (?, ?, ?, ?)", id, listName, iso(core.clock()), who.name);
      const ins = db.prepare("INSERT INTO list_members (list_id, n, email, phone, user_id, name, fields) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const r of rows.slice(1)) {
        const at = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
        const name = at(ix.name) || [at(ix.first), at(ix.last)].filter(Boolean).join(" ");
        const p = readPerson(
          {
            email: at(ix.email),
            phone: at(ix.phone),
            userId: at(ix.user) || undefined,
            name,
            fields: Object.fromEntries(fieldCols.map(({ h, i }) => [h, at(i)]).filter(([, v]) => v)),
          },
          country,
        );
        if (!p.email && !p.phone) {
          skipped++;
          continue;
        }
        ins.run(id, ++size, p.email, p.phone, p.userId, p.name, JSON.stringify(p.fields));
      }
      run(db, "UPDATE lists SET size = ? WHERE id = ?", size, id);
    });
    return { ...view(one(db, "SELECT * FROM lists WHERE id = ?", id)!), skipped };
  }

  function remove(id: string) {
    if (!one(db, "SELECT 1 FROM lists WHERE id = ?", id)) throw notFound("The list");
    const used = all<{ name: string }>(db, "SELECT name FROM campaigns WHERE audience_kind = 'list' AND audience_id = ? AND state <> 'sent'", id);
    if (used.length) throw conflict(`The list is the audience of ${used.map((u) => u.name).join(", ")}.`);
    run(db, "DELETE FROM lists WHERE id = ?", id);
  }

  return {
    list: () =>
      all<{ id: string; name: string; size: number; created_at: string; created_by: string }>(db, "SELECT * FROM lists ORDER BY created_at DESC").map(view),
    importCsv,
    remove,
    name: (id: string) => one<{ name: string; size: number }>(db, "SELECT name, size FROM lists WHERE id = ?", id) ?? null,
  };
}

export type Lists = ReturnType<typeof createLists>;
