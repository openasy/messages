// Amazon SNS, which carries SES's events to Messages. Every message is checked before it is read: its signature
// (SignatureVersion 1, SHA1withRSA, or 2, SHA256withRSA) against the certificate at SigningCertURL, which must be an
// https address of sns.<region>.amazonaws.com; and its topic, when the file names one. A subscription is confirmed by
// opening its SubscribeURL, which must be on the same kind of host.
import { createVerify } from "node:crypto";

export interface SnsMessage {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
}

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export function snsHostOk(raw: string | undefined): boolean {
  const url = raw ? URL.parse(raw) : null;
  return !!url && url.protocol === "https:" && SNS_HOST.test(url.hostname);
}

/** The text SNS signed, field by field in its documented order. */
export function snsStringToSign(m: SnsMessage): string {
  const fields =
    m.Type === "Notification"
      ? ["Message", "MessageId", ...(m.Subject !== undefined ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return fields.map((f) => `${f}\n${(m as unknown as Record<string, string>)[f] ?? ""}\n`).join("");
}

export class SnsError extends Error {}

/** Certificates by address, kept for a day; SNS signs with few. */
const certs = new Map<string, { pem: string; at: number }>();

/** Checks a message and returns it, or throws SnsError saying why it is refused. */
export async function verifySns(raw: unknown, topic: string | null, http: typeof fetch = fetch): Promise<SnsMessage> {
  const m = raw as SnsMessage;
  if (!m || typeof m !== "object" || typeof m.Type !== "string" || typeof m.Signature !== "string" || typeof m.Message !== "string")
    throw new SnsError("Not an SNS message.");
  if (!["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"].includes(m.Type))
    throw new SnsError(`SNS message type ${m.Type} is not handled.`);
  if (topic && m.TopicArn !== topic) throw new SnsError(`The SNS topic ${m.TopicArn} is not the one in messages.yaml.`);
  if (m.SignatureVersion !== "1" && m.SignatureVersion !== "2") throw new SnsError("Unknown SNS SignatureVersion.");
  if (!snsHostOk(m.SigningCertURL) || !new URL(m.SigningCertURL).pathname.endsWith(".pem"))
    throw new SnsError("SigningCertURL is not an SNS certificate address.");
  // Messages older than an hour are refused, so a captured one cannot be sent again much later.
  const age = Date.now() - Date.parse(m.Timestamp);
  if (!(age < 3_600_000 && age > -300_000)) throw new SnsError("The SNS message is too old or from the future.");
  let cert = certs.get(m.SigningCertURL);
  if (!cert || Date.now() - cert.at > 86_400_000) {
    const res = await http(m.SigningCertURL, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new SnsError(`The SNS certificate could not be read (${res.status}).`);
    cert = { pem: await res.text(), at: Date.now() };
    certs.set(m.SigningCertURL, cert);
  }
  const ok = createVerify(m.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256")
    .update(snsStringToSign(m), "utf8")
    .verify(cert.pem, m.Signature, "base64");
  if (!ok) throw new SnsError("The SNS signature does not match.");
  return m;
}

/** What one SES event says about a message, from either event publishing (eventType) or notifications (notificationType). */
export interface SesEvent {
  messageId: string;
  kind: "delivery" | "bounce" | "complaint" | "reject" | "other";
  hard: boolean;
  recipients: string[];
  reason: string;
}

export function readSesEvent(message: string): SesEvent | null {
  let e: Record<string, any>;
  try {
    e = JSON.parse(message);
  } catch {
    return null;
  }
  const type = String(e.eventType ?? e.notificationType ?? "");
  const messageId = e.mail?.messageId;
  if (typeof messageId !== "string") return null;
  if (type === "Delivery")
    return { messageId, kind: "delivery", hard: false, recipients: e.delivery?.recipients ?? [], reason: String(e.delivery?.smtpResponse ?? "Delivered") };
  if (type === "Bounce") {
    const b = e.bounce ?? {};
    const rec = (b.bouncedRecipients ?? []) as Array<{ emailAddress?: string; diagnosticCode?: string; status?: string }>;
    return {
      messageId,
      kind: "bounce",
      hard: b.bounceType === "Permanent",
      recipients: rec.map((r) => String(r.emailAddress ?? "").toLowerCase()).filter(Boolean),
      reason: rec[0]?.diagnosticCode ?? `${b.bounceType ?? "Bounce"}: ${b.bounceSubType ?? ""}`.trim(),
    };
  }
  if (type === "Complaint") {
    const c = e.complaint ?? {};
    return {
      messageId,
      kind: "complaint",
      hard: false,
      recipients: ((c.complainedRecipients ?? []) as Array<{ emailAddress?: string }>).map((r) => String(r.emailAddress ?? "").toLowerCase()).filter(Boolean),
      reason: `Marked as spam${c.complaintFeedbackType ? ` (${c.complaintFeedbackType})` : ""}`,
    };
  }
  if (type === "Reject") return { messageId, kind: "reject", hard: false, recipients: [], reason: String(e.reject?.reason ?? "Rejected by SES") };
  return { messageId, kind: "other", hard: false, recipients: [], reason: type };
}
