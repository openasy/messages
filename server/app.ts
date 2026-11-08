import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import type { Actor } from "./core.ts";
import { MsgError, type ProblemCode } from "./errors.ts";
import { audienceSegments, LinkError } from "./links.ts";
import { log as defaultLog } from "./log.ts";
import type { Messages } from "./messages.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";

export interface AppOptions {
  db: DatabaseSync;
  messages: Messages;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
  /** Where request logs go; tests pass one that drops them. */
  log?: typeof defaultLog;
}

function metricsText(m: Messages, version: string) {
  return renderMetrics(version, { ...m.gauges(), fileError: !!m.settings().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (MESSAGES_METRICS_PORT). */
export function createMetricsHandler(m: Messages, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(m, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

/** The team's pages run nothing from elsewhere. Template previews are shown in a sandboxed frame. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src 'self' data:; frame-ancestors 'none'`,
};

/** The pages people open from a message: no script at all, styles inline, a form that posts to itself. */
const PUBLIC_PAGE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data));

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "invalid-signature": "Invalid signature",
  "not-found": "Not found",
  conflict: "Conflict",
  "not-configured": "Not configured",
  "payload-too-large": "Payload too large",
  "upstream-error": "Linked product or provider error",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new MsgError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Reads a JSON body of up to `limit` bytes. */
async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const text = (await readBody(req, limit)).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new MsgError(400, "invalid-json", "The body must be JSON.");
  }
}

/** Fields from the query and a JSON or form body: what SMS providers push, in whichever way they do. */
async function readFields(req: IncomingMessage, url: URL): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = Object.fromEntries(url.searchParams);
  if (req.method !== "POST") return fields;
  const text = (await readBody(req, 64 * 1024)).toString("utf8").trim();
  if (!text) return fields;
  if (text.startsWith("{")) {
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(fields, v);
    } catch {
      throw new MsgError(400, "invalid-json", "The body must be JSON or a form.");
    }
  } else Object.assign(fields, Object.fromEntries(new URLSearchParams(text)));
  return fields;
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A 1x1 transparent GIF, for the open pixel. */
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** The role a route needs (ADR 0003); "none" for the version. */
type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  who: Actor;
  body: () => Promise<unknown>;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  /** Largest JSON body taken, in bytes. Default 1 MiB. */
  limit?: number;
  handle: (ctx: Ctx) => unknown;
}

export function createApp({
  db,
  messages: m,
  version,
  auth,
  adminToken,
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
  log = defaultLog,
}: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };
  const days = (url: URL) => {
    const d = Number(url.searchParams.get("days") ?? 30);
    if (![7, 14, 30, 90].includes(d)) throw new MsgError(422, "invalid-body", "days is 7, 14, 30 or 90.");
    return d;
  };
  const created = (res: ServerResponse, v: unknown) => json(res, 201, v);
  const upstream = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof LinkError) throw new MsgError(err.permanent ? 409 : 502, err.permanent ? "not-configured" : "upstream-error", err.message);
      throw err;
    }
  };

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "messages", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: () => m.summary() },
    // The settings, as the file sets them. There is no route that changes them.
    { method: "GET", path: "/api/v1/settings", auth: "viewer", handle: () => m.settings() },
    { method: "GET", path: "/api/v1/hooks", auth: "admin", handle: () => m.hookUrls() },
    { method: "GET", path: "/api/v1/overview", auth: "viewer", handle: ({ url }) => m.overview(days(url)) },

    // Templates and lists.
    { method: "GET", path: "/api/v1/templates", auth: "viewer", handle: () => ({ templates: m.templates.list() }) },
    { method: "POST", path: "/api/v1/templates", auth: "editor", handle: async ({ res, body }) => created(res, m.templates.create(await body())) },
    {
      method: "POST",
      path: "/api/v1/templates/sync",
      auth: "editor",
      handle: async () => m.templates.syncWhatsApp(m.core.senders().whatsapp as Parameters<typeof m.templates.syncWhatsApp>[0]),
    },
    { method: "GET", path: "/api/v1/templates/:id", auth: "viewer", handle: ({ params }) => m.templates.get(params[0]!) },
    { method: "PATCH", path: "/api/v1/templates/:id", auth: "editor", handle: async ({ params, body }) => m.templates.update(params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/templates/:id", auth: "editor", handle: ({ res, params }) => (m.templates.remove(params[0]!), noContent(res)) },
    {
      method: "POST",
      path: "/api/v1/templates/:id/preview",
      auth: "viewer",
      handle: async ({ params, body }) => m.templates.preview(params[0]!, await body()),
    },
    { method: "GET", path: "/api/v1/lists", auth: "viewer", handle: () => ({ lists: m.lists.list() }) },
    {
      method: "POST",
      path: "/api/v1/lists",
      auth: "editor",
      limit: 32 * 1024 * 1024,
      handle: async ({ res, who, body }) => created(res, m.lists.importCsv(who, await body())),
    },
    { method: "DELETE", path: "/api/v1/lists/:id", auth: "editor", handle: ({ res, params }) => (m.lists.remove(params[0]!), noContent(res)) },
    {
      method: "GET",
      path: "/api/v1/segments",
      auth: "viewer",
      handle: () => upstream(async () => ({ segments: await audienceSegments(m.links.client("audience")) })),
    },
    { method: "POST", path: "/api/v1/estimate", auth: "viewer", handle: async ({ body }) => m.campaigns.estimate(await body()) },

    // Campaigns.
    { method: "GET", path: "/api/v1/campaigns", auth: "viewer", handle: () => ({ campaigns: m.campaigns.list() }) },
    {
      method: "POST",
      path: "/api/v1/campaigns",
      auth: "editor",
      handle: async ({ res, who, body }) => created(res, await m.campaigns.create(who, await body())),
    },
    { method: "GET", path: "/api/v1/campaigns/:id", auth: "viewer", handle: ({ params }) => m.campaigns.get(params[0]!) },
    { method: "PATCH", path: "/api/v1/campaigns/:id", auth: "editor", handle: async ({ params, body }) => m.campaigns.update(params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/campaigns/:id", auth: "editor", handle: ({ res, params }) => (m.campaigns.remove(params[0]!), noContent(res)) },
    {
      method: "POST",
      path: "/api/v1/campaigns/:id/schedule",
      auth: "editor",
      handle: async ({ params, body }) => m.campaigns.schedule(params[0]!, await body()),
    },
    { method: "POST", path: "/api/v1/campaigns/:id/pause", auth: "editor", handle: ({ params }) => m.campaigns.pause(params[0]!) },
    {
      method: "GET",
      path: "/api/v1/campaigns/:id/messages",
      auth: "viewer",
      handle: ({ params, url }) => ({ messages: m.campaigns.messages(params[0]!, url.searchParams.get("state")) }),
    },

    // Journeys and the events that start them.
    { method: "GET", path: "/api/v1/journeys", auth: "viewer", handle: () => ({ journeys: m.journeys.list() }) },
    { method: "POST", path: "/api/v1/journeys", auth: "editor", handle: async ({ res, who, body }) => created(res, m.journeys.create(who, await body())) },
    { method: "GET", path: "/api/v1/journeys/:id", auth: "viewer", handle: ({ params }) => m.journeys.get(params[0]!) },
    { method: "PATCH", path: "/api/v1/journeys/:id", auth: "editor", handle: async ({ params, body }) => m.journeys.update(params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/journeys/:id", auth: "editor", handle: ({ res, params }) => (m.journeys.remove(params[0]!), noContent(res)) },
    { method: "POST", path: "/api/v1/journeys/:id/start", auth: "editor", handle: ({ params }) => m.journeys.start(params[0]!) },
    { method: "POST", path: "/api/v1/journeys/:id/pause", auth: "editor", handle: ({ params }) => m.journeys.pause(params[0]!) },
    { method: "POST", path: "/api/v1/events", auth: "editor", handle: async ({ body }) => m.journeys.events(await body()) },

    // Bounces, opt-outs and erasure.
    { method: "GET", path: "/api/v1/bounces", auth: "viewer", handle: () => ({ bounces: m.people.listBounces() }) },
    {
      method: "DELETE",
      path: "/api/v1/bounces/:id",
      auth: "editor",
      handle: ({ res, params, who }) => {
        const id = Number(params[0]);
        if (!Number.isInteger(id) || !m.people.clearBounce(id, who)) throw new MsgError(404, "not-found", "The bounce does not exist.");
        noContent(res);
      },
    },
    { method: "GET", path: "/api/v1/optouts", auth: "viewer", handle: () => ({ optouts: m.people.listOptOuts() }) },
    { method: "POST", path: "/api/v1/erasures", auth: "admin", handle: async ({ who, body }) => m.people.erase(await body(), who) },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  function authorize(req: IncomingMessage, access: Access): Actor {
    if (access === "none") return { id: "anonymous", name: "Anonymous" };
    if (tokenMatches(req.headers.authorization, adminToken)) return { id: "admin-token", name: "Admin token" };
    const p = auth.authorize(req, access);
    return p.kind === "session" ? { id: p.user.id, name: p.user.name } : { id: `token:${p.tokenId}`, name: p.name };
  }

  /** The routes people and providers reach without signing in: tracking, unsubscribe and webhooks. */
  async function publicRoute(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<string | null> {
    let x: RegExpExecArray | null;
    if ((x = /^\/o\/([A-Za-z0-9_-]+)\.gif$/.exec(path)) && req.method === "GET") {
      m.results.open(x[1]!);
      res.writeHead(200, { "content-type": "image/gif", "content-length": PIXEL.length, "cache-control": "no-store, max-age=0" }).end(PIXEL);
      return "/o/{id}.gif";
    }
    if ((x = /^\/c\/([A-Za-z0-9_-]+)\/(\d{1,3})$/.exec(path)) && req.method === "GET") {
      const to = m.results.click(x[1]!, Number(x[2]));
      if (!to) problem(res, 404, "not-found", "This link is not valid any more.");
      else res.writeHead(302, { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
      return "/c/{id}/{n}";
    }
    if ((x = /^\/u\/([A-Za-z0-9_-]+)$/.exec(path)) && (req.method === "GET" || req.method === "POST")) {
      if (req.method === "POST") await readBody(req, 4096).catch(() => Buffer.alloc(0));
      const r = req.method === "POST" ? m.results.unsubscribe(x[1]!) : m.results.unsubscribePage(x[1]!, false);
      const body = Buffer.from(r.html);
      res.writeHead(r.status, { ...PUBLIC_PAGE_HEADERS, "content-type": "text/html; charset=utf-8", "content-length": body.length }).end(body);
      return "/u/{id}";
    }
    if (path === "/hooks/ses" && req.method === "POST") {
      const r = await m.hooks.ses((await readBody(req, 256 * 1024)).toString("utf8"));
      json(res, r.status, r.body);
      return "/hooks/ses";
    }
    if ((x = /^\/hooks\/sms\/([A-Za-z0-9_-]+)(\/inbound)?$/.exec(path)) && (req.method === "POST" || req.method === "GET")) {
      const fields = await readFields(req, url);
      json(res, 200, x[2] ? m.hooks.smsInbound(x[1]!, fields) : m.hooks.smsReport(x[1]!, fields));
      return x[2] ? "/hooks/sms/{secret}/inbound" : "/hooks/sms/{secret}";
    }
    if (path === "/hooks/whatsapp" && req.method === "GET") {
      send(res, 200, m.hooks.whatsappVerify(url.searchParams), "text/plain");
      return "/hooks/whatsapp";
    }
    if (path === "/hooks/whatsapp" && req.method === "POST") {
      const raw = await readBody(req, 1024 * 1024);
      json(res, 200, m.hooks.whatsapp(raw, req.headers["x-hub-signature-256"] as string | undefined));
      return "/hooks/whatsapp";
    }
    return null;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        if (!m.config()) throw new Error("no settings");
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "not ready" });
      }
      return "/readyz";
    }

    if (path === "/metrics") {
      // Not even the web UI's fallback answers here when metrics have their own port.
      if (serveMetrics) send(res, 200, metricsText(m, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path.startsWith("/o/") || path.startsWith("/c/") || path.startsWith("/u/") || path.startsWith("/hooks/")) {
      try {
        const name = await publicRoute(req, res, url, path);
        if (name) return name;
      } catch (err) {
        if (!(err instanceof MsgError)) throw err;
        problem(res, err.status, err.code, err.message);
        if (!req.complete) req.resume();
        return path.split("/").slice(0, 3).join("/");
      }
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const match = path.match(r.re);
      if (!match || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        const params = match.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, who, body: () => readJson(req, r.limit ?? 1024 * 1024) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof MsgError)) throw err;
        problem(res, err.status, err.code, err.message);
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: (req.url ?? "/").split("?")[0] });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // Opens, clicks and unsubscribes carry a message id; they are counted, not logged one by one.
    if (!["/healthz", "/metrics", "/o/{id}.gif", "/c/{id}/{n}", "/u/{id}"].includes(routeName)) {
      log("info", "request", {
        method: req.method,
        path: routeName.startsWith("/hooks/sms") ? routeName : (req.url ?? "/").split("?")[0],
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
      });
    }
  };
}
