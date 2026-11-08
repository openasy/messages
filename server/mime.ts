// An email as one MIME message (RFC 5322, 2045, 2047): a text and an HTML part in UTF-8, each base64 in 76-character
// lines, the subject and names encoded where they are not ASCII. SMTP sends it as it is; SES takes it as raw content,
// so the List-Unsubscribe headers reach the inbox the same way through both.
import { randomBytes } from "node:crypto";

export interface OutEmail {
  /** Messages' own id, which the Message-ID header carries. */
  id: string;
  from: { name: string; email: string };
  replyTo: string | null;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** More headers, such as List-Unsubscribe; values are ASCII. */
  headers: Record<string, string>;
}

const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** A header value with non-ASCII words as RFC 2047 encoded words. */
export function encodeWord(s: string): string {
  if (ascii(s)) return s;
  // Encoded words are at most 75 characters; split the UTF-8 bytes on character boundaries.
  const words: string[] = [];
  let chunk = "";
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

/** "Name" <address>, with the name quoted or encoded as needed. */
export function mailbox(name: string, email: string): string {
  if (!name) return email;
  const n = ascii(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : encodeWord(name);
  return `${n} <${email}>`;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");

/** The domain of the sender, for Message-ID. */
const domainOf = (email: string) => email.split("@")[1] ?? "localhost";

/** The whole message, with CRLF line ends. `date` is for tests. */
export function buildMime(m: OutEmail, date = new Date()): string {
  const boundary = `oa-${randomBytes(12).toString("hex")}`;
  const headers: Array<[string, string]> = [
    ["From", mailbox(m.from.name, m.from.email)],
    ["To", m.to],
    ...(m.replyTo ? [["Reply-To", m.replyTo] as [string, string]] : []),
    ["Subject", encodeWord(m.subject)],
    ["Date", date.toUTCString().replace("GMT", "+0000")],
    ["Message-ID", `<${m.id}@${domainOf(m.from.email)}>`],
    ["MIME-Version", "1.0"],
    ...Object.entries(m.headers).filter(([k, v]) => /^[A-Za-z0-9-]+$/.test(k) && !/[\r\n]/.test(v)),
    ["Content-Type", `multipart/alternative; boundary="${boundary}"`],
  ];
  return [
    ...headers.map(([k, v]) => `${k}: ${v}`),
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(m.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(m.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
