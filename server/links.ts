// Calls to the linked OpenAsy products, Consent and Audience, over their public APIs with the tokens the file names
// (ADR 0014, 0023). The address is the file's url, or the product's entry in OPENASY_PRODUCTS; the token is read from
// the environment variable the file names, never from the file. Calls give up after 10 seconds and never follow a
// redirect, which could take the token elsewhere.
import type { Config } from "./config.ts";
import type { ProductLink } from "./products.ts";

export type LinkedProduct = "consent" | "audience";

export class LinkError extends Error {
  /** The product's HTTP status, or null when it could not be reached. */
  readonly status: number | null;
  /** True when trying again will not help until someone changes something: a refused token, a wrong address. */
  readonly permanent: boolean;
  constructor(message: string, status: number | null, permanent: boolean) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

const NAMES: Record<LinkedProduct, string> = { consent: "Consent", audience: "Audience" };

export interface Client {
  id: LinkedProduct;
  call(method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<{ status: number; body: unknown }>;
}

export interface LinkState {
  id: LinkedProduct;
  linked: boolean;
  url: string | null;
  tokenVariable: string | null;
  tokenSet: boolean;
  /** The last call's outcome: when it worked, and the last error since. */
  okAt: string | null;
  error: string | null;
  errorAt: string | null;
}

export function createLinks({
  env,
  products,
  fetch: http = fetch,
}: {
  env: Record<string, string | undefined>;
  products: ProductLink[];
  fetch?: typeof fetch;
}) {
  let config: Config | null = null;
  const health: Record<LinkedProduct, { okAt: string | null; error: string | null; errorAt: string | null }> = {
    consent: { okAt: null, error: null, errorAt: null },
    audience: { okAt: null, error: null, errorAt: null },
  };
  const linkOf = (id: LinkedProduct) => config?.products[id] ?? null;
  const urlOf = (id: LinkedProduct) => linkOf(id)?.url ?? products.find((p) => p.id === id)?.url ?? null;

  function state(): LinkState[] {
    return (["consent", "audience"] as const).map((id) => {
      const l = linkOf(id);
      return { id, linked: !!l, url: urlOf(id), tokenVariable: l?.token ?? null, tokenSet: !!(l && env[l.token]), ...health[id] };
    });
  }

  /** A client for a product, or a LinkError that says what is missing. */
  function client(id: LinkedProduct): Client {
    const l = linkOf(id);
    const name = NAMES[id];
    if (!l) throw new LinkError(`${name} is not linked in messages.yaml.`, null, true);
    const base = urlOf(id);
    if (!base) throw new LinkError(`${name} has no address: set products.${id}.url in messages.yaml, or ${id} in OPENASY_PRODUCTS.`, null, true);
    const token = env[l.token];
    if (!token) throw new LinkError(`${l.token} is not set, so Messages has no token for ${name}.`, null, true);
    const note = (err: LinkError | null) => {
      const h = health[id];
      if (err) Object.assign(h, { error: err.message, errorAt: new Date().toISOString() });
      else Object.assign(h, { okAt: new Date().toISOString(), error: null, errorAt: null });
    };
    return {
      id,
      async call(method, path, query, body) {
        const url = new URL(base + path);
        for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
        let res: Response;
        try {
          res = await http(url, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/json",
              "user-agent": "openasy-messages",
              ...(body !== undefined && { "content-type": "application/json" }),
            },
            ...(body !== undefined && { body: JSON.stringify(body) }),
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          });
        } catch (err) {
          const e = err as Error;
          const le = new LinkError(
            e.name === "TimeoutError"
              ? `${name} did not answer within 10 seconds.`
              : `${name} could not be reached: ${String((e.cause as Error)?.message ?? e.message)}`,
            null,
            false,
          );
          note(le);
          throw le;
        }
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          // not JSON; the status says enough
        }
        if (res.ok || res.status === 404) {
          note(null);
          return { status: res.status, body: parsed };
        }
        const detail = typeof (parsed as { detail?: unknown } | null)?.detail === "string" ? `: ${(parsed as { detail: string }).detail}` : ".";
        let le: LinkError;
        if (res.status === 401) le = new LinkError(`${name} refused the token: make a new one under Settings, API tokens in ${name}.`, 401, true);
        else if (res.status === 403) le = new LinkError(`The token may not do this in ${name}${detail}`, 403, true);
        else le = new LinkError(`${name} answered ${res.status}${detail}`, res.status, res.status < 500 && res.status !== 429);
        note(le);
        throw le;
      },
    };
  }

  return {
    setConfig(c: Config) {
      config = c;
    },
    state,
    client,
    has: (id: LinkedProduct) => !!linkOf(id),
  };
}

export type Links = ReturnType<typeof createLinks>;

// ---------------------------------------------------------------- Consent (its openapi.json)

export type ConsentChannel = "email" | "sms" | "call" | "web";
export interface ConsentWho {
  email?: string;
  phone?: string;
  id?: string;
}
export interface CheckResult {
  person: string | null;
  status: "granted" | "withdrawn" | "renew" | "none";
  allowed: boolean;
}

/** POST /api/v1/check: may these people be reached, in the same order; up to 1000 at once. */
export async function consentCheck(c: Client, purpose: string, channel: ConsentChannel, people: ConsentWho[]): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (let i = 0; i < people.length; i += 1000) {
    const r = await c.call("POST", "/api/v1/check", undefined, { purpose, channel, people: people.slice(i, i + 1000) });
    const results = (r.body as { results?: CheckResult[] } | null)?.results;
    if (r.status !== 200 || !Array.isArray(results) || results.length !== Math.min(1000, people.length - i))
      throw new LinkError(`Consent answered ${r.status} to the check, without one answer per person.`, r.status, false);
    out.push(...results);
  }
  return out;
}

/** POST /api/v1/consents: a refusal, from an unsubscribe link or a STOP reply. */
export async function consentRecord(c: Client, body: unknown) {
  const r = await c.call("POST", "/api/v1/consents", undefined, body);
  if (r.status === 404) throw new LinkError("Consent does not take POST /api/v1/consents at this address.", 404, true);
}

// ---------------------------------------------------------------- Audience (its openapi.json)

export interface AudienceMember {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  userId: string | null;
  emails: string[];
  phones: string[];
  traits: Record<string, string | number | boolean>;
}

export interface AudienceSegment {
  id: string;
  name: string;
  description: string | null;
  size: number;
}

export async function audienceSegments(c: Client): Promise<AudienceSegment[]> {
  const r = await c.call("GET", "/api/v1/segments");
  return ((r.body as { segments?: AudienceSegment[] } | null)?.segments ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description ?? null,
    size: s.size,
  }));
}

/** One page of a segment's members, evaluated by Audience at the first page; null when the segment is gone. */
export async function audienceMembers(c: Client, segment: string, cursor: string | null, limit = 1000) {
  const r = await c.call("GET", `/api/v1/segments/${encodeURIComponent(segment)}/members`, { limit: String(limit), ...(cursor && { cursor }) });
  if (r.status === 404) return null;
  return r.body as { segment: string; name: string; members: AudienceMember[]; nextCursor?: string };
}

/** Who joined and left a segment after the cursor; null when the segment is gone. */
export async function audienceChanges(c: Client, segment: string, cursor: string | null) {
  const r = await c.call("GET", `/api/v1/segments/${encodeURIComponent(segment)}/changes`, { limit: "1000", ...(cursor && { cursor }) });
  if (r.status === 404) return null;
  return r.body as { segment: string; changes: Array<{ profile: string; change: "joined" | "left"; at: string }>; cursor: string };
}

/** A person by profile id, with identifiers and traits; null when there is none. */
export async function audiencePerson(c: Client, id: string): Promise<AudienceMember | null> {
  const r = await c.call("GET", `/api/v1/people/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  const p = r.body as AudienceMember;
  return { id: p.id, name: p.name, email: p.email, phone: p.phone, userId: p.userId, emails: p.emails ?? [], phones: p.phones ?? [], traits: p.traits ?? {} };
}

/** POST /api/v1/events with source messages; up to 1000 at once. */
export async function audienceEvents(c: Client, events: unknown[]) {
  const r = await c.call("POST", "/api/v1/events", undefined, { events });
  if (r.status === 404) throw new LinkError("Audience does not take POST /api/v1/events at this address.", 404, true);
}
