// What every part of Messages shares: the database, the clock, the settings in force, the linked products, and the
// few helpers for people and addresses.
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Channel, Config } from "./config.ts";
import { normalEmail, normalPhone, normalUserId } from "./identity.ts";
import type { Links } from "./links.ts";
import { log } from "./log.ts";
import type { Sender } from "./providers.ts";

/** Who a message is for, and the personal fields its template may use. */
export interface Person {
  /** Audience's profile id, when the person came from a segment. */
  profile: string | null;
  userId: string | null;
  email: string | null;
  phone: string | null;
  name: string | null;
  fields: Record<string, string | number | boolean>;
}

export interface Actor {
  id: string;
  name: string;
}

export interface Senders {
  email: { primary: Sender; fallback: Sender | null } | null;
  sms: Sender | null;
  whatsapp: Sender | null;
}

export interface Core {
  db: DatabaseSync;
  clock: () => number;
  /** Waits; tests move a fake clock instead. */
  sleep: (ms: number) => Promise<void>;
  publicUrl: string;
  env: Record<string, string | undefined>;
  links: Links;
  http: typeof fetch;
  config(): Config;
  hasConfig(): boolean;
  senders(): Senders;
  /** A random secret kept in the database, part of the SMS webhook addresses. */
  hookSecret(): string;
  log: typeof log;
}

export const iso = (ms: number) => new Date(ms).toISOString();
export const newId = (bytes = 12) => randomBytes(bytes).toString("base64url");

/** The sha256 of an address, which bounces and opt-outs are compared by. */
export const hashAddress = (channel: Channel, address: string) =>
  createHash("sha256")
    .update(`${channel === "email" ? "email" : "phone"}:${address}`)
    .digest("hex");

/** Where a channel reaches the person: their email, or their phone for SMS and WhatsApp. */
export const addressOf = (p: Person, channel: Channel) => (channel === "email" ? p.email : p.phone);

/** One key per person, for journeys: the user id, else the email, else the phone. */
export const personKey = (p: Pick<Person, "userId" | "email" | "phone">) =>
  p.userId ? `u:${p.userId}` : p.email ? `e:${p.email}` : p.phone ? `p:${p.phone}` : null;

/** A person from the API or a CSV row: identifiers written as the other products write them. */
export function readPerson(raw: Record<string, unknown>, country: Config["limits"]["phoneCountry"]): Person {
  const fields: Record<string, string | number | boolean> = {};
  const extra = raw.fields ?? raw.traits;
  if (extra && typeof extra === "object" && !Array.isArray(extra))
    for (const [k, v] of Object.entries(extra))
      if (["string", "number", "boolean"].includes(typeof v) && /^[a-z][a-z0-9_]{0,63}$/i.test(k)) fields[k] = v as string;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 200) : null;
  return {
    profile: typeof raw.profile === "string" ? raw.profile : null,
    userId: normalUserId(raw.userId ?? raw.user_id),
    email: normalEmail(raw.email),
    phone: normalPhone(raw.phone, country),
    name,
    fields,
  };
}

export const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** Runs fn in one transaction. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export const all = <T>(db: DatabaseSync, sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as T[];
export const one = <T>(db: DatabaseSync, sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) as T | undefined;
export const run = (db: DatabaseSync, sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args);

/** A slug for utm_campaign: "October newsletter" is october-newsletter. */
export function slugify(name: string): string {
  return (
    name
      .toLocaleLowerCase("tr")
      .replace(/ı/g, "i")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "campaign"
  );
}

/** A masked address for pages people open from a message: a***@example.com, +90 *** *** 22 33. */
export function mask(address: string): string {
  if (address.includes("@")) {
    const [u, d] = address.split("@");
    return `${u!.slice(0, 1)}***@${d}`;
  }
  return `${address.slice(0, 3)} *** *** ${address.slice(-4, -2)} ${address.slice(-2)}`;
}
