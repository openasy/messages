import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { parseConfig, watchConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { log } from "./log.ts";
import { createMessages } from "./messages.ts";
import { parseProducts } from "./products.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.MESSAGES_DB ?? "/data/messages.db";
const configPath = process.env.MESSAGES_CONFIG?.trim() || "/config/messages.yaml";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.MESSAGES_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.MESSAGES_METRICS_PORT ? Number(process.env.MESSAGES_METRICS_PORT) : undefined;

const db = openDb(dbPath);
// The address people open Messages at, behind the TLS proxy (ADR 0026). Cookies, passkeys, OIDC redirects, and every
// tracked link, open pixel, unsubscribe link and webhook address in the messages use it.
const publicUrl = (process.env.MESSAGES_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.MESSAGES_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const auth = createAuth({
  db,
  product: "messages",
  productName: "OpenAsy Messages",
  origin: publicUrl,
  // Locally the same product is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.MESSAGES_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env),
  secretsKey: readSecretsKey(secretsKeyFile),
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
let file: ReturnType<typeof watchConfig> | undefined;
const messages = createMessages(db, { publicUrl, env: process.env, products: products.products, fileState: () => file?.state ?? null });
// The settings come from the file and only from it; a file with a mistake keeps the last good one in place.
file = watchConfig(configPath, (config, text) => messages.setConfig(config, text), {
  onChange: (state) =>
    state.error
      ? log("warn", "settings file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "settings file applied", { file: state.path, warnings: state.warnings }),
});
// Without a file, nothing can be sent, but the UI opens and shows what to set.
if (!messages.config()) {
  messages.setConfig(parseConfig("consent: { check: own }"), "");
  log("warn", "no settings file applied: no provider is set, so nothing is sent until it can be read", { file: configPath });
}
const server = createServer(
  createApp({
    db,
    messages,
    version,
    auth,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(messages, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "messages started", { version, port, db: dbPath, config: configPath, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log(
    "warn",
    "MESSAGES_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys, and providers will not call plain http webhooks. Put it behind TLS (ADR 0026)",
    {
      url: publicUrl,
    },
  );
}
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

// Sending, journeys, the outbox and SMS reports run on timers; a stop in the middle loses nothing (see dispatch.ts).
const stopLoops = messages.start();
messages.purge();
const timers: NodeJS.Timeout[] = [setInterval(() => auth.purge(), 5 * 60_000), setInterval(() => messages.purge(), 86_400_000)];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  stopLoops();
  for (const t of timers) clearInterval(t);
  file?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
