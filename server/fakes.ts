// Fakes of every provider and linked product, for tests. Each answers the routes Messages calls, in the shapes their
// documentation (and, for Consent and Audience, their openapi.json) gives, checks the credentials it was given, and
// keeps what it received. They are what "tested against fakes" means in the README: the real services were not called.
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { signV4 } from "./ses.ts";

async function listen(handle: (req: IncomingMessage, res: ServerResponse, url: URL, body: string) => unknown) {
  const calls: Array<{ method: string; path: string; body: string; headers: IncomingMessage["headers"] }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://localhost");
    calls.push({ method: req.method ?? "GET", path: url.pathname + url.search, body, headers: req.headers });
    await handle(req, res, url, body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const send = (res: ServerResponse, status: number, data?: unknown, headers: Record<string, string> = {}) =>
  data === undefined
    ? res.writeHead(status, headers).end()
    : res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(data));

/** A queue of answers to give instead of the normal one: { status, body } or "hang" (no answer, for timeouts). */
function failures() {
  const queue: Array<{ status: number; body: unknown } | "hang"> = [];
  return {
    queue,
    fail: (n: number, status = 503, body: unknown = { message: "down" }) => {
      for (let i = 0; i < n; i++) queue.push({ status, body });
    },
    hang: () => queue.push("hang"),
    /** True when it answered (or hung) instead. */
    take(res: ServerResponse): boolean {
      const f = queue.shift();
      if (!f) return false;
      if (f !== "hang") send(res, f.status, f.body);
      return true;
    },
  };
}

/** Amazon SES v2: POST /v2/email/outbound-emails, signed with SigV4 by the given keys (checked by signing again). */
export async function fakeSes(accessKey = "AKIDEXAMPLE", secretKey = "ses-secret", region = "eu-central-1") {
  const sent: Array<{ id: string; from: string; to: string[]; raw: string; configurationSet?: string }> = [];
  const f = failures();
  let n = 0;
  const srv = await listen((req, res, url, body) => {
    if (req.method !== "POST" || url.pathname !== "/v2/email/outbound-emails") return send(res, 404, { message: "not found" });
    const given = String(req.headers.authorization ?? "");
    const expected = signV4(
      { method: "POST", url: `http://${req.headers.host}${url.pathname}`, headers: { "content-type": String(req.headers["content-type"]) }, body },
      { accessKey, secretKey },
      region,
      "ses",
      new Date(String(req.headers["x-amz-date"]).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z")),
    ).authorization;
    if (given !== expected) return send(res, 403, { __type: "SignatureDoesNotMatch", message: "The request signature we calculated does not match." });
    if (f.take(res)) return;
    const b = JSON.parse(body) as {
      FromEmailAddress: string;
      Destination: { ToAddresses: string[] };
      Content: { Raw: { Data: string } };
      ConfigurationSetName?: string;
    };
    const id = `0100018f-${String(++n).padStart(8, "0")}-ses`;
    sent.push({
      id,
      from: b.FromEmailAddress,
      to: b.Destination.ToAddresses,
      raw: Buffer.from(b.Content.Raw.Data, "base64").toString("utf8"),
      configurationSet: b.ConfigurationSetName,
    });
    send(res, 200, { MessageId: id });
  });
  return { ...srv, sent, ...f };
}

/** An SMTP server: EHLO, AUTH PLAIN, MAIL, RCPT (550 for the addresses in `unknown`), DATA. No TLS. */
export async function fakeSmtp(user = "smtp-user", password = "smtp-pass") {
  const received: Array<{ from: string; to: string; data: string }> = [];
  const unknown = new Set<string>();
  let dropAfterData = false;
  let n = 0;
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let inData = false;
    let from = "";
    let to = "";
    const w = (s: string) => socket.write(s + "\r\n");
    w("220 fake.smtp ESMTP");
    socket.on("data", (d) => {
      buffer += d.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          const data = buffer.slice(0, end).replace(/\r\n\.\./g, "\r\n.");
          buffer = buffer.slice(end + 5);
          inData = false;
          if (dropAfterData) {
            dropAfterData = false;
            received.push({ from, to, data });
            socket.destroy();
            return;
          }
          received.push({ from, to, data });
          w(`250 2.0.0 Ok: queued as Q${++n}`);
          continue;
        }
        const i = buffer.indexOf("\r\n");
        if (i < 0) return;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) (w("250-fake.smtp"), w("250-AUTH PLAIN"), w("250 8BITMIME"));
        else if (cmd.startsWith("AUTH PLAIN ")) {
          const [, u, p] = Buffer.from(line.slice(11), "base64").toString("utf8").split("\0");
          w(u === user && p === password ? "235 2.7.0 Authentication successful" : "535 5.7.8 Authentication failed");
        } else if (cmd.startsWith("MAIL FROM:")) ((from = line.slice(10).replace(/[<>]/g, "")), w("250 2.1.0 Ok"));
        else if (cmd.startsWith("RCPT TO:")) {
          to = line.slice(8).replace(/[<>]/g, "");
          w(unknown.has(to) ? "550 5.1.1 <" + to + ">: Recipient address rejected: User unknown" : "250 2.1.5 Ok");
        } else if (cmd === "DATA") ((inData = true), w("354 End data with <CR><LF>.<CR><LF>"));
        else if (cmd === "QUIT") (w("221 2.0.0 Bye"), socket.end());
        else w("502 5.5.2 Error: command not recognized");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    unknown,
    dropAfterData: () => void (dropAfterData = true),
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** Netgsm REST v2: /sms/rest/v2/send and /sms/rest/v2/report, with basic auth. */
export async function fakeNetgsm(user = "8508000000", password = "netgsm-pass") {
  const sent: Array<{ jobid: string; header: string; no: string; msg: string; iysfilter: string }> = [];
  const status = new Map<string, number>();
  const f = failures();
  let n = 0;
  const srv = await listen((req, res, url, body) => {
    if (req.headers.authorization !== `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`)
      return send(res, 200, { code: "30", description: "invalid credentials" });
    if (f.take(res)) return;
    if (url.pathname === "/sms/rest/v2/send") {
      const b = JSON.parse(body) as { msgheader: string; messages: Array<{ msg: string; no: string }>; iysfilter: string };
      const jobid = String(17_000_000_000 + ++n);
      for (const m of b.messages) sent.push({ jobid, header: b.msgheader, no: m.no, msg: m.msg, iysfilter: b.iysfilter });
      status.set(jobid, 0);
      return send(res, 200, { code: "00", jobid, description: "queued" });
    }
    if (url.pathname === "/sms/rest/v2/report") {
      const b = JSON.parse(body) as { jobids: string[] };
      return send(res, 200, {
        code: "00",
        jobs: b.jobids.filter((j) => status.has(j)).map((j) => ({ jobid: j, telno: sent.find((s) => s.jobid === j)?.no, status: status.get(j) })),
      });
    }
    send(res, 404, { code: "70" });
  });
  return { ...srv, sent, status, ...f };
}

/** İleti Merkezi v1: /v1/send-sms/json and /v1/get-report/json, with key and HMAC hash. */
export async function fakeIletiMerkezi(key = "ileti-key", secret = "ileti-secret") {
  const sent: Array<{ id: string; sender: string; number: string; text: string }> = [];
  const status = new Map<string, number>();
  let n = 0;
  const srv = await listen((_req, res, url, body) => {
    const b = JSON.parse(body || "{}") as { request?: { authentication?: { key: string; hash: string }; order?: Record<string, any> } };
    const a = b.request?.authentication;
    if (a?.key !== key || a.hash !== createHmac("sha256", secret).update(key).digest("hex"))
      return send(res, 200, { response: { status: { code: 401, message: "Üyelik bilgileri hatalı" } } });
    const o = b.request!.order!;
    if (url.pathname === "/v1/send-sms/json") {
      const id = String(++n + 1000);
      for (const number of o.message.receipents.number as string[]) sent.push({ id, sender: o.sender, number, text: o.message.text });
      status.set(id, 110);
      return send(res, 200, { response: { status: { code: 200, message: "İşlem başarılı" }, order: { id } } });
    }
    if (url.pathname === "/v1/get-report/json") {
      const id = String(o.id);
      const msgs = sent.filter((s) => s.id === id).map((s) => ({ number: `+${s.number}`, status: String(status.get(id)) }));
      return send(res, 200, { response: { status: { code: 200 }, order: { id, status: 114, message: msgs } } });
    }
    send(res, 404, {});
  });
  return { ...srv, sent, status };
}

/** The WhatsApp Cloud API: /{phone-number-id}/messages and /{waba-id}/message_templates, with a bearer token. */
export async function fakeWhatsApp(token = "wa-token", phoneNumberId = "1098765432", wabaId = "2098765432") {
  const sent: Array<{ id: string; to: string; template: string; lang: string; params: string[] }> = [];
  const templates = [
    {
      name: "trial_last_day",
      status: "APPROVED",
      language: "tr",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Merhaba {{1}}, deneme süreniz bugün bitiyor." }],
    },
    { name: "invoice_overdue", status: "PENDING", language: "tr", category: "UTILITY", components: [{ type: "BODY", text: "{{1}} faturanız gecikti." }] },
  ];
  const f = failures();
  let n = 0;
  const srv = await listen((req, res, url, body) => {
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: { message: "Invalid OAuth access token", code: 190 } });
    if (f.take(res)) return;
    if (req.method === "POST" && url.pathname === `/${phoneNumberId}/messages`) {
      const b = JSON.parse(body) as {
        to: string;
        template: { name: string; language: { code: string }; components?: Array<{ parameters: Array<{ text: string }> }> };
      };
      const t = templates.find((x) => x.name === b.template.name && x.language === b.template.language.code);
      if (!t || t.status !== "APPROVED") return send(res, 404, { error: { message: "Template name does not exist in the translation", code: 132001 } });
      const id = `wamid.${randomBytes(6).toString("hex")}${++n}`;
      sent.push({
        id,
        to: b.to,
        template: b.template.name,
        lang: b.template.language.code,
        params: b.template.components?.[0]?.parameters.map((p) => p.text) ?? [],
      });
      return send(res, 200, { messaging_product: "whatsapp", contacts: [{ input: b.to, wa_id: b.to }], messages: [{ id }] });
    }
    if (req.method === "GET" && url.pathname === `/${wabaId}/message_templates`) return send(res, 200, { data: templates, paging: {} });
    send(res, 404, { error: { message: "Unknown path", code: 100 } });
  });
  return { ...srv, sent, templates, ...f };
}

/** Consent: POST /api/v1/check (answers by address, set with allow/deny) and POST /api/v1/consents. */
export async function fakeConsent(token = "consent-token") {
  const answers = new Map<string, boolean>();
  const recorded: Array<Record<string, any>> = [];
  const checks: Array<{ channel: string; people: Array<Record<string, string>> }> = [];
  const f = failures();
  const srv = await listen((req, res, url, body) => {
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { code: "unauthenticated", detail: "Sign in or send an API token." });
    if (f.take(res)) return;
    if (req.method === "POST" && url.pathname === "/api/v1/check") {
      const b = JSON.parse(body) as { purpose: string; channel: string; people: Array<Record<string, string>> };
      checks.push({ channel: b.channel, people: b.people });
      const results = b.people.map((p) => {
        const key = `${b.channel}:${p.email ?? p.phone}`;
        const a = answers.get(key);
        return {
          person: a === undefined ? null : "00000000-0000-4000-8000-000000000001",
          purpose: b.purpose,
          channel: b.channel,
          status: a === undefined ? "none" : a ? "granted" : "withdrawn",
          allowed: a === true,
          version: a === undefined ? null : 1,
          current: 1,
          at: a === undefined ? null : "2026-10-01T10:00:00.000Z",
          source: a === undefined ? null : "form",
        };
      });
      return send(res, 200, { purpose: b.purpose, channel: b.channel, results });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/consents") {
      const b = JSON.parse(body) as Record<string, any>;
      recorded.push(b);
      for (const a of b.answers) answers.set(`${a.channel}:${b.person.email ?? b.person.phone}`, a.granted);
      return send(res, 201, { person: "00000000-0000-4000-8000-000000000001", answers: [], standing: [] });
    }
    send(res, 404, { code: "not-found" });
  });
  return {
    ...srv,
    answers,
    recorded,
    checks,
    ...f,
    allow: (channel: string, ...who: string[]) => who.forEach((w) => answers.set(`${channel}:${w}`, true)),
    deny: (channel: string, ...who: string[]) => who.forEach((w) => answers.set(`${channel}:${w}`, false)),
  };
}

export interface FakeMember {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  userId: string | null;
  traits: Record<string, string | number | boolean>;
}

/** Audience: segments, their members (two a page) and changes, a person, and POST /api/v1/events. */
export async function fakeAudience(token = "audience-token") {
  const segments = new Map<string, { name: string; members: FakeMember[]; changes: Array<{ profile: string; change: "joined" | "left"; at: string }> }>();
  const people = new Map<string, FakeMember>();
  const events: Array<Record<string, any>> = [];
  const f = failures();
  const srv = await listen((req, res, url, body) => {
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { code: "unauthenticated", detail: "Sign in or send an API token." });
    if (f.take(res)) return;
    let x: RegExpExecArray | null;
    if (req.method === "GET" && url.pathname === "/api/v1/segments")
      return send(res, 200, { segments: [...segments].map(([id, s]) => ({ id, name: s.name, description: null, size: s.members.length })) });
    if (req.method === "GET" && (x = /^\/api\/v1\/segments\/([^/]+)\/members$/.exec(url.pathname))) {
      const s = segments.get(decodeURIComponent(x[1]!));
      if (!s) return send(res, 404, { code: "not-found" });
      const after = url.searchParams.get("cursor") ?? "";
      const sorted = [...s.members].sort((a, b) => (a.id < b.id ? -1 : 1));
      const page = sorted.filter((m) => m.id > after).slice(0, 2);
      const more = sorted.filter((m) => m.id > after).length > 2;
      return send(res, 200, {
        segment: x[1],
        name: s.name,
        members: page.map((m) => ({ ...m, emails: m.email ? [m.email] : [], phones: m.phone ? [m.phone] : [] })),
        ...(more && { nextCursor: page.at(-1)!.id }),
      });
    }
    if (req.method === "GET" && (x = /^\/api\/v1\/segments\/([^/]+)\/changes$/.exec(url.pathname))) {
      const s = segments.get(decodeURIComponent(x[1]!));
      if (!s) return send(res, 404, { code: "not-found" });
      const from = Number(url.searchParams.get("cursor") ?? 0);
      return send(res, 200, { segment: x[1], changes: s.changes.slice(from), cursor: String(s.changes.length) });
    }
    if (req.method === "GET" && (x = /^\/api\/v1\/people\/([^/]+)$/.exec(url.pathname))) {
      const p = people.get(decodeURIComponent(x[1]!));
      return p ? send(res, 200, { ...p, emails: p.email ? [p.email] : [], phones: p.phone ? [p.phone] : [] }) : send(res, 404, { code: "not-found" });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/events") {
      const b = JSON.parse(body) as { events: Array<Record<string, any>> };
      if (b.events.some((e) => e.source !== "messages" || !e.type || !e.person)) return send(res, 422, { code: "invalid-body", detail: "bad event" });
      events.push(...b.events);
      return send(res, 200, { results: b.events.map(() => ({ profile: "p", created: false, merged: false, duplicate: false, ignoredTraits: [] })) });
    }
    send(res, 404, { code: "not-found" });
  });
  return {
    ...srv,
    segments,
    people,
    events,
    ...f,
    segment(id: string, name: string, members: FakeMember[]) {
      segments.set(id, { name, members, changes: [] });
      for (const m of members) people.set(m.id, m);
    },
    join(id: string, m: FakeMember) {
      const s = segments.get(id)!;
      s.members.push(m);
      people.set(m.id, m);
      s.changes.push({ profile: m.id, change: "joined", at: new Date().toISOString() });
    },
    leave(id: string, profile: string) {
      const s = segments.get(id)!;
      s.members = s.members.filter((m) => m.id !== profile);
      s.changes.push({ profile, change: "left", at: new Date().toISOString() });
    },
  };
}
