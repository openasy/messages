// SMS through Netgsm or İleti Merkezi, one request per message so each has its own id to follow:
//   - Netgsm REST v2: POST /sms/rest/v2/send with basic auth and { msgheader, messages: [{ msg, no }], encoding, iysfilter },
//     answered { code: "00", jobid }; reports from POST /sms/rest/v2/report with { jobids }.
//   - İleti Merkezi v1: POST /v1/send-sms/json with { request: { authentication: { key, hash }, order } }, where hash is
//     HMAC-SHA256 of the key with the secret, answered { response: { status: { code: 200 }, order: { id } } }; reports
//     from POST /v1/get-report/json.
// Both are written from the providers' published documents and tested against fakes of them; neither has been called
// for real from here.
import { createHmac } from "node:crypto";
import type { IletiMerkeziProvider, NetgsmProvider, SmsProvider } from "./config.ts";
import { providerFetch, SendError, type OutSms, type SmsReport, type SmsSender } from "./providers.ts";

/** A number as Turkish SMS providers take it: 905551112233, or 00 and the number abroad. */
export const smsNumber = (e164: string) => (e164.startsWith("+90") ? e164.slice(1) : `00${e164.slice(1)}`);
const fromSmsNumber = (n: string) => {
  const d = n.replace(/\D/g, "");
  if (d.startsWith("00")) return `+${d.slice(2)}`;
  if (d.length === 10 && d.startsWith("5")) return `+90${d}`;
  if (d.startsWith("0") && d.length === 11) return `+90${d.slice(1)}`;
  return `+${d}`;
};

/** Netgsm's report states: 0 waiting, 1 delivered, 3 a wrong or closed number; the rest did not arrive. */
export function netgsmState(status: number | string): Pick<SmsReport, "state" | "hard" | "reason"> {
  const s = Number(status);
  if (s === 0) return { state: "waiting", hard: false, reason: null };
  if (s === 1) return { state: "delivered", hard: false, reason: null };
  const reasons: Record<number, string> = {
    2: "Netgsm: timed out before it arrived",
    3: "Netgsm: number not in service",
    4: "Netgsm: not handed to the operator",
    11: "Netgsm: the operator did not take it",
    12: "Netgsm: sending failed",
    13: "Netgsm: the same message twice",
    15: "Netgsm: the number is on the blacklist",
    16: "Netgsm: İYS has no consent for this number",
  };
  return { state: "failed", hard: s === 3, reason: reasons[s] ?? `Netgsm: status ${s}` };
}

/** İleti Merkezi's report states: 110 waiting, 111 delivered, 112 not delivered. */
export function iletiState(status: number | string): Pick<SmsReport, "state" | "hard" | "reason"> {
  const s = Number(status);
  if (s === 110) return { state: "waiting", hard: false, reason: null };
  if (s === 111) return { state: "delivered", hard: false, reason: null };
  return { state: "failed", hard: false, reason: `İleti Merkezi: not delivered (${s})` };
}

function netgsm(p: NetgsmProvider, env: Record<string, string | undefined>, http: typeof fetch): SmsSender {
  const base = p.endpoint ?? "https://api.netgsm.com.tr";
  const auth = () => {
    const user = env[p.user];
    const password = env[p.password];
    if (!user || !password) throw new SendError(`${!user ? p.user : p.password} is not set, so Messages cannot sign in to Netgsm.`, "retry");
    return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  };
  return {
    channel: "sms",
    kind: "netgsm",
    async send(m: OutSms) {
      const body = JSON.stringify({
        msgheader: p.sender,
        messages: [{ msg: m.text, no: smsNumber(m.to) }],
        encoding: "TR",
        // 11: a commercial message to an individual, sent only where İYS has consent.
        iysfilter: p.iys ? "11" : "",
      });
      const r = await providerFetch(http, "Netgsm", `${base}/sms/rest/v2/send`, {
        method: "POST",
        headers: { authorization: auth(), "content-type": "application/json" },
        body,
      });
      const b = (r.body ?? {}) as { code?: string; jobid?: string; description?: string };
      if (r.status === 200 && b.code === "00" && b.jobid) return { providerId: String(b.jobid) };
      const msg = `Netgsm answered ${r.status} code ${b.code ?? "?"}${b.description ? `: ${b.description}` : ""}`;
      if (r.status >= 500 || r.status === 429 || b.code === "80" || b.code === "85") throw new SendError(msg, "retry");
      if (r.status === 200 && !b.code) throw new SendError(`${msg} (no job id)`, "unknown");
      throw new SendError(msg, "refused");
    },
    async reports(ids: string[]) {
      if (!ids.length) return [];
      const r = await providerFetch(http, "Netgsm", `${base}/sms/rest/v2/report`, {
        method: "POST",
        headers: { authorization: auth(), "content-type": "application/json" },
        body: JSON.stringify({ jobids: ids }),
      });
      const jobs = ((r.body as { jobs?: unknown[] } | null)?.jobs ?? []) as Array<{ jobid?: string; telno?: string; status?: number | string }>;
      return jobs
        .filter((j) => j.jobid)
        .map((j) => ({ providerId: String(j.jobid), to: j.telno ? fromSmsNumber(String(j.telno)) : null, ...netgsmState(j.status ?? 0) }));
    },
  };
}

function iletiMerkezi(p: IletiMerkeziProvider, env: Record<string, string | undefined>, http: typeof fetch): SmsSender {
  const base = p.endpoint ?? "https://api.iletimerkezi.com";
  const authentication = () => {
    const key = env[p.key];
    const secret = env[p.secret];
    if (!key || !secret) throw new SendError(`${!key ? p.key : p.secret} is not set, so Messages cannot sign in to İleti Merkezi.`, "retry");
    return { key, hash: createHmac("sha256", secret).update(key).digest("hex") };
  };
  return {
    channel: "sms",
    kind: "iletimerkezi",
    async send(m: OutSms) {
      const body = JSON.stringify({
        request: {
          authentication: authentication(),
          order: {
            sender: p.sender,
            sendDateTime: [],
            ...(p.iys && { iys: "1", iysList: "BIREYSEL" }),
            message: { text: m.text, receipents: { number: [smsNumber(m.to)] } },
          },
        },
      });
      const r = await providerFetch(http, "İleti Merkezi", `${base}/v1/send-sms/json`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const resp = (r.body as { response?: { status?: { code?: string | number; message?: string }; order?: { id?: string | number } } } | null)?.response;
      const code = Number(resp?.status?.code ?? r.status);
      if (code === 200 && resp?.order?.id !== undefined) return { providerId: String(resp.order.id) };
      const msg = `İleti Merkezi answered ${code}${resp?.status?.message ? `: ${resp.status.message}` : ""}`;
      if (r.status >= 500 || code >= 500 || r.status === 429) throw new SendError(msg, "retry");
      if (code === 200) throw new SendError(`${msg} (no order id)`, "unknown");
      throw new SendError(msg, "refused", code === 452);
    },
    async reports(ids: string[]) {
      const out: SmsReport[] = [];
      for (const id of ids) {
        const r = await providerFetch(http, "İleti Merkezi", `${base}/v1/get-report/json`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request: { authentication: authentication(), order: { id, page: 1, rowCount: 1000 } } }),
        });
        const order = (r.body as { response?: { order?: { message?: Array<{ number?: string; status?: string | number }> } } } | null)?.response?.order;
        for (const m of order?.message ?? [])
          out.push({ providerId: id, to: m.number ? fromSmsNumber(String(m.number)) : null, ...iletiState(m.status ?? 110) });
      }
      return out;
    },
  };
}

export function createSmsSender(p: SmsProvider, env: Record<string, string | undefined>, http: typeof fetch = fetch): SmsSender {
  return p.kind === "netgsm" ? netgsm(p, env, http) : iletiMerkezi(p, env, http);
}

/** A delivery report pushed to /hooks/sms/<secret>, as either provider names its fields. */
export function readSmsPush(kind: SmsProvider["kind"], fields: Record<string, unknown>): SmsReport | null {
  const pick = (...names: string[]) => names.map((n) => fields[n]).find((v) => v !== undefined && v !== null && v !== "");
  const id = pick("jobid", "bulkid", "orderId", "order_id", "id", "packet_id");
  const status = pick("status", "durum", "state");
  if (id === undefined || status === undefined) return null;
  const to = pick("telno", "gsmno", "number", "to", "phone");
  return {
    providerId: String(id),
    to: to === undefined ? null : fromSmsNumber(String(to)),
    ...(kind === "netgsm" ? netgsmState(status as string) : iletiState(status as string)),
  };
}

/** An SMS someone sent back, pushed to /hooks/sms/<secret>/inbound: the number and the words. */
export function readSmsInbound(fields: Record<string, unknown>): { from: string; text: string } | null {
  const pick = (...names: string[]) => names.map((n) => fields[n]).find((v) => typeof v === "string" && v.trim() !== "") as string | undefined;
  const from = pick("gsmno", "from", "number", "phone", "telno", "sender");
  const text = pick("msg", "message", "text", "body", "content");
  return from && text !== undefined ? { from: fromSmsNumber(from), text } : null;
}

/** The words that stop messages: STOP, RET, İPTAL and the like, alone or first in the reply. */
export function isStop(text: string): boolean {
  const first = text.trim().split(/\s+/)[0] ?? "";
  const w = first.toLocaleUpperCase("tr").replace(/[.!]/g, "");
  return ["STOP", "RET", "İPTAL", "IPTAL", "DUR", "UNSUBSCRIBE", "ABMELDEN", "HAYIR"].includes(w);
}
