import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { all } from "./core.ts";
import { startApp, startFakes, type Fakes } from "./test-app.ts";

let fakes: Fakes;
beforeAll(async () => {
  fakes = await startFakes();
});
afterAll(() => fakes.close());
beforeEach(() => {
  fakes.ses.sent.length = 0;
  fakes.netgsm.sent.length = 0;
  fakes.consent.answers.clear();
});

const DAY = 86_400_000;

async function welcome(app: Awaited<ReturnType<typeof startApp>>) {
  const t1 = await app.api("POST", "/api/v1/templates", { name: "welcome-tr", channel: "email", subject: "Hoş geldiniz {{first_name}}", body: "Merhaba" });
  const t2 = await app.api("POST", "/api/v1/templates", { name: "tips", channel: "email", subject: "İpuçları", body: "https://www.example.com/tips" });
  const t3 = await app.api("POST", "/api/v1/templates", { name: "day3-sms", channel: "sms", body: "Merhaba {{first_name}}, ilk faturanızı gönderin." });
  const j = await app.api("POST", "/api/v1/journeys", {
    name: "Welcome",
    trigger: { kind: "event", event: "signup" },
    goal: { kind: "event", event: "invoice_sent" },
    steps: [
      { id: "welcome", kind: "send", channel: "email", templateId: t1.body.id, title: "Welcome email" },
      { id: "wait1", kind: "wait", minutes: 24 * 60 },
      { id: "tips", kind: "send", channel: "email", templateId: t2.body.id, title: "Tips email" },
      { id: "wait2", kind: "wait", minutes: 2 * 24 * 60 },
      { id: "unopened", kind: "branch", test: "opened", negate: true, otherwise: "exit", title: "Opened neither email?" },
      { id: "sms", kind: "send", channel: "sms", templateId: t3.body.id, title: "SMS on day three" },
      { id: "end", kind: "exit" },
    ],
  });
  expect(j.status).toBe(201);
  return j.body;
}

const person = (n: string) => ({
  email: `${n}@example.com`,
  phone: `0532 000 00 ${n.length < 2 ? "0" + n.length : n.length}`,
  name: `${n} Test`,
  userId: `u-${n}`,
});

describe("a journey", () => {
  it("runs its steps: an email at once, another a day later, and an SMS on day three only for those who opened neither", async () => {
    const app = await startApp({ fakes });
    const j = await welcome(app);
    // Nobody enters a draft.
    expect((await app.api("POST", "/api/v1/events", { events: [{ type: "signup", person: person("early") }] })).body.entered).toBe(0);
    expect((await app.api("POST", `/api/v1/journeys/${j.id}/start`)).body.state).toBe("live");
    const okan = { email: "okan@example.com", phone: "0532 111 22 33", name: "Okan Tekin", userId: "u-1" };
    const gizem = { email: "gizem@example.com", phone: "0533 222 33 44", name: "Gizem Avcı", userId: "u-2" };
    fakes.consent.allow("email", "okan@example.com", "gizem@example.com");
    fakes.consent.allow("sms", "+905321112233", "+905332223344");
    const r = await app.api("POST", "/api/v1/events", {
      events: [
        { type: "signup", person: okan },
        { type: "signup", person: gizem },
      ],
    });
    expect(r.body).toEqual({ received: 2, entered: 2, converted: 0 });
    // The same sign-up again does not start it twice.
    expect((await app.api("POST", "/api/v1/events", { events: [{ type: "signup", person: okan }] })).body.entered).toBe(0);
    await app.settle(2);
    expect(fakes.ses.sent.map((s) => s.to[0]).sort()).toEqual(["gizem@example.com", "okan@example.com"]);
    // Okan opens the welcome email.
    const okanMsg = all<{ id: string }>(app.db, "SELECT id FROM messages WHERE address = 'okan@example.com'")[0]!;
    await fetch(`${app.base}/o/${okanMsg.id}.gif`);
    app.clock.advance(DAY);
    await app.settle(2);
    expect(fakes.ses.sent).toHaveLength(4);
    app.clock.advance(2 * DAY);
    await app.settle(2);
    expect(fakes.netgsm.sent.map((s) => s.no)).toEqual(["905332223344"]);
    const v = (await app.api("GET", `/api/v1/journeys/${j.id}`)).body;
    expect(v.stats.entered).toBe(2);
    expect(v.stats.steps.find((s: any) => s.id === "unopened").passed).toBe(2);
    expect(v.stats.steps.find((s: any) => s.id === "sms")).toMatchObject({ passed: 1, sent: 1 });
    expect(v.utmCampaign).toBe("journey-welcome");
    await app.close();
  });

  it("lets a person leave at once when they convert or opt out, and holds people while paused", async () => {
    const app = await startApp({ fakes });
    const j = await welcome(app);
    await app.api("POST", `/api/v1/journeys/${j.id}/start`);
    for (const n of ["a", "b", "c"]) fakes.consent.allow("email", `${n}@example.com`);
    await app.api("POST", "/api/v1/events", {
      events: ["a", "b", "c"].map((n) => ({ type: "signup", person: { email: `${n}@example.com`, userId: `u-${n}` } })),
    });
    await app.settle(2);
    expect(fakes.ses.sent).toHaveLength(3);
    // a converts; b unsubscribes from the welcome email.
    expect((await app.api("POST", "/api/v1/events", { events: [{ type: "invoice_sent", person: { userId: "u-a" } }] })).body.converted).toBe(1);
    const b = all<{ id: string }>(app.db, "SELECT id FROM messages WHERE address = 'b@example.com'")[0]!;
    await fetch(`${app.base}/u/${b.id}`, { method: "POST" });
    // Paused: c waits at the wait step.
    await app.api("POST", `/api/v1/journeys/${j.id}/pause`);
    app.clock.advance(DAY);
    await app.settle(2);
    expect(fakes.ses.sent).toHaveLength(3);
    await app.api("POST", `/api/v1/journeys/${j.id}/start`);
    await app.settle(2);
    expect(fakes.ses.sent.slice(3).map((s) => s.to[0])).toEqual(["c@example.com"]);
    const runs = all<{ email: string; state: string; reason: string | null }>(app.db, "SELECT email, state, reason FROM journey_runs ORDER BY email");
    expect(runs).toEqual([
      { email: "a@example.com", state: "converted", reason: "event:invoice_sent" },
      { email: "b@example.com", state: "exited", reason: "opted-out" },
      { email: "c@example.com", state: "active", reason: null },
    ]);
    await app.close();
  });

  it("starts for people who join an Audience segment, and ends for those who leave it", async () => {
    const app = await startApp({ fakes });
    fakes.audience.segment("seg-trial", "Trial has 3 days left", [
      { id: "p-old", name: "Old One", email: "old@example.com", phone: null, userId: null, traits: {} },
    ]);
    fakes.audience.join("seg-trial", { id: "p-old2", name: "Old Two", email: "old2@example.com", phone: null, userId: null, traits: {} });
    const t = await app.api("POST", "/api/v1/templates", { name: "trial", channel: "email", subject: "Your trial ends soon", body: "Hi {{first_name}}" });
    const j = await app.api("POST", "/api/v1/journeys", {
      name: "Trial ends",
      trigger: { kind: "segment", segment: "seg-trial", name: "Trial has 3 days left" },
      goal: { kind: "segment-left" },
      steps: [
        { id: "w", kind: "wait", minutes: 60 },
        { id: "mail", kind: "send", channel: "email", templateId: t.body.id },
      ],
    });
    await app.api("POST", `/api/v1/journeys/${j.body.id}/start`);
    // The first read only notes where to start: people who joined before it went live do not enter.
    await app.messages.journeys.pollSegments();
    fakes.audience.join("seg-trial", { id: "p-new", name: "Deniz Kaya", email: "deniz@example.com", phone: null, userId: null, traits: {} });
    fakes.audience.join("seg-trial", { id: "p-new2", name: "Ece Kaya", email: "ece@example.com", phone: null, userId: null, traits: {} });
    await app.messages.journeys.pollSegments();
    fakes.audience.leave("seg-trial", "p-new2");
    await app.messages.journeys.pollSegments();
    fakes.consent.allow("email", "deniz@example.com", "ece@example.com");
    await app.settle(2);
    app.clock.advance(61 * 60_000);
    await app.settle(2);
    expect(fakes.ses.sent.map((s) => s.to[0])).toEqual(["deniz@example.com"]);
    const v = (await app.api("GET", `/api/v1/journeys/${j.body.id}`)).body;
    expect(v.stats).toMatchObject({ entered: 2, converted: 1 });
    await app.close();
  });

  it("checks its steps", async () => {
    const app = await startApp({ fakes });
    const sms = await app.api("POST", "/api/v1/templates", { name: "s", channel: "sms", body: "Hi" });
    const bad = (steps: unknown) => app.api("POST", "/api/v1/journeys", { name: "X", trigger: { kind: "event", event: "signup" }, steps });
    expect((await bad([{ kind: "send", channel: "email", templateId: sms.body.id }])).status).toBe(422);
    expect((await bad([{ kind: "wait", minutes: 0 }])).status).toBe(422);
    expect((await bad([{ id: "a", kind: "branch", test: "opened", otherwise: "a" }])).status).toBe(422);
    expect((await bad([{ kind: "nap" }])).status).toBe(422);
    const ok = await bad([
      { id: "a", kind: "branch", test: "consent", channel: "sms", otherwise: "b" },
      { id: "x", kind: "exit" },
      { id: "b", kind: "send", channel: "sms", templateId: sms.body.id },
    ]);
    expect(ok.status).toBe(201);
    await app.close();
  });
});
