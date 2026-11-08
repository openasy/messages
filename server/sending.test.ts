import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { one } from "./core.ts";
import { createMessages } from "./messages.ts";
import { openDb } from "./db.ts";
import { ENV, fakeClock, settingsFor, startApp, startFakes, type Fakes } from "./test-app.ts";

let fakes: Fakes;
beforeAll(async () => {
  fakes = await startFakes();
});
afterAll(() => fakes.close());
beforeEach(() => {
  fakes.ses.sent.length = 0;
  fakes.smtp.received.length = 0;
  fakes.netgsm.sent.length = 0;
  fakes.whatsapp.sent.length = 0;
  fakes.consent.answers.clear();
  fakes.consent.recorded.length = 0;
  fakes.consent.checks.length = 0;
  fakes.audience.events.length = 0;
});

const CSV =
  "email,phone,name,company\nokan@example.com,0532 111 22 33,Okan Tekin,Tekin Yapı\ngizem@example.com,0533 222 33 44,Gizem Avcı,Avcı Lojistik\nayse@example.com,,Ayşe Yılmaz,\n";

async function setup(app: Awaited<ReturnType<typeof startApp>>, channel: "email" | "sms" = "email", csv = CSV) {
  const t = await app.api("POST", "/api/v1/templates", {
    name: `t-${channel}-${Math.random().toString(36).slice(2, 8)}`,
    channel,
    lang: "tr",
    subject: "Hoş geldiniz, {{first_name}}",
    body: "Merhaba {{first_name}}, {{company|şirketiniz}} için hesabınız hazır: https://www.example.com/start?x=1",
  });
  expect(t.status).toBe(201);
  const l = await app.api("POST", "/api/v1/lists", { name: "Webinar", csv });
  expect(l.status).toBe(201);
  const c = await app.api("POST", "/api/v1/campaigns", {
    name: "October newsletter",
    channel,
    audience: { kind: "list", id: l.body.id },
    templateId: t.body.id,
  });
  expect(c.status).toBe(201);
  return { template: t.body, list: l.body, campaign: c.body };
}

describe("a campaign", () => {
  it("sends only to people whose consent holds when it is sent, not when it was scheduled", async () => {
    const app = await startApp({ fakes });
    const { campaign } = await setup(app);
    fakes.consent.allow("email", "okan@example.com", "gizem@example.com", "ayse@example.com");
    const scheduled = await app.api("POST", `/api/v1/campaigns/${campaign.id}/schedule`, { at: new Date(app.clock() + 3_600_000).toISOString() });
    expect(scheduled.body.state).toBe("scheduled");
    await app.settle();
    expect(fakes.ses.sent).toHaveLength(0);
    // Gizem says no in Consent after it was scheduled.
    fakes.consent.deny("email", "gizem@example.com");
    app.clock.advance(3_600_000);
    await app.settle();
    expect(fakes.ses.sent.map((s) => s.to[0]).sort()).toEqual(["ayse@example.com", "okan@example.com"]);
    const c = (await app.api("GET", `/api/v1/campaigns/${campaign.id}`)).body;
    expect(c.state).toBe("sent");
    expect(c.counts).toMatchObject({ sent: 2, held: 1 });
    // Consent was asked in one batch with every address, on the email channel.
    expect(fakes.consent.checks.at(-1)).toMatchObject({ channel: "email" });
    expect(fakes.consent.checks.at(-1)!.people).toHaveLength(3);
    await app.close();
  });

  it("sends nothing while Consent cannot be asked", async () => {
    const app = await startApp({ fakes });
    const { campaign } = await setup(app);
    fakes.consent.allow("email", "okan@example.com", "gizem@example.com", "ayse@example.com");
    fakes.consent.fail(1, 503, { code: "internal-error" });
    await app.api("POST", `/api/v1/campaigns/${campaign.id}/schedule`, {});
    await app.settle(3);
    expect(fakes.ses.sent).toHaveLength(0);
    expect(app.messages.summary().waiting.email).toMatch(/Waiting for Consent/);
    app.clock.advance(61_000);
    await app.settle();
    expect(fakes.ses.sent).toHaveLength(3);
    await app.close();
  });

  it("writes an email with personal fields, tagged links, an unsubscribe link and one-click headers", async () => {
    const app = await startApp({ fakes });
    const { campaign } = await setup(app);
    fakes.consent.allow("email", "okan@example.com");
    await app.api("POST", `/api/v1/campaigns/${campaign.id}/schedule`, {});
    await app.settle();
    const raw = fakes.ses.sent.find((s) => s.to[0] === "okan@example.com")!.raw;
    expect(raw).toMatch(/^List-Unsubscribe: <http:\/\/localhost:\d+\/u\/[A-Za-z0-9_-]+>$/m);
    expect(raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
    expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    const html = Buffer.from(
      raw.split("Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")[1]!.split("\r\n--")[0]!.replace(/\r\n/g, ""),
      "base64",
    ).toString("utf8");
    expect(html).toContain("Merhaba Okan, Tekin Yapı için");
    expect(html).toContain("Abonelikten çık");
    expect(html).toContain("Acme Books A.Ş., Kızılay, Ankara");
    const m = one<{ id: string; links: string }>(app.db, "SELECT id, links FROM messages WHERE address = 'okan@example.com'")!;
    expect(html).toContain(`/c/${m.id}/0`);
    expect(html).toContain(`/o/${m.id}.gif`);
    expect(JSON.parse(m.links)[0]).toBe("https://www.example.com/start?x=1&utm_source=messages&utm_medium=email&utm_campaign=october-newsletter");
    // The tracked link counts the click and sends the person on to the tagged address, which Analytics reads.
    const click = await fetch(`${app.base}/c/${m.id}/0`, { redirect: "manual" });
    expect(click.status).toBe(302);
    expect(click.headers.get("location")).toContain("utm_campaign=october-newsletter");
    const c = (await app.api("GET", `/api/v1/campaigns/${campaign.id}`)).body;
    expect(c.counts).toMatchObject({ clicked: 1, opened: 1 });
    await app.close();
  });

  it("never makes two messages for one address, and an unsubscribe takes effect at once", async () => {
    const app = await startApp({ fakes });
    // Okan is in the list twice, once in capitals.
    const { campaign } = await setup(app, "email", `${CSV}OKAN@example.com,,Okan T.,\n`);
    fakes.consent.allow("email", "okan@example.com", "gizem@example.com", "ayse@example.com");
    await app.api("POST", `/api/v1/campaigns/${campaign.id}/schedule`, {});
    await app.messages.campaigns.tick();
    await app.messages.campaigns.tick();
    expect(one<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM messages WHERE campaign_id = ?", campaign.id)!.n).toBe(3);
    // Ayşe unsubscribes from an earlier message before this one goes out: hers is cancelled.
    const earlier = one<{ id: string }>(app.db, "SELECT id FROM messages WHERE address = 'ayse@example.com'")!;
    const page = await fetch(`${app.base}/u/${earlier.id}`);
    expect(await page.text()).toContain('<form method="post">');
    const post = await fetch(`${app.base}/u/${earlier.id}`, {
      method: "POST",
      body: "List-Unsubscribe=One-Click",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(post.status).toBe(200);
    await app.settle();
    expect(fakes.ses.sent.map((s) => s.to[0]).sort()).toEqual(["gizem@example.com", "okan@example.com"]);
    // The refusal reaches Consent, and the event Audience.
    await app.messages.people.flush();
    expect(fakes.consent.recorded.at(-1)).toMatchObject({
      person: { email: "ayse@example.com" },
      answers: [{ purpose: "marketing", channel: "email", granted: false }],
    });
    expect(fakes.audience.events.map((e) => e.type)).toContain("message_sent");
    expect(fakes.audience.events.every((e) => e.source === "messages")).toBe(true);
    // Scheduling the same campaign again sends nobody a second message.
    await app.api("POST", `/api/v1/campaigns/${campaign.id}/pause`, {});
    expect((await app.api("POST", `/api/v1/campaigns/${campaign.id}/schedule`, {})).status).toBe(409);
    await app.close();
  });

  it("is not sent twice after a stop in the middle of sending, and carries on reading after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "messages-"));
    const dbPath = join(dir, "messages.db");
    const app = await startApp({ fakes, dbPath });
    fakes.audience.segment(
      "seg-1",
      "Business customers",
      ["a", "b", "c", "d", "e"].map((x, i) => ({ id: `p${i}`, name: `Person ${x}`, email: `${x}@example.com`, phone: null, userId: null, traits: {} })),
    );
    fakes.consent.allow("email", "a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com");
    const t = await app.api("POST", "/api/v1/templates", { name: "year-end", channel: "email", subject: "Year end", body: "Hello {{first_name}}" });
    const c = await app.api("POST", "/api/v1/campaigns", {
      name: "Year-end checklist",
      channel: "email",
      audience: { kind: "segment", id: "seg-1" },
      templateId: t.body.id,
    });
    expect(c.body.audience.name).toBe("Business customers");
    await app.api("POST", `/api/v1/campaigns/${c.body.id}/schedule`, {});
    // It starts and reads one page of two people; then the process "stops" with one message claimed but not answered.
    await app.messages.campaigns.tick();
    expect(one<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM messages")!.n).toBe(2);
    app.db.prepare("UPDATE messages SET state = 'sending' WHERE address = 'a@example.com'").run();
    await app.close();
    app.db.close();

    // A new process on the same database.
    const db = openDb(dbPath);
    const clock = fakeClock();
    const again = createMessages(db, { publicUrl: "http://localhost", env: ENV, clock, sleep: clock.sleep, log: () => {} });
    const s = settingsFor(fakes);
    again.setConfig(parseConfig(s), s);
    expect(again.dispatcher.recover()).toBe(1);
    for (let i = 0; i < 8; i++) await again.step();
    const sent = fakes.ses.sent.map((x) => x.to[0]).sort();
    expect(sent).toEqual(["b@example.com", "c@example.com", "d@example.com", "e@example.com"]);
    const v = again.campaigns.get(c.body.id);
    expect(v.counts).toMatchObject({ sent: 4, unknown: 1 });
    expect(v.audienceSize).toBe(5);
    expect(v.state).toBe("sent");
    db.close();
  });

  it("sends at most the provider's rate", async () => {
    const settings = settingsFor(fakes)
      .replace("configuration_set: messages, sns_topic", "rate: 2, configuration_set: messages, sns_topic")
      .replace(", rate: 100 }\n    fallback", " }\n    fallback");
    const app = await startApp({ fakes, settings });
    const csv = "email\n" + Array.from({ length: 9 }, (_, i) => `p${i}@example.com`).join("\n");
    const { campaign } = await setup(app, "email", csv);
    for (let i = 0; i < 9; i++) fakes.consent.allow("email", `p${i}@example.com`);
    await app.api("POST", `/api/v1/campaigns/${campaign.id}/schedule`, {});
    await app.messages.campaigns.tick();
    await app.messages.campaigns.tick();
    const start = app.clock();
    while (fakes.ses.sent.length < 9) await app.messages.dispatcher.tick();
    // 2 a second with a burst of 2: nine messages take at least 3.5 seconds.
    expect(app.clock() - start).toBeGreaterThanOrEqual(3500);
    await app.close();
  });

  it("uses the fallback only when the primary surely did not take the message, and never resends an unknown one", async () => {
    const app = await startApp({ fakes });
    const { campaign } = await setup(app, "email", "email\nx@example.com\ny@example.com\n");
    fakes.consent.allow("email", "x@example.com", "y@example.com");
    fakes.ses.fail(1, 503, { __type: "ServiceUnavailable", message: "down" });
    fakes.ses.fail(1, 200, {});
    await app.api("POST", `/api/v1/campaigns/${campaign.id}/schedule`, {});
    await app.settle();
    const rows = app.db.prepare("SELECT address, state, provider FROM messages ORDER BY address").all() as Array<{
      address: string;
      state: string;
      provider: string | null;
    }>;
    expect(rows).toEqual([
      { address: "x@example.com", state: "sent", provider: "email:fallback" },
      { address: "y@example.com", state: "unknown", provider: null },
    ]);
    expect(fakes.smtp.received.map((r) => r.to)).toEqual(["x@example.com"]);
    app.clock.advance(3_600_000);
    await app.settle();
    expect(fakes.ses.sent).toHaveLength(0);
    await app.close();
  });

  it("does not send to an address that bounced hard until someone fixes it", async () => {
    const app = await startApp({ fakes });
    const { campaign } = await setup(app, "email", "email\nnobody@example.com\n");
    fakes.consent.allow("email", "nobody@example.com");
    app.messages.people.bounce("email", "nobody@example.com", true, "550 5.1.1 mailbox does not exist", null, "ses");
    await app.api("POST", `/api/v1/campaigns/${campaign.id}/schedule`, {});
    await app.settle();
    expect(fakes.ses.sent).toHaveLength(0);
    const list = (await app.api("GET", "/api/v1/bounces")).body.bounces;
    expect(list[0]).toMatchObject({ address: "nobody@example.com", kind: "hard" });
    expect((await app.api("DELETE", `/api/v1/bounces/${list[0].id}`)).status).toBe(204);
    expect(app.messages.people.suppressed("email", "nobody@example.com")).toBeNull();
    await app.close();
  });

  it("stops an address after three soft bounces in a row", async () => {
    const app = await startApp({ fakes });
    for (let i = 0; i < 2; i++) expect(app.messages.people.bounce("email", "full@example.com", false, "452 mailbox full", null, "ses")).toBe("soft");
    expect(app.messages.people.suppressed("email", "full@example.com")).toBeNull();
    expect(app.messages.people.bounce("email", "full@example.com", false, "452 mailbox full", null, "ses")).toBe("hard");
    expect(app.messages.people.suppressed("email", "full@example.com")).toMatch(/Bounced hard/);
    await app.close();
  });
});

describe("SMS and WhatsApp", () => {
  it("sends SMS through Netgsm with the stop text, waits out quiet hours, and reads delivery reports", async () => {
    // 10:00 UTC is 13:00 in Istanbul: inside 12:00-14:00.
    const app = await startApp({ fakes, settings: settingsFor(fakes, { quiet: "12:00-14:00" }) });
    const { campaign } = await setup(app, "sms");
    fakes.consent.allow("sms", "+905321112233", "+905332223344");
    await app.api("POST", `/api/v1/campaigns/${campaign.id}/schedule`, {});
    await app.settle();
    expect(fakes.netgsm.sent).toHaveLength(0);
    expect(app.messages.summary().waiting.sms).toMatch(/Quiet hours/);
    app.clock.advance(3_600_000);
    await app.settle();
    expect(fakes.netgsm.sent.map((s) => s.no).sort()).toEqual(["905321112233", "905332223344"]);
    expect(fakes.netgsm.sent[0]!.msg).toMatch(/İptal için RET yazıp 4609'a gönderin\.$/);
    expect(fakes.netgsm.sent[0]!.msg).toMatch(/\/c\/[A-Za-z0-9_-]+\/0/);
    expect(fakes.netgsm.sent[0]).toMatchObject({ header: "ACME", iysfilter: "11" });
    const [a, b] = fakes.netgsm.sent;
    fakes.netgsm.status.set(a!.jobid, 1);
    fakes.netgsm.status.set(b!.jobid, 3);
    await app.messages.dispatcher.pullSmsReports((id, r) => app.messages.results.report("sms", id, r, "report"));
    const c = (await app.api("GET", `/api/v1/campaigns/${campaign.id}`)).body;
    expect(c.counts).toMatchObject({ delivered: 1, bounced: 1 });
    const bounced = fakes.netgsm.sent.find((s) => s.jobid === b!.jobid)!.no;
    expect(app.messages.people.suppressed("sms", `+${bounced}`)).toMatch(/number not in service/);
    await app.close();
  });

  it("sends SMS through İleti Merkezi", async () => {
    const app = await startApp({ fakes, settings: settingsFor(fakes, { sms: "iletimerkezi" }) });
    const { campaign } = await setup(app, "sms");
    fakes.consent.allow("sms", "+905321112233");
    await app.api("POST", `/api/v1/campaigns/${campaign.id}/schedule`, {});
    await app.settle();
    expect(fakes.ileti.sent).toHaveLength(1);
    expect(fakes.ileti.sent[0]).toMatchObject({ sender: "ACME", number: "905321112233" });
    fakes.ileti.status.set(fakes.ileti.sent[0]!.id, 111);
    await app.messages.dispatcher.pullSmsReports((id, r) => app.messages.results.report("sms", id, r, "report"));
    expect((await app.api("GET", `/api/v1/campaigns/${campaign.id}`)).body.counts.delivered).toBe(1);
    await app.close();
  });

  it("sends only approved WhatsApp templates, asking Consent on the channel the file names", async () => {
    const app = await startApp({ fakes });
    const sync = await app.api("POST", "/api/v1/templates/sync", {});
    expect(sync.body).toEqual({ updated: 0, added: 1 });
    const tpl = (await app.api("GET", "/api/v1/templates")).body.templates.find((t: any) => t.waName === "trial_last_day");
    expect(tpl.approval).toBe("APPROVED");
    await app.api("PATCH", `/api/v1/templates/${tpl.id}`, { waParams: ["{{first_name}}"] });
    const l = await app.api("POST", "/api/v1/lists", { name: "Trial", csv: CSV });
    const c = await app.api("POST", "/api/v1/campaigns", {
      name: "Trial ends",
      channel: "whatsapp",
      audience: { kind: "list", id: l.body.id },
      templateId: tpl.id,
    });
    fakes.consent.allow("sms", "+905321112233");
    await app.api("POST", `/api/v1/campaigns/${c.body.id}/schedule`, {});
    await app.settle();
    expect(fakes.whatsapp.sent).toEqual([expect.objectContaining({ to: "905321112233", template: "trial_last_day", lang: "tr", params: ["Okan"] })]);
    expect(fakes.consent.checks.at(-1)!.channel).toBe("sms");
    await app.close();
  });
});

describe("A/B test", () => {
  it("sends both subjects to the test share, then the one with more opens to the rest", async () => {
    const app = await startApp({ fakes });
    const csv = "email\n" + Array.from({ length: 200 }, (_, i) => `ab${i}@example.com`).join("\n");
    const t = await app.api("POST", "/api/v1/templates", { name: "news", channel: "email", subject: "What's new", body: "Hi" });
    const l = await app.api("POST", "/api/v1/lists", { name: "All", csv });
    for (let i = 0; i < 200; i++) fakes.consent.allow("email", `ab${i}@example.com`);
    const c = await app.api("POST", "/api/v1/campaigns", {
      name: "AB",
      channel: "email",
      audience: { kind: "list", id: l.body.id },
      templateId: t.body.id,
      ab: { subject: "6 more banks", share: 30, metric: "opened", waitHours: 2 },
    });
    await app.api("POST", `/api/v1/campaigns/${c.body.id}/schedule`, {});
    await app.settle();
    const test = fakes.ses.sent.length;
    expect(test).toBeGreaterThan(30);
    expect(test).toBeLessThan(90);
    // B's people open.
    for (const r of app.db.prepare("SELECT id FROM messages WHERE variant = 'b'").all() as Array<{ id: string }>) await fetch(`${app.base}/o/${r.id}.gif`);
    app.clock.advance(2 * 3_600_000 + 1000);
    await app.settle();
    const v = (await app.api("GET", `/api/v1/campaigns/${c.body.id}`)).body;
    expect(v.ab.winner).toBe("b");
    expect(v.state).toBe("sent");
    expect(fakes.ses.sent).toHaveLength(200);
    expect(fakes.ses.sent.at(-1)!.raw).toContain(`Subject: 6 more banks`);
    await app.close();
  });
});
