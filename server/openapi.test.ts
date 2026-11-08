import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { one } from "./core.ts";
import { ADMIN_TOKEN, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "messages-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method, redirect: "manual" });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    await res.arrayBuffer();
    return { res, body: undefined as any };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();
  if (type === "image/gif") return { res, body: await res.arrayBuffer() };
  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body: body as any };
}

const admin = (b?: unknown) => ({
  headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
  ...(b !== undefined && { body: typeof b === "string" ? b : JSON.stringify(b) }),
});

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    expect((await fetch(`${base}/api/docs/`)).headers.get("content-type")).toContain("text/html");
  });
});

describe("responses match openapi.json", () => {
  const ids: Record<string, string> = {};

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/settings", admin());
    await call("GET", "/api/v1/hooks", admin());
    await call("GET", "/api/v1/overview", admin(), "/api/v1/overview?days=30");
    await call("GET", "/api/v1/overview", admin(), "/api/v1/overview?days=3");
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("templates and lists", async () => {
    const t = await call(
      "POST",
      "/api/v1/templates",
      admin({ name: "welcome-tr", channel: "email", subject: "Hoş geldiniz {{first_name}}", body: "Merhaba https://www.example.com" }),
    );
    ids.template = t.body.id;
    const sms = await call("POST", "/api/v1/templates", admin({ name: "day3-sms", channel: "sms", body: "Merhaba {{first_name}}" }));
    ids.sms = sms.body.id;
    await call("POST", "/api/v1/templates", admin({ name: "welcome-tr", channel: "email", subject: "x", body: "x" }));
    await call("POST", "/api/v1/templates", admin({ name: "Bad Name", channel: "email" }));
    await call("POST", "/api/v1/templates", admin("{"));
    await call("POST", "/api/v1/templates", { body: "{}" });
    await call("GET", "/api/v1/templates", admin());
    await call("GET", "/api/v1/templates/{id}", admin(), `/api/v1/templates/${ids.template}`);
    await call("GET", "/api/v1/templates/{id}", admin(), "/api/v1/templates/missing");
    await call("PATCH", "/api/v1/templates/{id}", admin({ subject: "Hoş geldiniz, {{first_name|dostum}}" }), `/api/v1/templates/${ids.template}`);
    await call("PATCH", "/api/v1/templates/{id}", admin({ channel: "sms" }), `/api/v1/templates/${ids.template}`);
    await call("POST", "/api/v1/templates/{id}/preview", admin({}), `/api/v1/templates/${ids.template}/preview`);
    await call("POST", "/api/v1/templates/{id}/preview", admin({}), "/api/v1/templates/missing/preview");
    await call("POST", "/api/v1/templates/sync", admin());
    const l = await call("POST", "/api/v1/lists", admin({ name: "Webinar", csv: "email,phone,name\nokan@example.com,05321112233,Okan Tekin\n,,Nobody\n" }));
    ids.list = l.body.id;
    await call("POST", "/api/v1/lists", admin({ name: "Empty", csv: "name\nx\n" }));
    await call("GET", "/api/v1/lists", admin());
    await call("GET", "/api/v1/segments", admin());
    app.fakes.audience.fail(1, 500, {});
    await call("GET", "/api/v1/segments", admin());
    await call("POST", "/api/v1/estimate", admin({ channel: "email", audience: { kind: "list", id: ids.list } }));
    await call("POST", "/api/v1/estimate", admin({ channel: "fax" }));
  });

  it("campaigns", async () => {
    const c = await call(
      "POST",
      "/api/v1/campaigns",
      admin({
        name: "October newsletter",
        channel: "email",
        audience: { kind: "list", id: ids.list },
        templateId: ids.template,
        ab: { subject: "B", share: 20 },
      }),
    );
    ids.campaign = c.body.id;
    await call("POST", "/api/v1/campaigns", admin({ name: "x", channel: "sms", audience: { kind: "list", id: ids.list }, templateId: ids.template }));
    await call("GET", "/api/v1/campaigns", admin());
    await call("GET", "/api/v1/campaigns/{id}", admin(), `/api/v1/campaigns/${ids.campaign}`);
    await call("GET", "/api/v1/campaigns/{id}", admin(), "/api/v1/campaigns/missing");
    await call("PATCH", "/api/v1/campaigns/{id}", admin({ name: "October news" }), `/api/v1/campaigns/${ids.campaign}`);
    await call("PATCH", "/api/v1/campaigns/{id}", admin({ ab: { share: 90, subject: "B" } }), `/api/v1/campaigns/${ids.campaign}`);
    await call("POST", "/api/v1/campaigns/{id}/pause", admin(), `/api/v1/campaigns/${ids.campaign}/pause`);
    await call("POST", "/api/v1/campaigns/{id}/schedule", admin({ at: "soon" }), `/api/v1/campaigns/${ids.campaign}/schedule`);
    app.fakes.consent.allow("email", "okan@example.com");
    await call("POST", "/api/v1/campaigns/{id}/schedule", admin({}), `/api/v1/campaigns/${ids.campaign}/schedule`);
    await app.settle();
    await call("POST", "/api/v1/campaigns/{id}/pause", admin(), `/api/v1/campaigns/${ids.campaign}/pause`);
    await call("GET", "/api/v1/campaigns/{id}", admin(), `/api/v1/campaigns/${ids.campaign}`);
    await call("GET", "/api/v1/campaigns/{id}/messages", admin(), `/api/v1/campaigns/${ids.campaign}/messages`);
    await call("GET", "/api/v1/campaigns/{id}/messages", admin(), `/api/v1/campaigns/${ids.campaign}/messages?state=nope`);
    await call("DELETE", "/api/v1/campaigns/{id}", admin(), `/api/v1/campaigns/${ids.campaign}`);
    const d = await call(
      "POST",
      "/api/v1/campaigns",
      admin({ name: "Draft", channel: "email", audience: { kind: "list", id: ids.list }, templateId: ids.template }),
    );
    await call("DELETE", "/api/v1/campaigns/{id}", admin(), `/api/v1/campaigns/${d.body.id}`);
    await call("DELETE", "/api/v1/templates/{id}", admin(), `/api/v1/templates/${ids.template}`);
    await call("DELETE", "/api/v1/lists/{id}", admin(), `/api/v1/lists/${ids.list}`);
    await call("DELETE", "/api/v1/lists/{id}", admin(), "/api/v1/lists/missing");
  });

  it("tracking", async () => {
    const m = one<{ id: string }>(app.db, "SELECT id FROM messages LIMIT 1")!;
    await call("GET", "/o/{id}.gif", {}, `/o/${m.id}.gif`);
    await call("GET", "/c/{id}/{n}", {}, `/c/${m.id}/0`);
    await call("GET", "/c/{id}/{n}", {}, `/c/${m.id}/9`);
    await call("GET", "/u/{id}", {}, `/u/${m.id}`);
    await call("GET", "/u/{id}", {}, "/u/nothing-here-123");
    await call("POST", "/u/{id}", { body: "List-Unsubscribe=One-Click" }, `/u/${m.id}`);
    await call("POST", "/u/{id}", {}, "/u/nothing-here-123");
  });

  it("journeys and events", async () => {
    const j = await call(
      "POST",
      "/api/v1/journeys",
      admin({
        name: "Welcome",
        trigger: { kind: "event", event: "signup" },
        goal: { kind: "event", event: "invoice_sent" },
        steps: [
          { kind: "wait", minutes: 60 },
          { kind: "send", channel: "sms", templateId: ids.sms },
        ],
      }),
    );
    ids.journey = j.body.id;
    await call("POST", "/api/v1/journeys", admin({ name: "Bad", trigger: { kind: "event", event: "signup" }, steps: [] }));
    await call("GET", "/api/v1/journeys", admin());
    await call("GET", "/api/v1/journeys/{id}", admin(), `/api/v1/journeys/${ids.journey}`);
    await call("GET", "/api/v1/journeys/{id}", admin(), "/api/v1/journeys/missing");
    await call("PATCH", "/api/v1/journeys/{id}", admin({ name: "Welcome series" }), `/api/v1/journeys/${ids.journey}`);
    await call("PATCH", "/api/v1/journeys/{id}", admin({ steps: [{ kind: "nap" }] }), `/api/v1/journeys/${ids.journey}`);
    await call("POST", "/api/v1/journeys/{id}/pause", admin(), `/api/v1/journeys/${ids.journey}/pause`);
    await call("POST", "/api/v1/journeys/{id}/start", admin(), `/api/v1/journeys/${ids.journey}/start`);
    await call("POST", "/api/v1/journeys/{id}/start", admin(), `/api/v1/journeys/${ids.journey}/start`);
    await call("PATCH", "/api/v1/journeys/{id}", admin({ steps: [{ kind: "exit" }] }), `/api/v1/journeys/${ids.journey}`);
    await call("POST", "/api/v1/events", admin({ events: [{ type: "signup", person: { email: "gizem@example.com", name: "Gizem Avcı" } }] }));
    await call("POST", "/api/v1/events", admin({ events: [{ type: "signup", person: {} }] }));
    await call("POST", "/api/v1/journeys/{id}/pause", admin(), `/api/v1/journeys/${ids.journey}/pause`);
    await call("DELETE", "/api/v1/journeys/{id}", admin(), `/api/v1/journeys/${ids.journey}`);
    const d = await call("POST", "/api/v1/journeys", admin({ name: "Draft", trigger: { kind: "event", event: "x" }, steps: [{ kind: "exit" }] }));
    await call("DELETE", "/api/v1/journeys/{id}", admin(), `/api/v1/journeys/${d.body.id}`);
    await call("DELETE", "/api/v1/journeys/{id}", admin(), `/api/v1/journeys/${d.body.id}`);
  });

  it("bounces, opt-outs and erasure", async () => {
    app.messages.people.bounce("email", "gone@example.com", true, "550 5.1.1 user unknown", null, "ses");
    const b = await call("GET", "/api/v1/bounces", admin());
    await call("DELETE", "/api/v1/bounces/{id}", admin(), `/api/v1/bounces/${b.body.bounces[0].id}`);
    await call("DELETE", "/api/v1/bounces/{id}", admin(), "/api/v1/bounces/9999");
    await call("GET", "/api/v1/optouts", admin());
    await call(
      "POST",
      "/api/v1/erasures",
      admin({ reference: "KVKK-2026-031", product: "audience", people: { emails: ["okan@example.com"], phones: [], userIds: [] } }),
    );
    await call("POST", "/api/v1/erasures", admin({ people: [] }));
    await call("POST", "/api/v1/erasures", { body: "{}" });
  });

  it("webhooks", async () => {
    const hooks = (await (await fetch(`${base}/api/v1/hooks`, admin())).json()) as { smsReports: string };
    const sms = new URL(hooks.smsReports).pathname;
    await call("POST", "/hooks/ses", { body: "not json" });
    await call("POST", "/hooks/ses", {
      body: JSON.stringify({
        Type: "Notification",
        Message: "{}",
        Signature: "x",
        SignatureVersion: "2",
        SigningCertURL: "https://evil.example.com/a.pem",
        TopicArn: "x",
        Timestamp: new Date().toISOString(),
        MessageId: "1",
      }),
    });
    await call("GET", "/hooks/sms/{secret}", {}, `${sms}?jobid=1&status=1`);
    await call("GET", "/hooks/sms/{secret}", {}, "/hooks/sms/wrong?jobid=1&status=1");
    await call("POST", "/hooks/sms/{secret}", { body: JSON.stringify({ jobid: "1" }) }, sms);
    await call("GET", "/hooks/sms/{secret}/inbound", {}, `${sms}/inbound?gsmno=905551112233&msg=RET`);
    await call("POST", "/hooks/sms/{secret}/inbound", { body: "gsmno=905551112233&msg=Merhaba" }, `${sms}/inbound`);
    await call("GET", "/hooks/whatsapp", {}, "/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=wa-verify&hub.challenge=42");
    await call("GET", "/hooks/whatsapp", {}, "/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42");
    const payload = JSON.stringify({ entry: [] });
    await call("POST", "/hooks/whatsapp", {
      body: payload,
      headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", "wa-app-secret").update(payload).digest("hex")}` },
    });
    await call("POST", "/hooks/whatsapp", { body: payload, headers: { "x-hub-signature-256": "sha256=00" } });
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
