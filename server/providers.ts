// One interface per channel, so the dispatcher does not know which provider is behind it. Each provider's client
// follows that provider's documented API and is tested against a fake of it (server/fakes.ts); none has reached the
// real service from here.
//
// A send ends in one of three ways, and the difference is what keeps a person from getting a message twice:
//   - it was accepted: the provider's id comes back;
//   - SendError "retry" or "refused": the provider surely did not take it (it could not be reached, or answered with
//     an error before taking it), so it may be tried again, or through the fallback;
//   - SendError "unknown": the request may have reached the provider (a timeout after it was sent, a connection lost
//     while it answered). It is never sent again; the message is shown as unknown.
import type { Channel } from "./config.ts";
import type { OutEmail } from "./mime.ts";

export type Outcome = "retry" | "refused" | "unknown";

export class SendError extends Error {
  readonly outcome: Outcome;
  /** The address or number does not exist: a hard bounce, never sent to again until fixed. */
  readonly hard: boolean;
  constructor(message: string, outcome: Outcome, hard = false) {
    super(message);
    this.outcome = outcome;
    this.hard = hard;
  }
}

export interface Sent {
  /** The provider's id for the message, which its delivery reports and webhooks name. */
  providerId: string;
}

export interface EmailSender {
  channel: "email";
  kind: "ses" | "smtp";
  send(m: OutEmail): Promise<Sent>;
}

export interface OutSms {
  id: string;
  /** E.164, such as +905551112233. */
  to: string;
  text: string;
}

/** A delivery report read back from an SMS provider. */
export interface SmsReport {
  providerId: string;
  /** The number, E.164, when the provider names it. */
  to: string | null;
  state: "delivered" | "failed" | "waiting";
  /** The number does not exist or is out of service. */
  hard: boolean;
  reason: string | null;
}

export interface SmsSender {
  channel: "sms";
  kind: "netgsm" | "iletimerkezi";
  send(m: OutSms): Promise<Sent>;
  /** Reads the delivery reports of messages sent earlier. */
  reports(providerIds: string[]): Promise<SmsReport[]>;
}

export interface OutWhatsApp {
  id: string;
  to: string;
  /** The approved template's name and language at Meta, and the texts for its {{1}}, {{2}}... in the body. */
  template: string;
  lang: string;
  params: string[];
}

export interface WaTemplate {
  name: string;
  language: string;
  status: string;
  category: string | null;
  body: string | null;
}

export interface WhatsAppSender {
  channel: "whatsapp";
  kind: "whatsapp";
  send(m: OutWhatsApp): Promise<Sent>;
  templates(): Promise<WaTemplate[]>;
}

export type Sender = EmailSender | SmsSender | WhatsAppSender;
export const isChannel = (s: Sender, c: Channel) => s.channel === c;

/**
 * A JSON request to a provider's HTTP API, with the outcome rules above: no answer before the request was written is
 * retry; a timeout or a lost connection after it is unknown; 429 and 5xx are retry; another 4xx is refused.
 */
export async function providerFetch(
  http: typeof fetch,
  name: string,
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<{ status: number; body: unknown; text: string }> {
  let res: Response;
  try {
    res = await http(url, { ...init, redirect: "error", signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const code = e.cause?.code ?? "";
    // Refused, not found or unreachable: the request never left, so nothing was sent.
    if (/^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|CERT_|ERR_TLS|UNABLE_TO|DEPTH_ZERO)/.test(code))
      throw new SendError(`${name} could not be reached (${code}).`, "retry");
    throw new SendError(
      e.name === "TimeoutError" ? `${name} did not answer within the time.` : `${name}: the connection was lost (${code || e.message}).`,
      "unknown",
    );
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new SendError(`${name}: the connection was lost while it answered.`, res.ok ? "unknown" : "retry");
  }
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // some answer in plain text or XML
  }
  return { status: res.status, body, text };
}
