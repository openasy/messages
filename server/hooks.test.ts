import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { all, one } from "./core.ts";
import { snsStringToSign, type SnsMessage } from "./sns.ts";
import { startApp, startFakes, TOPIC, type Fakes } from "./test-app.ts";

let fakes: Fakes;
beforeAll(async () => {
  fakes = await startFakes();
});
afterAll(() => fakes.close());

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CERT = "https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-0000000000000000000000.pem";
let confirmed = "";
const outside = (url: string) => {
  if (url === CERT) return new Response(publicKey.export({ type: "spki", format: "pem" }) as string);
  if (url.startsWith("https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription")) return ((confirmed = url), new Response("<ok/>"));
  return null;
};

function sns(m: Partial<SnsMessage>, key = privateKey): SnsMessage {
  const msg = {
    Type: "Notification",
    MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
    TopicArn: TOPIC,
    Message: "{}",
    Timestamp: new Date().toISOString(),
    SignatureVersion: "2",
    SigningCertURL: CERT,
    ...m,
  } as SnsMessage;
  msg.Signature = createSign("RSA-SHA256").update(snsStringToSign(msg)).sign(key, "base64");
  return msg;
}

const post = (base: string, path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", body, headers: { "content-type": "text/plain", ...headers } });

async function sentEmail(app: Awaited<ReturnType<typeof startApp>>, address: string) {
  const t = await app.api("POST", "/api/v1/templates", { name: `t${Math.random().toString(36).slice(2, 7)}`, channel: "email", subject: "Hi", body: "Hi" });
  const l = await app.api("POST", "/api/v1/lists", { name: "L", csv: `email\n${address}\n` });
  const c = await app.api("POST", "/api/v1/campaigns", {
    name: "October newsletter",
    channel: "email",
    audience: { kind: "list", id: l.body.id },
    templateId: t.body.id,
  });
  fakes.consent.allow("email", address);
  await app.api("POST", `/api/v1/campaigns/${c.body.id}/schedule`, {});
  await app.settle();
  return one<{ id: string; provider_id: string }>(app.db, "SELECT id, provider_id FROM messages WHERE address = ?", address)!;
}

describe("Amazon SES through SNS", () => {
  it("confirms the subscription and records deliveries, hard bounces and complaints", async () => {
    const app = await startApp({ fakes, outside });
    const sub = sns({
      Type: "SubscriptionConfirmation",
      SubscribeURL: "https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc",
      Token: "abc",
      Message: "confirm",
    });
    expect((await post(app.base, "/hooks/ses", JSON.stringify(sub))).status).toBe(200);
    expect(confirmed).toContain("Token=abc");

    const m = await sentEmail(app, "info@kilicticaret.example.com");
    const bounce = {
      eventType: "Bounce",
      mail: { messageId: m.provider_id },
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "info@kilicticaret.example.com", diagnosticCode: "550 5.1.1 mailbox does not exist" }],
      },
    };
    const r = await post(app.base, "/hooks/ses", JSON.stringify(sns({ Message: JSON.stringify(bounce) })));
    expect(await r.json()).toEqual({ status: "recorded" });
    expect(app.messages.people.suppressed("email", "info@kilicticaret.example.com")).toMatch(/550 5.1.1/);
    expect((await app.api("GET", "/api/v1/bounces")).body.bounces[0]).toMatchObject({ kind: "hard", from: "October newsletter" });

    const m2 = await sentEmail(app, "angry@example.com");
    const delivery = { eventType: "Delivery", mail: { messageId: m2.provider_id }, delivery: { recipients: ["angry@example.com"] } };
    await post(app.base, "/hooks/ses", JSON.stringify(sns({ Message: JSON.stringify(delivery) })));
    const complaint = {
      notificationType: "Complaint",
      mail: { messageId: m2.provider_id },
      complaint: { complainedRecipients: [{ emailAddress: "angry@example.com" }] },
    };
    await post(app.base, "/hooks/ses", JSON.stringify(sns({ Message: JSON.stringify(complaint) })));
    expect(one<{ state: string }>(app.db, "SELECT state FROM messages WHERE id = ?", m2.id)!.state).toBe("delivered");
    expect(app.messages.people.suppressed("email", "angry@example.com")).toMatch(/spam/);
    await app.close();
  });

  it("refuses messages with a wrong signature, another topic or a certificate elsewhere", async () => {
    const app = await startApp({ fakes, outside });
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect((await post(app.base, "/hooks/ses", JSON.stringify(sns({}, other)))).status).toBe(403);
    expect((await post(app.base, "/hooks/ses", JSON.stringify(sns({ TopicArn: "arn:aws:sns:eu-central-1:999999999999:evil" })))).status).toBe(403);
    expect((await post(app.base, "/hooks/ses", JSON.stringify(sns({ SigningCertURL: "https://evil.example.com/cert.pem" })))).status).toBe(403);
    const tampered = sns({ Message: JSON.stringify({ eventType: "Delivery", mail: { messageId: "x" } }) });
    tampered.Message = JSON.stringify({ eventType: "Bounce", mail: { messageId: "x" } });
    expect((await post(app.base, "/hooks/ses", JSON.stringify(tampered))).status).toBe(403);
    expect((await post(app.base, "/hooks/ses", JSON.stringify(sns({ Timestamp: "2020-01-01T00:00:00Z" })))).status).toBe(403);
    await app.close();
  });
});

describe("WhatsApp webhook", () => {
  const sign = (body: string) => `sha256=${createHmac("sha256", "wa-app-secret").update(body).digest("hex")}`;

  it("answers Meta's check with the challenge when the verify token matches", async () => {
    const app = await startApp({ fakes });
    const ok = await fetch(`${app.base}/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=wa-verify&hub.challenge=1158201444`);
    expect(await ok.text()).toBe("1158201444");
    expect((await fetch(`${app.base}/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status).toBe(403);
    await app.close();
  });

  it("checks the signature, then records reads, failures, STOP replies and template approvals", async () => {
    const app = await startApp({ fakes });
    await app.api("POST", "/api/v1/templates/sync", {});
    const tpl = (await app.api("GET", "/api/v1/templates")).body.templates.find((t: any) => t.waName === "trial_last_day");
    const l = await app.api("POST", "/api/v1/lists", { name: "W", csv: "phone,name\n0532 444 55 66,Seda Polat\n" });
    const c = await app.api("POST", "/api/v1/campaigns", {
      name: "Webinar reminder",
      channel: "whatsapp",
      audience: { kind: "list", id: l.body.id },
      templateId: tpl.id,
    });
    fakes.consent.allow("sms", "+905324445566");
    await app.api("POST", `/api/v1/campaigns/${c.body.id}/schedule`, {});
    await app.settle();
    const wamid = fakes.whatsapp.sent.at(-1)!.id;
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "2098765432",
          changes: [
            { field: "messages", value: { statuses: [{ id: wamid, status: "read", recipient_id: "905324445566" }] } },
            { field: "messages", value: { messages: [{ from: "905324445566", id: "wamid.in", type: "text", text: { body: "STOP" } }] } },
            {
              field: "message_template_status_update",
              value: { event: "REJECTED", message_template_name: "trial_last_day", message_template_language: "tr", reason: "INCORRECT_CATEGORY" },
            },
          ],
        },
      ],
    });
    expect((await post(app.base, "/hooks/whatsapp", payload, { "x-hub-signature-256": "sha256=00" })).status).toBe(403);
    const r = await post(app.base, "/hooks/whatsapp", payload, { "x-hub-signature-256": sign(payload), "content-type": "application/json" });
    expect(await r.json()).toEqual({ received: 3 });
    const v = (await app.api("GET", `/api/v1/campaigns/${c.body.id}`)).body;
    expect(v.counts).toMatchObject({ delivered: 1, opened: 1 });
    expect(app.messages.people.suppressed("whatsapp", "+905324445566")).toMatch(/Opted out/);
    expect((await app.api("GET", `/api/v1/templates/${tpl.id}`)).body.approval).toBe("REJECTED");
    await app.close();
  });
});

describe("SMS webhooks", () => {
  it("take delivery reports and STOP replies only at the secret address", async () => {
    const app = await startApp({ fakes });
    const hooks = (await app.api("GET", "/api/v1/hooks")).body;
    const path = new URL(hooks.smsReports).pathname;
    expect((await fetch(`${app.base}/hooks/sms/not-the-secret?jobid=1&status=1`)).status).toBe(404);
    expect((await fetch(`${app.base}${path}?jobid=999&status=1`)).status).toBe(200);
    const stop = await fetch(`${app.base}${path}/inbound`, {
      method: "POST",
      body: "gsmno=905551112233&msg=RET",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(await stop.json()).toEqual({ status: "opted-out" });
    expect(app.messages.people.suppressed("sms", "+905551112233")).toMatch(/Opted out/);
    const other = await fetch(`${app.base}${path}/inbound`, { method: "POST", body: JSON.stringify({ from: "905551112233", text: "Teşekkürler" }) });
    expect(await other.json()).toEqual({ status: "ignored" });
    await app.messages.people.flush();
    expect(fakes.consent.recorded.at(-1)).toMatchObject({ person: { phone: "+905551112233" }, answers: [{ channel: "sms", granted: false }] });
    await app.close();
  });
});

describe("erasure from Audience", () => {
  it("deletes the person here and keeps only the hash of an opt-out", async () => {
    const app = await startApp({ fakes });
    const m = await sentEmail(app, "erase-me@example.com");
    await fetch(`${app.base}/u/${m.id}`, { method: "POST" });
    const body = { reference: "KVKK-2026-031", product: "audience", people: { emails: ["Erase-Me@example.com"], phones: [], userIds: [] } };
    const r = await app.api("POST", "/api/v1/erasures", body);
    expect(r.body).toEqual({ status: "done", deleted: 2 });
    expect(all(app.db, "SELECT 1 FROM messages WHERE address = 'erase-me@example.com'")).toEqual([]);
    expect(all(app.db, "SELECT 1 FROM list_members WHERE email = 'erase-me@example.com'")).toEqual([]);
    expect(app.messages.people.suppressed("email", "erase-me@example.com")).toMatch(/Opted out/);
    expect((await app.api("GET", "/api/v1/optouts")).body.optouts[0].address).toBe("(erased)");
    // The same reference again is answered the same way.
    expect((await app.api("POST", "/api/v1/erasures", body)).body).toEqual({ status: "done", deleted: 2 });
    await app.close();
  });
});
