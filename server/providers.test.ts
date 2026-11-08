import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeNetgsm, fakeSmtp, fakeWhatsApp } from "./fakes.ts";
import { buildMime, encodeWord } from "./mime.ts";
import { SendError } from "./providers.ts";
import { signV4 } from "./ses.ts";
import { smtpSend } from "./smtp.ts";
import { createSmsSender, isStop, netgsmState, readSmsInbound, readSmsPush, smsNumber } from "./sms.ts";
import { createWhatsAppSender, readWhatsAppWebhook, whatsappSignatureOk } from "./whatsapp.ts";

describe("AWS Signature Version 4", () => {
  it("matches AWS's published example (IAM ListUsers, 2015-08-30)", () => {
    const h = signV4(
      {
        method: "GET",
        url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: "",
      },
      { accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      "us-east-1",
      "iam",
      new Date("2015-08-30T12:36:00Z"),
    );
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });
});

describe("MIME", () => {
  it("encodes non-ASCII subjects and keeps the headers given", () => {
    expect(encodeWord("Hello")).toBe("Hello");
    expect(encodeWord("Hoş geldiniz")).toBe(`=?UTF-8?B?${Buffer.from("Hoş geldiniz").toString("base64")}?=`);
    const raw = buildMime({
      id: "abc",
      from: { name: "Acme Books", email: "hello@example.com" },
      replyTo: null,
      to: "a@example.com",
      subject: "Hi",
      text: "t",
      html: "<p>h</p>",
      headers: { "List-Unsubscribe": "<https://x/u/abc>", "Bad Header": "x", "X-Inject": "a\r\nBcc: evil@example.com" },
    });
    expect(raw).toContain("Message-ID: <abc@example.com>");
    expect(raw).toContain("List-Unsubscribe: <https://x/u/abc>");
    expect(raw).not.toContain("Bcc:");
    expect(raw).not.toContain("Bad Header");
  });
});

describe("SMTP", () => {
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  beforeAll(async () => {
    smtp = await fakeSmtp();
  });
  afterAll(() => smtp.close());
  const opts = () => ({ host: "127.0.0.1", port: smtp.port, security: "none" as const, user: "smtp-user", password: "smtp-pass" });

  it("sends with AUTH PLAIN, doubling dots at the start of lines", async () => {
    const answer = await smtpSend(opts(), "hello@example.com", "a@example.com", "Subject: x\r\n\r\n.start\r\nline\r\n");
    expect(answer).toMatch(/queued as Q\d+/);
    expect(smtp.received.at(-1)).toMatchObject({ from: "hello@example.com", to: "a@example.com" });
    expect(smtp.received.at(-1)!.data).toContain("\r\n.start");
  });

  it("says a 550 to RCPT is a hard bounce, a wrong password is refused, and nothing listening is retry", async () => {
    smtp.unknown.add("gone@example.com");
    await expect(smtpSend(opts(), "hello@example.com", "gone@example.com", "x")).rejects.toMatchObject({ outcome: "refused", hard: true });
    await expect(smtpSend({ ...opts(), password: "wrong" }, "hello@example.com", "a@example.com", "x")).rejects.toMatchObject({
      outcome: "refused",
      hard: false,
    });
    await expect(smtpSend({ ...opts(), port: 1 }, "hello@example.com", "a@example.com", "x")).rejects.toMatchObject({ outcome: "retry" });
  });

  it("says a connection lost after the message was written may have delivered it", async () => {
    smtp.dropAfterData();
    const err = await smtpSend(opts(), "hello@example.com", "a@example.com", "x").catch((e: SendError) => e);
    expect(err).toBeInstanceOf(SendError);
    expect((err as SendError).outcome).toBe("unknown");
  });
});

describe("SMS providers", () => {
  it("write numbers as Turkish providers take them and read reports", () => {
    expect(smsNumber("+905551112233")).toBe("905551112233");
    expect(smsNumber("+491701234567")).toBe("00491701234567");
    expect(netgsmState(1).state).toBe("delivered");
    expect(netgsmState(3)).toMatchObject({ state: "failed", hard: true });
    expect(readSmsPush("netgsm", { jobid: "17", status: "1", telno: "905551112233" })).toMatchObject({
      providerId: "17",
      to: "+905551112233",
      state: "delivered",
    });
    expect(readSmsPush("iletimerkezi", { id: "1001", status: "112" })).toMatchObject({ state: "failed" });
    expect(readSmsInbound({ gsmno: "5551112233", msg: "RET" })).toEqual({ from: "+905551112233", text: "RET" });
  });

  it("know STOP in Turkish, English and German", () => {
    for (const w of ["STOP", "ret", "İptal", "iptal lütfen", "Abmelden"]) expect(isStop(w)).toBe(true);
    for (const w of ["Teşekkürler", "Stopaj ne zaman?", ""]) expect(isStop(w)).toBe(false);
  });

  it("map Netgsm's answers: 00 is sent, 30 is refused, 5xx is retry", async () => {
    const n = await fakeNetgsm();
    const s = createSmsSender(
      { kind: "netgsm", user: "U", password: "P", sender: "ACME", stop: "RET", iys: true, rate: 10, endpoint: n.url },
      { U: "8508000000", P: "netgsm-pass" },
    );
    expect((await s.send({ id: "m1", to: "+905551112233", text: "hi" })).providerId).toMatch(/^\d+$/);
    n.fail(1, 500, {});
    await expect(s.send({ id: "m2", to: "+905551112233", text: "hi" })).rejects.toMatchObject({ outcome: "retry" });
    const wrong = createSmsSender(
      { kind: "netgsm", user: "U", password: "P", sender: "ACME", stop: "RET", iys: true, rate: 10, endpoint: n.url },
      { U: "x", P: "y" },
    );
    await expect(wrong.send({ id: "m3", to: "+905551112233", text: "hi" })).rejects.toMatchObject({ outcome: "refused" });
    await n.close();
  });
});

describe("WhatsApp", () => {
  it("checks X-Hub-Signature-256 against the raw body", () => {
    const body = Buffer.from('{"a":1}');
    const sig = `sha256=${createHmac("sha256", "s").update(body).digest("hex")}`;
    expect(whatsappSignatureOk(body, sig, "s")).toBe(true);
    expect(whatsappSignatureOk(Buffer.from('{"a":2}'), sig, "s")).toBe(false);
    expect(whatsappSignatureOk(body, sig, undefined)).toBe(false);
  });

  it("reads statuses with errors, button replies and template updates", () => {
    const e = readWhatsAppWebhook({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: { statuses: [{ id: "w1", status: "failed", recipient_id: "905551112233", errors: [{ code: 131026, title: "Message undeliverable" }] }] },
            },
            { field: "messages", value: { messages: [{ from: "905551112233", type: "button", button: { text: "Durdur", payload: "STOP" } }] } },
          ],
        },
      ],
    });
    expect(e[0]).toMatchObject({ kind: "status", status: "failed", hard: true, to: "+905551112233" });
    expect(e[1]).toMatchObject({ kind: "reply", text: "Durdur" });
  });

  it("sends a template and treats an unknown one as refused", async () => {
    const w = await fakeWhatsApp();
    const s = createWhatsAppSender(
      {
        kind: "whatsapp",
        phoneNumberId: "1098765432",
        businessAccountId: "2098765432",
        token: "T",
        appSecret: "A",
        verifyToken: "V",
        rate: 10,
        endpoint: w.url,
      },
      { T: "wa-token" },
    );
    expect((await s.send({ id: "m", to: "+905551112233", template: "trial_last_day", lang: "tr", params: ["Okan"] })).providerId).toMatch(/^wamid\./);
    await expect(s.send({ id: "m", to: "+905551112233", template: "nope", lang: "tr", params: [] })).rejects.toMatchObject({ outcome: "refused" });
    w.fail(1, 400, { error: { code: 130429, message: "Rate limit hit" } });
    await expect(s.send({ id: "m", to: "+905551112233", template: "trial_last_day", lang: "tr", params: [] })).rejects.toMatchObject({ outcome: "retry" });
    expect((await s.templates()).map((t) => t.status)).toEqual(["APPROVED", "PENDING"]);
    await w.close();
  });
});
