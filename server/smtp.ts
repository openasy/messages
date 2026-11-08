// A small SMTP client (RFC 5321) for one message at a time: EHLO, STARTTLS or TLS from the start, AUTH PLAIN, MAIL,
// RCPT and DATA. The answer to each step decides the outcome: nothing is sent before DATA's final 250, so a failure
// before DATA is safe to try again; a connection lost after the message was written may have delivered it.
import { connect as netConnect, type Socket } from "node:net";
import { hostname } from "node:os";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { SmtpProvider } from "./config.ts";
import { buildMime, type OutEmail } from "./mime.ts";
import { SendError, type EmailSender } from "./providers.ts";

interface Reply {
  code: number;
  text: string;
}

/** Reads SMTP replies (multi-line 250-... until 250 ...) from a socket. */
function replies(socket: Socket | TLSSocket) {
  let buffer = "";
  let lines: string[] = [];
  const queue: Reply[] = [];
  const waiting: Array<{ resolve: (r: Reply) => void; reject: (e: Error) => void }> = [];
  let closed: Error | null = null;
  const onData = (d: Buffer) => {
    buffer += d.toString("utf8");
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, "");
      buffer = buffer.slice(i + 1);
      lines.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: lines.map((l) => l.slice(4)).join(" ") };
        lines = [];
        const w = waiting.shift();
        if (w) w.resolve(reply);
        else queue.push(reply);
      }
    }
  };
  const onEnd = (err?: Error) => {
    closed = err ?? new Error("the server closed the connection");
    for (const w of waiting.splice(0)) w.reject(closed);
  };
  socket.on("data", onData);
  socket.on("error", onEnd);
  socket.on("close", () => onEnd());
  return {
    next(): Promise<Reply> {
      const r = queue.shift();
      if (r) return Promise.resolve(r);
      if (closed) return Promise.reject(closed);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    detach() {
      socket.off("data", onData);
    },
  };
}

/** Lines that start with a dot get another (RFC 5321 4.5.2), and the message ends with CRLF.CRLF. */
const dotStuff = (data: string) => data.replace(/\r\n\./g, "\r\n..").replace(/^\./, "..") + (data.endsWith("\r\n") ? "" : "\r\n") + ".\r\n";

export interface SmtpOptions {
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  user?: string;
  password?: string;
  timeoutMs?: number;
  /** Extra TLS options, for a test server with its own certificate. */
  tls?: { ca?: string; rejectUnauthorized?: boolean };
}

/** Sends one message; the server's final answer to DATA, which often carries its queue id. */
export async function smtpSend(o: SmtpOptions, from: string, to: string, data: string): Promise<string> {
  const timeout = o.timeoutMs ?? 30_000;
  let socket: Socket | TLSSocket;
  try {
    socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
      const s =
        o.security === "tls"
          ? tlsConnect({ host: o.host, port: o.port, servername: o.host, ...o.tls }, () => resolve(s))
          : netConnect({ host: o.host, port: o.port }, () => resolve(s));
      s.once("error", reject);
      s.setTimeout(timeout, () => s.destroy(new Error("timed out")));
    });
  } catch (err) {
    throw new SendError(`SMTP ${o.host}:${o.port} could not be reached: ${(err as Error).message}.`, "retry");
  }
  let r = replies(socket);
  let dataSent = false;
  const write = (line: string) => socket.write(line + "\r\n");
  const expect = async (step: string, ok: (c: number) => boolean, rcpt = false) => {
    let reply: Reply;
    try {
      reply = await r.next();
    } catch (err) {
      throw new SendError(`SMTP ${o.host}: ${(err as Error).message} at ${step}.`, dataSent ? "unknown" : "retry");
    }
    if (ok(reply.code)) return reply;
    const msg = `SMTP ${o.host} answered ${reply.code} ${reply.text} at ${step}.`;
    if (reply.code >= 400 && reply.code < 500) throw new SendError(msg, "retry");
    // 550, 551 and 553 to RCPT, or 5.1.x enhanced codes: the mailbox does not exist.
    const hard = rcpt && ([550, 551, 553].includes(reply.code) || /\b5\.1\.\d\b/.test(reply.text));
    throw new SendError(msg, "refused", hard);
  };
  try {
    await expect("greeting", (c) => c === 220);
    const me = hostname() || "localhost";
    write(`EHLO ${me}`);
    let ehlo = await expect("EHLO", (c) => c === 250);
    if (o.security === "starttls") {
      if (!/\bSTARTTLS\b/i.test(ehlo.text)) throw new SendError(`SMTP ${o.host} does not offer STARTTLS; set security: tls or check the port.`, "refused");
      write("STARTTLS");
      await expect("STARTTLS", (c) => c === 220);
      r.detach();
      socket = await new Promise<TLSSocket>((resolve, reject) => {
        const t = tlsConnect({ socket, servername: o.host, ...o.tls }, () => resolve(t));
        t.once("error", (e) => reject(new SendError(`SMTP ${o.host}: TLS failed: ${e.message}.`, "retry")));
      });
      r = replies(socket);
      write(`EHLO ${me}`);
      ehlo = await expect("EHLO", (c) => c === 250);
    }
    if (o.user) {
      write(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.password ?? ""}`).toString("base64")}`);
      await expect("AUTH", (c) => c === 235);
    }
    write(`MAIL FROM:<${from}>`);
    await expect("MAIL FROM", (c) => c === 250);
    write(`RCPT TO:<${to}>`);
    await expect("RCPT TO", (c) => c === 250 || c === 251, true);
    write("DATA");
    await expect("DATA", (c) => c === 354);
    dataSent = true;
    socket.write(dotStuff(data));
    const done = await expect("the end of DATA", (c) => c === 250);
    write("QUIT");
    return done.text;
  } finally {
    socket.end();
    setTimeout(() => socket.destroy(), 1000).unref();
  }
}

export function createSmtpSender(p: SmtpProvider, env: Record<string, string | undefined>, tls?: SmtpOptions["tls"]): EmailSender {
  return {
    channel: "email",
    kind: "smtp",
    async send(m: OutEmail) {
      const user = p.user ? env[p.user] : undefined;
      if (p.user && !user) throw new SendError(`${p.user} is not set, so Messages cannot sign in to ${p.host}.`, "retry");
      const answer = await smtpSend(
        { host: p.host, port: p.port, security: p.security, user, password: p.password ? env[p.password] : undefined, tls },
        m.from.email,
        m.to,
        buildMime(m),
      );
      // The server's queue id, if it gives one ("250 2.0.0 Ok: queued as 4F2C"); else our own Message-ID.
      const queued = /queued as ([A-Za-z0-9._-]+)/i.exec(answer)?.[1];
      return { providerId: queued ? `smtp:${queued}` : `smtp:${m.id}` };
    },
  };
}
