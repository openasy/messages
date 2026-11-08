// Amazon SES through its v2 API: SendEmail (POST /v2/email/outbound-emails) with the raw MIME message, signed with AWS
// Signature Version 4. Bounces, complaints, deliveries, opens and clicks come back through an SNS topic the
// configuration set publishes to (server/sns.ts).
import { createHash, createHmac } from "node:crypto";
import type { SesProvider } from "./config.ts";
import { buildMime, type OutEmail } from "./mime.ts";
import { providerFetch, SendError, type EmailSender } from "./providers.ts";

const sha256hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s).digest();

/** RFC 3986 encoding, as SigV4 wants it. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface Credentials {
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
}

/**
 * The headers that sign a request with AWS Signature Version 4: x-amz-date, the security token if any, and
 * Authorization. `headers` are the ones to sign besides host and x-amz-date.
 */
export function signV4(
  req: { method: string; url: string; headers: Record<string, string>; body: string },
  creds: Credentials,
  region: string,
  service: string,
  now = new Date(),
): Record<string, string> {
  const url = new URL(req.url);
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  headers.host = url.host;
  headers["x-amz-date"] = amzDate;
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;
  const names = Object.keys(headers).sort();
  const query = [...url.searchParams]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a, x], [b, y]) => (a! < b! ? -1 : a! > b! ? 1 : x! < y! ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const path =
    url.pathname
      .split("/")
      .map((p) => enc(decodeURIComponent(p)))
      .join("/") || "/";
  const canonical = [req.method, path, query, ...names.map((n) => `${n}:${headers[n]}`), "", names.join(";"), sha256hex(req.body)].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${creds.secretKey}`, day), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const { host: _host, ...rest } = headers;
  return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

/** SES error types that mean the request was fine but SES will not take it now: try again later. */
const RETRY = /TooManyRequests|Throttling|LimitExceeded|ServiceUnavailable|InternalFailure|SendingPaused/;

export function createSesSender(
  p: SesProvider,
  env: Record<string, string | undefined>,
  http: typeof fetch = fetch,
  clock: () => number = Date.now,
): EmailSender {
  const base = p.endpoint ?? `https://email.${p.region}.amazonaws.com`;
  return {
    channel: "email",
    kind: "ses",
    async send(m: OutEmail) {
      const accessKey = env[p.accessKey];
      const secretKey = env[p.secretKey];
      if (!accessKey || !secretKey) throw new SendError(`${!accessKey ? p.accessKey : p.secretKey} is not set, so Messages cannot sign SES requests.`, "retry");
      const url = `${base}/v2/email/outbound-emails`;
      const body = JSON.stringify({
        FromEmailAddress: m.from.email,
        Destination: { ToAddresses: [m.to] },
        ...(m.replyTo && { ReplyToAddresses: [m.replyTo] }),
        Content: { Raw: { Data: Buffer.from(buildMime(m)).toString("base64") } },
        ...(p.configurationSet && { ConfigurationSetName: p.configurationSet }),
        EmailTags: [{ Name: "openasy-message", Value: m.id.replace(/[^A-Za-z0-9_-]/g, "_") }],
      });
      const headers = signV4(
        { method: "POST", url, headers: { "content-type": "application/json" }, body },
        { accessKey, secretKey, ...(p.sessionToken && env[p.sessionToken] && { sessionToken: env[p.sessionToken] }) },
        p.region,
        "ses",
        new Date(clock()),
      );
      const r = await providerFetch(http, "Amazon SES", url, { method: "POST", headers, body });
      const id = (r.body as { MessageId?: unknown } | null)?.MessageId;
      if (r.status === 200 && typeof id === "string") return { providerId: id };
      const type = String((r.body as { __type?: string; code?: string } | null)?.__type ?? (r.body as { code?: string } | null)?.code ?? "");
      const detail = String(
        (r.body as { message?: string; Message?: string } | null)?.message ?? (r.body as { Message?: string } | null)?.Message ?? r.text.slice(0, 200),
      );
      const msg = `Amazon SES answered ${r.status}${type ? ` ${type}` : ""}: ${detail}`;
      if (r.status >= 500 || r.status === 429 || RETRY.test(type)) throw new SendError(msg, "retry");
      if (r.status === 200) throw new SendError(`${msg} (no MessageId)`, "unknown");
      throw new SendError(msg, "refused");
    },
  };
}
