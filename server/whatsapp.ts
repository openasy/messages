// The WhatsApp Business Cloud API (Graph API). Marketing messages go only as templates Meta approved:
// POST /{phone-number-id}/messages with type template, answered { messages: [{ id: "wamid..." }] }. Templates and
// their approval are read from GET /{waba-id}/message_templates. Statuses (sent, delivered, read, failed), replies
// and template approvals arrive at the webhook, whose X-Hub-Signature-256 is checked with the app secret before
// anything in it is read. Written from Meta's documentation and tested against a fake; never called for real here.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { WhatsAppProvider } from "./config.ts";
import { providerFetch, SendError, type OutWhatsApp, type WaTemplate, type WhatsAppSender } from "./providers.ts";

export const GRAPH = "https://graph.facebook.com/v21.0";

/** Meta's error codes that mean try again later: rate limits and pair rate limits. */
const RETRY_CODES = new Set([4, 80007, 130429, 131048, 131056, 131000, 2]);

export function createWhatsAppSender(p: WhatsAppProvider, env: Record<string, string | undefined>, http: typeof fetch = fetch): WhatsAppSender {
  const base = p.endpoint ?? GRAPH;
  const token = () => {
    const t = env[p.token];
    if (!t) throw new SendError(`${p.token} is not set, so Messages has no WhatsApp token.`, "retry");
    return t;
  };
  return {
    channel: "whatsapp",
    kind: "whatsapp",
    async send(m: OutWhatsApp) {
      const body = JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: m.to.replace(/^\+/, ""),
        type: "template",
        template: {
          name: m.template,
          language: { code: m.lang },
          ...(m.params.length && { components: [{ type: "body", parameters: m.params.map((text) => ({ type: "text", text })) }] }),
        },
      });
      const r = await providerFetch(http, "WhatsApp", `${base}/${p.phoneNumberId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
        body,
      });
      const id = (r.body as { messages?: Array<{ id?: string }> } | null)?.messages?.[0]?.id;
      if (r.status === 200 && id) return { providerId: id };
      const err = (r.body as { error?: { code?: number; message?: string; error_data?: { details?: string } } } | null)?.error;
      const msg = `WhatsApp answered ${r.status}${err ? ` (${err.code}): ${err.error_data?.details ?? err.message}` : ""}`;
      if (r.status >= 500 || r.status === 429 || (err?.code !== undefined && RETRY_CODES.has(err.code))) throw new SendError(msg, "retry");
      if (r.status === 200) throw new SendError(`${msg} (no message id)`, "unknown");
      throw new SendError(msg, "refused", err?.code === 131026);
    },
    async templates() {
      const out: WaTemplate[] = [];
      let url: string | null = `${base}/${p.businessAccountId}/message_templates?fields=name,status,language,category,components&limit=200`;
      for (let page = 0; url && page < 20; page++) {
        const r = await providerFetch(http, "WhatsApp", url, { method: "GET", headers: { authorization: `Bearer ${token()}` } });
        if (r.status !== 200) throw new SendError(`WhatsApp answered ${r.status} for the templates.`, "retry");
        const b = r.body as {
          data?: Array<{ name: string; status: string; language: string; category?: string; components?: Array<{ type: string; text?: string }> }>;
          paging?: { next?: string };
        };
        for (const t of b.data ?? [])
          out.push({
            name: t.name,
            language: t.language,
            status: t.status,
            category: t.category ?? null,
            body: t.components?.find((c) => c.type === "BODY")?.text ?? null,
          });
        // Only follow paging links on the same host.
        const next = b.paging?.next ? URL.parse(b.paging.next) : null;
        url = next && next.origin === new URL(base).origin ? next.href : null;
      }
      return out;
    },
  };
}

/** Whether X-Hub-Signature-256 is sha256=<HMAC-SHA256 of the raw body with the app secret>. */
export function whatsappSignatureOk(raw: Buffer, header: string | undefined, appSecret: string | undefined): boolean {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(raw).digest();
  const given = Buffer.from(header.slice(7), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type WaEvent =
  | { kind: "status"; providerId: string; status: "sent" | "delivered" | "read" | "failed"; to: string; reason: string | null; hard: boolean }
  | { kind: "reply"; from: string; text: string }
  | { kind: "template"; name: string; language: string; status: string; reason: string | null };

/** What a webhook payload says, in order. Unknown parts are left out. */
export function readWhatsAppWebhook(payload: unknown): WaEvent[] {
  const out: WaEvent[] = [];
  const entries = (payload as { entry?: unknown[] } | null)?.entry;
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const change of ((entry as { changes?: unknown[] }).changes ?? []) as Array<{ field?: string; value?: Record<string, any> }>) {
      const v = change.value ?? {};
      if (change.field === "messages") {
        for (const s of (v.statuses ?? []) as Array<Record<string, any>>) {
          if (!["sent", "delivered", "read", "failed"].includes(s.status)) continue;
          const e = s.errors?.[0];
          out.push({
            kind: "status",
            providerId: String(s.id),
            status: s.status,
            to: `+${String(s.recipient_id ?? "").replace(/\D/g, "")}`,
            reason: e ? `WhatsApp (${e.code}): ${e.error_data?.details ?? e.title ?? e.message ?? ""}`.trim() : null,
            hard: e?.code === 131026,
          });
        }
        for (const m of (v.messages ?? []) as Array<Record<string, any>>) {
          const text = m.text?.body ?? m.button?.text ?? m.button?.payload ?? m.interactive?.button_reply?.title ?? null;
          if (typeof text === "string" && m.from) out.push({ kind: "reply", from: `+${String(m.from).replace(/\D/g, "")}`, text });
        }
      }
      if (change.field === "message_template_status_update" && v.message_template_name)
        out.push({
          kind: "template",
          name: String(v.message_template_name),
          language: String(v.message_template_language ?? ""),
          status: String(v.event ?? ""),
          reason: v.reason && v.reason !== "NONE" ? String(v.reason) : null,
        });
    }
  }
  return out;
}
