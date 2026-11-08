// The settings, from one YAML file (MESSAGES_CONFIG): who the messages come from, the providers each channel sends
// through, how consent is checked, the linked products, quiet hours and link tagging. Keys are never in the file: it
// names the environment variables that hold them. As with the other OpenAsy products, the file is the only way in: no
// screen or API route changes these. It is applied whole or not at all, read again within a minute of a change, and a
// file with a mistake leaves the last good version in place. Templates, campaigns and journeys are made in the UI and
// kept in the database.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import { COUNTRIES, type Country } from "./identity.ts";

export const CHANNELS = ["email", "sms", "whatsapp"] as const;
export type Channel = (typeof CHANNELS)[number];

export type ProviderKind = "ses" | "smtp" | "netgsm" | "iletimerkezi" | "whatsapp";

interface Base {
  kind: ProviderKind;
  /** Messages a second, at most. */
  rate: number;
  /** Another address for the provider's API, for a regional endpoint or a test double; null for the documented one. */
  endpoint: string | null;
}

export interface SesProvider extends Base {
  kind: "ses";
  region: string;
  /** Environment variable names, never the values. */
  accessKey: string;
  secretKey: string;
  sessionToken: string | null;
  /** The SES configuration set whose events (bounces, complaints, deliveries) go to the SNS topic Messages listens on. */
  configurationSet: string | null;
  /** The SNS topic's ARN; notifications from any other topic are refused. */
  topic: string | null;
}

export interface SmtpProvider extends Base {
  kind: "smtp";
  host: string;
  port: number;
  /** tls: TLS from the start (465); starttls: upgrade after EHLO (587); none: only for a relay on the same host. */
  security: "tls" | "starttls" | "none";
  user: string | null;
  password: string | null;
}

export interface NetgsmProvider extends Base {
  kind: "netgsm";
  user: string;
  password: string;
  /** The approved sender name (başlık). */
  sender: string;
  /** How to stop, appended to every SMS that does not say it already. */
  stop: string;
  /** Netgsm's İYS filter: commercial messages only to numbers İYS allows. */
  iys: boolean;
}

export interface IletiMerkeziProvider extends Base {
  kind: "iletimerkezi";
  key: string;
  secret: string;
  sender: string;
  stop: string;
  iys: boolean;
}

export interface WhatsAppProvider extends Base {
  kind: "whatsapp";
  phoneNumberId: string;
  businessAccountId: string;
  token: string;
  appSecret: string;
  verifyToken: string;
}

export type EmailProvider = SesProvider | SmtpProvider;
export type SmsProvider = NetgsmProvider | IletiMerkeziProvider;
export type Provider = EmailProvider | SmsProvider | WhatsAppProvider;

export interface Config {
  sender: {
    name: string;
    email: string | null;
    replyTo: string | null;
    /** The postal address every email shows in its footer. */
    address: string | null;
  };
  providers: {
    email: { primary: EmailProvider; fallback: EmailProvider | null } | null;
    sms: SmsProvider | null;
    whatsapp: WhatsAppProvider | null;
  };
  consent: {
    /** consent: Consent is asked before every message; own: Messages' own opt-out list alone (you vouch for the list). */
    check: "consent" | "own";
    /** The purpose in Consent the messages are for. */
    purpose: string;
    /** The Consent channel that holds the answer for WhatsApp, which Consent has no channel of its own for. */
    whatsapp: "sms" | "call";
  };
  products: {
    consent: { url: string | null; token: string } | null;
    audience: { url: string | null; token: string; events: boolean; changesEvery: number } | null;
  };
  limits: {
    /** Minutes after midnight: SMS and WhatsApp wait from start until end. Null for none. */
    quietHours: { start: number; end: number; text: string } | null;
    timezone: string;
    softBounceTries: number;
    phoneCountry: Country;
  };
  tracking: {
    opens: boolean;
    clicks: boolean;
    utmSource: string;
  };
}

const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const TOP = ["sender", "providers", "consent", "products", "limits", "tracking"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function keys(v: Record<string, unknown>, at: string, allowed: string[]) {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; it takes ${allowed.join(", ")}.`);
}

function text(v: unknown, at: string, max = 120): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${at} is a text of 1 to ${max} characters.`);
  return v.trim();
}

function env(v: unknown, at: string): string {
  if (typeof v !== "string" || !ENV.test(v))
    throw new Error(`${at} is the name of an environment variable, such as MESSAGES_SES_SECRET_KEY, never the key itself.`);
  return v;
}

function optEnv(v: unknown, at: string): string | null {
  return v === undefined || v === null ? null : env(v, at);
}

function email(v: unknown, at: string): string {
  if (typeof v !== "string" || !/^[^@\s]{1,64}@[^@\s]+\.[^@\s.]{2,}$/.test(v.trim())) throw new Error(`${at} is an email address.`);
  return v.trim().toLowerCase();
}

function bool(v: unknown, at: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new Error(`${at} is true or false.`);
  return v;
}

/** A rate: 14, "14/s" or "600/m"; messages a second. */
function rate(v: unknown, at: string, fallback: number): number {
  if (v === undefined) return fallback;
  const m = typeof v === "number" ? [String(v), String(v), "s"] : /^(\d+(?:\.\d+)?)\s*\/\s*(s|m)$/.exec(String(v).trim());
  const n = m ? Number(m[1]) / (m[2] === "m" ? 60 : 1) : NaN;
  if (!(n > 0 && n <= 1000)) throw new Error(`${at} is messages a second (up to 1000), such as 14 or 14/s or 600/m.`);
  return n;
}

function endpoint(v: unknown, at: string): string | null {
  if (v === undefined || v === null) return null;
  const url = typeof v === "string" ? URL.parse(v.trim()) : null;
  const local = url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.search)
    throw new Error(`${at} is an https:// address (http:// only for localhost).`);
  return url.href.replace(/\/$/, "");
}

function origin(v: unknown, at: string): string | null {
  if (v === undefined || v === null) return null;
  const url = typeof v === "string" ? URL.parse(v.trim()) : null;
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || (url.pathname !== "/" && url.pathname !== "") || url.search)
    throw new Error(`${at} is an address such as https://consent.example.com.`);
  return url.origin;
}

function stopText(v: unknown, at: string): string {
  if (v === undefined) return "STOP yazıp gönderin, size bir daha yazmayalım.";
  return text(v, at, 120);
}

function emailProvider(v: unknown, at: string): EmailProvider {
  if (!isObj(v)) throw new Error(`${at} is a map with kind: ses or kind: smtp.`);
  if (v.kind === "ses") {
    keys(v, at, ["kind", "region", "access_key", "secret_key", "session_token", "configuration_set", "sns_topic", "rate", "endpoint"]);
    const region = typeof v.region === "string" && /^[a-z]{2}(-[a-z]+)+-\d$/.test(v.region) ? v.region : null;
    if (!region) throw new Error(`${at}.region is an AWS region, such as eu-central-1.`);
    const set = v.configuration_set;
    if (set !== undefined && (typeof set !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(set)))
      throw new Error(`${at}.configuration_set is the name of an SES configuration set.`);
    const topic = v.sns_topic;
    if (topic !== undefined && (typeof topic !== "string" || !/^arn:aws(-[a-z]+)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/.test(topic)))
      throw new Error(`${at}.sns_topic is the ARN of the SNS topic SES publishes to, such as arn:aws:sns:eu-central-1:123456789012:messages.`);
    return {
      kind: "ses",
      region,
      accessKey: env(v.access_key ?? "MESSAGES_SES_ACCESS_KEY", `${at}.access_key`),
      secretKey: env(v.secret_key ?? "MESSAGES_SES_SECRET_KEY", `${at}.secret_key`),
      sessionToken: optEnv(v.session_token, `${at}.session_token`),
      configurationSet: (set as string | undefined) ?? null,
      topic: (topic as string | undefined) ?? null,
      rate: rate(v.rate, `${at}.rate`, 14),
      endpoint: endpoint(v.endpoint, `${at}.endpoint`),
    };
  }
  if (v.kind === "smtp") {
    keys(v, at, ["kind", "host", "port", "security", "user", "password", "rate"]);
    const host = text(v.host, `${at}.host`, 253);
    const port = v.port ?? 587;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new Error(`${at}.port is a port number, such as 587.`);
    const security = v.security ?? (port === 465 ? "tls" : "starttls");
    if (security !== "tls" && security !== "starttls" && security !== "none") throw new Error(`${at}.security is tls, starttls or none.`);
    if (security === "none" && !/^(localhost|127\.0\.0\.1|::1)$/.test(host))
      throw new Error(`${at}.security: none is only for a relay on the same host; use starttls or tls.`);
    return {
      kind: "smtp",
      host,
      port: port as number,
      security,
      user: optEnv(v.user, `${at}.user`),
      password: optEnv(v.password, `${at}.password`),
      rate: rate(v.rate, `${at}.rate`, 5),
      endpoint: null,
    };
  }
  throw new Error(`${at}.kind is ses or smtp.`);
}

function smsProvider(v: unknown, at: string): SmsProvider {
  if (!isObj(v)) throw new Error(`${at} is a map with kind: netgsm or kind: iletimerkezi.`);
  const sender = (x: unknown) => {
    if (typeof x !== "string" || !/^[\p{L}\d .-]{2,11}$/u.test(x)) throw new Error(`${at}.sender is your approved sender name, up to 11 characters.`);
    return x;
  };
  if (v.kind === "netgsm") {
    keys(v, at, ["kind", "user", "password", "sender", "stop", "iys", "rate", "endpoint"]);
    return {
      kind: "netgsm",
      user: env(v.user ?? "MESSAGES_NETGSM_USER", `${at}.user`),
      password: env(v.password ?? "MESSAGES_NETGSM_PASSWORD", `${at}.password`),
      sender: sender(v.sender),
      stop: stopText(v.stop, `${at}.stop`),
      iys: bool(v.iys, `${at}.iys`, true),
      rate: rate(v.rate, `${at}.rate`, 20),
      endpoint: endpoint(v.endpoint, `${at}.endpoint`),
    };
  }
  if (v.kind === "iletimerkezi") {
    keys(v, at, ["kind", "key", "secret", "sender", "stop", "iys", "rate", "endpoint"]);
    return {
      kind: "iletimerkezi",
      key: env(v.key ?? "MESSAGES_ILETIMERKEZI_KEY", `${at}.key`),
      secret: env(v.secret ?? "MESSAGES_ILETIMERKEZI_SECRET", `${at}.secret`),
      sender: sender(v.sender),
      stop: stopText(v.stop, `${at}.stop`),
      iys: bool(v.iys, `${at}.iys`, true),
      rate: rate(v.rate, `${at}.rate`, 20),
      endpoint: endpoint(v.endpoint, `${at}.endpoint`),
    };
  }
  throw new Error(`${at}.kind is netgsm or iletimerkezi.`);
}

function whatsappProvider(v: unknown, at: string): WhatsAppProvider {
  if (!isObj(v)) throw new Error(`${at} is a map with kind: whatsapp, phone_number_id and business_account_id.`);
  keys(v, at, ["kind", "phone_number_id", "business_account_id", "token", "app_secret", "verify_token", "rate", "endpoint"]);
  if (v.kind !== undefined && v.kind !== "whatsapp") throw new Error(`${at}.kind is whatsapp (the WhatsApp Business Cloud API).`);
  const id = (x: unknown, name: string) => {
    const s = typeof x === "number" ? String(x) : x;
    if (typeof s !== "string" || !/^\d{5,20}$/.test(s)) throw new Error(`${at}.${name} is the number Meta gives it, in quotes.`);
    return s;
  };
  return {
    kind: "whatsapp",
    phoneNumberId: id(v.phone_number_id, "phone_number_id"),
    businessAccountId: id(v.business_account_id, "business_account_id"),
    token: env(v.token ?? "MESSAGES_WHATSAPP_TOKEN", `${at}.token`),
    appSecret: env(v.app_secret ?? "MESSAGES_WHATSAPP_APP_SECRET", `${at}.app_secret`),
    verifyToken: env(v.verify_token ?? "MESSAGES_WHATSAPP_VERIFY_TOKEN", `${at}.verify_token`),
    rate: rate(v.rate, `${at}.rate`, 20),
    endpoint: endpoint(v.endpoint, `${at}.endpoint`),
  };
}

function minutes(s: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** A period such as 30s, 1m or 1h, in milliseconds. */
function period(v: unknown, at: string, fallback: number, min: number, max: number): number {
  if (v === undefined) return fallback;
  const m = /^(\d+)\s*(s|m|h)$/.exec(String(v).trim());
  const ms = m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"] : NaN;
  if (!(ms >= min && ms <= max)) throw new Error(`${at} is a period such as 30s, 1m or 1h, from ${min / 1000}s to ${max / 3_600_000}h.`);
  return ms;
}

/** Reads the file's text. Throws with the field at fault, so one message says what to fix. */
export function parseConfig(raw: string): Config {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (!isObj(doc)) throw new Error(`The file is a map of ${TOP.join(", ")}.`);
  keys(doc, "The file", TOP);

  const s = doc.sender ?? {};
  if (!isObj(s)) throw new Error("sender is a map with name, email, reply_to and address.");
  keys(s, "sender", ["name", "email", "reply_to", "address"]);
  const sender = {
    name: s.name === undefined ? "Messages" : text(s.name, "sender.name", 80),
    email: s.email === undefined ? null : email(s.email, "sender.email"),
    replyTo: s.reply_to === undefined ? null : email(s.reply_to, "sender.reply_to"),
    address: s.address === undefined ? null : text(s.address, "sender.address", 200),
  };

  const p = doc.providers ?? {};
  if (!isObj(p)) throw new Error("providers is a map of email, sms and whatsapp.");
  keys(p, "providers", ["email", "sms", "whatsapp"]);
  let emailP: Config["providers"]["email"] = null;
  if (p.email !== undefined && p.email !== null) {
    if (!isObj(p.email)) throw new Error("providers.email is a map with primary and, if you want, fallback.");
    const e = p.email;
    if ("kind" in e) emailP = { primary: emailProvider(e, "providers.email"), fallback: null };
    else {
      keys(e, "providers.email", ["primary", "fallback"]);
      emailP = {
        primary: emailProvider(e.primary, "providers.email.primary"),
        fallback: e.fallback === undefined || e.fallback === null ? null : emailProvider(e.fallback, "providers.email.fallback"),
      };
    }
    if (!sender.email) throw new Error("sender.email is the address emails come from; it is needed once providers.email is set.");
  }
  const sms = p.sms === undefined || p.sms === null ? null : smsProvider(p.sms, "providers.sms");
  const whatsapp = p.whatsapp === undefined || p.whatsapp === null ? null : whatsappProvider(p.whatsapp, "providers.whatsapp");

  const c = doc.consent ?? {};
  if (!isObj(c)) throw new Error("consent is a map with check, purpose and whatsapp.");
  keys(c, "consent", ["check", "purpose", "whatsapp"]);
  const check = c.check ?? "consent";
  if (check !== "consent" && check !== "own")
    throw new Error("consent.check is consent (ask Consent before every message) or own (Messages' own opt-out list alone).");
  const purpose = c.purpose ?? "marketing";
  if (typeof purpose !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(purpose))
    throw new Error("consent.purpose is a purpose id from Consent, such as marketing.");
  const wa = c.whatsapp ?? "sms";
  if (wa !== "sms" && wa !== "call") throw new Error("consent.whatsapp is sms or call: the Consent channel whose answer counts for WhatsApp.");

  const pr = doc.products ?? {};
  if (!isObj(pr)) throw new Error("products is a map of consent and audience.");
  keys(pr, "products", ["consent", "audience"]);
  let consentLink: Config["products"]["consent"] = null;
  if (pr.consent !== undefined && pr.consent !== null) {
    if (!isObj(pr.consent)) throw new Error("products.consent is a map with token and url.");
    keys(pr.consent, "products.consent", ["token", "url"]);
    consentLink = { token: env(pr.consent.token, "products.consent.token"), url: origin(pr.consent.url, "products.consent.url") };
  }
  if (check === "consent" && !consentLink) throw new Error("consent.check is consent, so products.consent needs a token; or set consent.check: own.");
  let audience: Config["products"]["audience"] = null;
  if (pr.audience !== undefined && pr.audience !== null) {
    if (!isObj(pr.audience)) throw new Error("products.audience is a map with token, url, events and changes.");
    keys(pr.audience, "products.audience", ["token", "url", "events", "changes"]);
    audience = {
      token: env(pr.audience.token, "products.audience.token"),
      url: origin(pr.audience.url, "products.audience.url"),
      events: bool(pr.audience.events, "products.audience.events", true),
      changesEvery: period(pr.audience.changes, "products.audience.changes", 60_000, 10_000, 3_600_000),
    };
  }

  const l = doc.limits ?? {};
  if (!isObj(l)) throw new Error("limits is a map with quiet_hours, timezone, soft_bounce_tries and phone_country.");
  keys(l, "limits", ["quiet_hours", "timezone", "soft_bounce_tries", "phone_country"]);
  let quietHours: Config["limits"]["quietHours"] = null;
  if (l.quiet_hours !== undefined && l.quiet_hours !== null && l.quiet_hours !== false) {
    const [a, b] = String(l.quiet_hours).split("-");
    const start = minutes(a ?? "");
    const end = minutes(b ?? "");
    if (start === null || end === null || start === end) throw new Error("limits.quiet_hours is a span such as 21:00-09:00.");
    quietHours = { start, end, text: String(l.quiet_hours).replace(/\s/g, "") };
  }
  const timezone = l.timezone ?? "Europe/Istanbul";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone as string });
  } catch {
    throw new Error("limits.timezone is a time zone such as Europe/Istanbul.");
  }
  const tries = l.soft_bounce_tries ?? 3;
  if (!Number.isInteger(tries) || (tries as number) < 1 || (tries as number) > 10) throw new Error("limits.soft_bounce_tries is 1 to 10.");
  const country = l.phone_country ?? "TR";
  if (typeof country !== "string" || !(country in COUNTRIES)) throw new Error(`limits.phone_country is one of ${Object.keys(COUNTRIES).join(", ")}.`);

  const t = doc.tracking ?? {};
  if (!isObj(t)) throw new Error("tracking is a map with opens, clicks and utm_source.");
  keys(t, "tracking", ["opens", "clicks", "utm_source"]);
  const utm = t.utm_source ?? "messages";
  if (typeof utm !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(utm)) throw new Error("tracking.utm_source is a short name such as messages.");

  return {
    sender,
    providers: { email: emailP, sms, whatsapp },
    consent: { check, purpose, whatsapp: wa },
    products: { consent: consentLink, audience },
    limits: { quietHours, timezone: timezone as string, softBounceTries: tries as number, phoneCountry: country as Country },
    tracking: { opens: bool(t.opens, "tracking.opens", true), clicks: bool(t.clicks, "tracking.clicks", true), utmSource: utm },
  };
}

/** The environment variables a provider's keys are read from. */
export function providerVariables(p: Provider): string[] {
  if (p.kind === "ses") return [p.accessKey, p.secretKey, ...(p.sessionToken ? [p.sessionToken] : [])];
  if (p.kind === "smtp") return [p.user, p.password].filter(Boolean) as string[];
  if (p.kind === "netgsm") return [p.user, p.password];
  if (p.kind === "iletimerkezi") return [p.key, p.secret];
  return [p.token, p.appSecret, p.verifyToken];
}

/** The environment variables the file names, for the settings page and the warnings. */
export function namedVariables(c: Config): string[] {
  const e = c.providers.email;
  const ps = [e?.primary, e?.fallback, c.providers.sms, c.providers.whatsapp].filter(Boolean) as Provider[];
  const names = [...ps.flatMap(providerVariables), c.products.consent?.token, c.products.audience?.token].filter(Boolean) as string[];
  return [...new Set(names)];
}

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
  /** Things to fix that did not stop the file from being applied. */
  warnings: string[];
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * version and its text to `apply`, which returns warnings or throws to refuse it. A file that cannot be read or applied
 * leaves the last good version in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (config: Config, text: string) => string[],
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, error: null, warnings: [] };
  let seen = "";
  const read = () => {
    let raw: string;
    let stamp: string;
    try {
      const st = statSync(path);
      raw = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(raw).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      state.warnings = apply(parseConfig(raw), raw);
      Object.assign(state, { appliedAt: new Date().toISOString(), error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
