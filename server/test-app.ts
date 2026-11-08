// Starts Messages for tests, with every provider and linked product faked, a clock the test moves by hand, and the
// HTTP app on a random port.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { fakeAudience, fakeConsent, fakeIletiMerkezi, fakeNetgsm, fakeSes, fakeSmtp, fakeWhatsApp } from "./fakes.ts";
import { createMessages } from "./messages.ts";

export const ADMIN_TOKEN = "test-admin-token";

/** A clock the test moves by hand; sleeping moves it. */
export function fakeClock(start = Date.parse("2026-11-09T10:00:00Z")) {
  let t = start;
  return Object.assign(() => t, {
    advance: (ms: number) => void (t += ms),
    sleep: async (ms: number) => void (t += ms),
  });
}

export const ENV = {
  MESSAGES_SES_ACCESS_KEY: "AKIDEXAMPLE",
  MESSAGES_SES_SECRET_KEY: "ses-secret",
  MESSAGES_SMTP_USER: "smtp-user",
  MESSAGES_SMTP_PASSWORD: "smtp-pass",
  MESSAGES_NETGSM_USER: "8508000000",
  MESSAGES_NETGSM_PASSWORD: "netgsm-pass",
  MESSAGES_ILETIMERKEZI_KEY: "ileti-key",
  MESSAGES_ILETIMERKEZI_SECRET: "ileti-secret",
  MESSAGES_WHATSAPP_TOKEN: "wa-token",
  MESSAGES_WHATSAPP_APP_SECRET: "wa-app-secret",
  MESSAGES_WHATSAPP_VERIFY_TOKEN: "wa-verify",
  MESSAGES_CONSENT_TOKEN: "consent-token",
  MESSAGES_AUDIENCE_TOKEN: "audience-token",
};

export type Fakes = Awaited<ReturnType<typeof startFakes>>;

export async function startFakes() {
  const [ses, smtp, netgsm, ileti, whatsapp, consent, audience] = await Promise.all([
    fakeSes(),
    fakeSmtp(),
    fakeNetgsm(),
    fakeIletiMerkezi(),
    fakeWhatsApp(),
    fakeConsent(),
    fakeAudience(),
  ]);
  return {
    ses,
    smtp,
    netgsm,
    ileti,
    whatsapp,
    consent,
    audience,
    close: () => Promise.all([ses.close(), smtp.close(), netgsm.close(), ileti.close(), whatsapp.close(), consent.close(), audience.close()]),
  };
}

export const TOPIC = "arn:aws:sns:eu-central-1:123456789012:messages";

/** The settings file the tests start with: SES with SMTP behind it, Netgsm, WhatsApp, Consent and Audience. */
export function settingsFor(f: Fakes, extra: { sms?: "netgsm" | "iletimerkezi"; quiet?: string; check?: "consent" | "own" } = {}) {
  const sms =
    extra.sms === "iletimerkezi"
      ? `{ kind: iletimerkezi, sender: ACME, endpoint: "${f.ileti.url}", stop: "İptal için RET yazın.", rate: 50 }`
      : `{ kind: netgsm, sender: ACME, endpoint: "${f.netgsm.url}", stop: "İptal için RET yazıp 4609'a gönderin.", rate: 50 }`;
  return `
sender:
  name: Acme Books
  email: hello@example.com
  address: Acme Books A.Ş., Kızılay, Ankara
providers:
  email:
    primary: { kind: ses, region: eu-central-1, endpoint: "${f.ses.url}", configuration_set: messages, sns_topic: "${TOPIC}", rate: 100 }
    fallback: { kind: smtp, host: 127.0.0.1, port: ${f.smtp.port}, security: none, user: MESSAGES_SMTP_USER, password: MESSAGES_SMTP_PASSWORD, rate: 100 }
  sms: ${sms}
  whatsapp: { phone_number_id: "1098765432", business_account_id: "2098765432", endpoint: "${f.whatsapp.url}", rate: 50 }
consent:
  check: ${extra.check ?? "consent"}
  purpose: marketing
products:
  consent: { token: MESSAGES_CONSENT_TOKEN, url: "${f.consent.url}" }
  audience: { token: MESSAGES_AUDIENCE_TOKEN, url: "${f.audience.url}" }
limits:
  timezone: Europe/Istanbul
${extra.quiet ? `  quiet_hours: ${extra.quiet}` : ""}
tracking:
  utm_source: messages
`;
}

export interface StartOptions extends Partial<AppOptions> {
  version?: string;
  settings?: string;
  fakes?: Fakes;
  dbPath?: string;
  /** Extra answers for addresses fetched from outside, such as the SNS certificate. */
  outside?: (url: string) => Response | null;
}

export async function startApp(opts: StartOptions = {}) {
  const fakes = opts.fakes ?? (await startFakes());
  const db = openDb(opts.dbPath ?? ":memory:");
  const clock = fakeClock();
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const outside = opts.outside;
  const http: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const r = outside?.(url);
    return r ?? fetch(input, init);
  };
  const auth = createAuth({ db, product: "messages", productName: "OpenAsy Messages", origin: base });
  const messages = createMessages(db, { publicUrl: base, env: ENV, fetch: http, clock, sleep: clock.sleep, log: () => {} });
  const settings = opts.settings ?? settingsFor(fakes);
  messages.setConfig(parseConfig(settings), settings);
  handler = createApp({ db, messages, auth, adminToken: ADMIN_TOKEN, version: opts.version ?? "0.1.0", log: () => {}, ...opts });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : undefined };
  };
  /** Runs the timers' work a few times, so a campaign reads its audience, sends and finishes. */
  const settle = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) await messages.step();
  };
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!opts.fakes) await fakes.close();
  };
  return { db, messages, auth, base, api, clock, fakes, settle, close };
}
