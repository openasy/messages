// Messages, put together: the settings in force, the providers built from them, and the parts that send, follow up
// and report. main.ts starts the timers; tests call the ticks themselves with a fake clock.
import type { DatabaseSync } from "node:sqlite";
import { createCampaigns } from "./campaigns.ts";
import { CHANNELS, namedVariables, providerVariables, type Channel, type Config, type ConfigFileState, type Provider } from "./config.ts";
import { all, iso, newId, one, run, type Core, type Senders } from "./core.ts";
import { createDispatcher } from "./dispatch.ts";
import { MsgError } from "./errors.ts";
import { createHooks, createResults } from "./hooks.ts";
import { createJourneys } from "./journeys.ts";
import { createLinks, type Links } from "./links.ts";
import { log } from "./log.ts";
import { createPeople } from "./people.ts";
import type { ProductLink } from "./products.ts";
import { createSesSender } from "./ses.ts";
import { createSmsSender } from "./sms.ts";
import { createSmtpSender, type SmtpOptions } from "./smtp.ts";
import { createLists, createTemplates } from "./templates.ts";
import { createWhatsAppSender } from "./whatsapp.ts";

export interface MessagesOptions {
  publicUrl: string;
  env?: Record<string, string | undefined>;
  products?: ProductLink[];
  fetch?: typeof fetch;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fileState?: () => ConfigFileState | null;
  /** For tests: TLS options for SMTP servers with their own certificate. */
  smtpTls?: SmtpOptions["tls"];
  log?: typeof log;
}

function providerName(p: Provider): string {
  if (p.kind === "ses") return `Amazon SES, ${p.region}`;
  if (p.kind === "smtp") return p.host;
  if (p.kind === "netgsm") return "Netgsm";
  if (p.kind === "iletimerkezi") return "İleti Merkezi";
  return "WhatsApp Business";
}

export function createMessages(db: DatabaseSync, opts: MessagesOptions) {
  const env = opts.env ?? process.env;
  const http = opts.fetch ?? fetch;
  const clock = opts.clock ?? Date.now;
  const links: Links = createLinks({ env, products: opts.products ?? [], fetch: http });
  let config: Config | null = null;
  let yaml = "";
  let senders: Senders = { email: null, sms: null, whatsapp: null };

  const core: Core = {
    db,
    clock,
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    publicUrl: opts.publicUrl.replace(/\/$/, ""),
    env,
    links,
    http,
    config: () => {
      if (!config) throw new MsgError(503, "not-configured", "No settings file is applied yet.");
      return config;
    },
    hasConfig: () => !!config,
    senders: () => senders,
    hookSecret: () => {
      let s = one<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'hook_secret'")?.value;
      if (!s) {
        s = newId(24);
        run(db, "INSERT OR IGNORE INTO settings (key, value) VALUES ('hook_secret', ?)", s);
        s = one<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'hook_secret'")!.value;
      }
      return s;
    },
    log: opts.log ?? log,
  };

  const people = createPeople(core);
  const templates = createTemplates(core);
  const lists = createLists(core);
  const campaigns = createCampaigns(core, people, templates, lists);
  const journeys = createJourneys(core, people, templates);
  const dispatcher = createDispatcher(core, people, templates);
  const results = createResults(core, people, templates);
  const hooks = createHooks(core, people, results, templates);

  /** Applies a new version of the file; returns what to fix that did not stop it. */
  function setConfig(c: Config, text: string): string[] {
    const build = (p: Provider) => {
      if (p.kind === "ses") return createSesSender(p, env, http, clock);
      if (p.kind === "smtp") return createSmtpSender(p, env, opts.smtpTls);
      if (p.kind === "netgsm" || p.kind === "iletimerkezi") return createSmsSender(p, env, http);
      return createWhatsAppSender(p, env, http);
    };
    senders = {
      email: c.providers.email
        ? { primary: build(c.providers.email.primary), fallback: c.providers.email.fallback && build(c.providers.email.fallback) }
        : null,
      sms: c.providers.sms && build(c.providers.sms),
      whatsapp: c.providers.whatsapp && build(c.providers.whatsapp),
    };
    config = c;
    yaml = text;
    links.setConfig(c);
    const warnings = namedVariables(c)
      .filter((v) => !env[v])
      .map((v) => `${v} is not set: what needs it waits until it is.`);
    for (const p of [c.providers.email?.primary, c.providers.email?.fallback])
      if (p?.kind === "ses" && !p.topic)
        warnings.push("The SES provider has no sns_topic: SNS messages from any topic are taken. Name the topic SES publishes to.");
    if (c.consent.check === "own")
      warnings.push("consent.check is own: Messages sends to everyone not on its own opt-out list. Only use it for people you know agreed.");
    return warnings;
  }

  function providers() {
    const c = config;
    if (!c) return [];
    const h = dispatcher.health();
    const out: Array<{
      channel: Channel;
      role: "primary" | "fallback";
      kind: Provider["kind"];
      name: string;
      detail: string;
      rate: number;
      missing: string[];
      state: "working" | "failing" | "standby" | "waiting";
      okAt: string | null;
      error: string | null;
      sent: number;
    }> = [];
    const add = (channel: Channel, role: "primary" | "fallback", p: Provider) => {
      const x = h.get(`${channel}:${role}`);
      const missing = providerVariables(p).filter((v) => !env[v]);
      const detail =
        p.kind === "netgsm" || p.kind === "iletimerkezi"
          ? `sender ${p.sender}`
          : p.kind === "whatsapp"
            ? `phone number id ${p.phoneNumberId}`
            : p.kind === "smtp"
              ? `port ${p.port}, ${p.security}`
              : `from ${c.sender.email}${p.configurationSet ? `, configuration set ${p.configurationSet}` : ""}`;
      out.push({
        channel,
        role,
        kind: p.kind,
        name: providerName(p),
        detail,
        rate: Math.round(p.rate * 100) / 100,
        missing,
        state: missing.length ? "waiting" : x?.error && (!x.okAt || x.errorAt! > x.okAt) ? "failing" : x?.okAt ? "working" : "standby",
        okAt: x?.okAt ?? null,
        error: x?.error ?? null,
        sent: x?.sent ?? 0,
      });
    };
    if (c.providers.email) {
      add("email", "primary", c.providers.email.primary);
      if (c.providers.email.fallback) add("email", "fallback", c.providers.email.fallback);
    }
    if (c.providers.sms) add("sms", "primary", c.providers.sms);
    if (c.providers.whatsapp) add("whatsapp", "primary", c.providers.whatsapp);
    return out;
  }

  function summary() {
    const n = (sql: string, ...a: string[]) => one<{ n: number }>(db, sql, ...a)!.n;
    return {
      file: opts.fileState?.() ?? null,
      campaigns: { active: n("SELECT COUNT(*) AS n FROM campaigns WHERE state IN ('scheduled', 'sending')") },
      journeys: { live: n("SELECT COUNT(*) AS n FROM journeys WHERE state = 'live'") },
      bounces: { hard: n("SELECT COUNT(DISTINCT channel || hash) AS n FROM bounces WHERE kind = 'hard' AND cleared_at IS NULL") },
      unknown: n("SELECT COUNT(*) AS n FROM messages WHERE state = 'unknown'"),
      waiting: Object.fromEntries(dispatcher.waiting()),
      providers: providers(),
      links: links.state(),
      outbox: n("SELECT COUNT(*) AS n FROM outbox"),
    };
  }

  /** Everything sent in a period: totals, the same before it, per day by channel, and the most clicked links. */
  function overview(days: number) {
    const to = clock();
    const from = iso(to - days * 86_400_000);
    const before = iso(to - 2 * days * 86_400_000);
    const totals = (a: string, b: string) => {
      const r = all<{ channel: Channel; sent: number; delivered: number; opened: number; clicked: number; bounced: number; unsubscribed: number }>(
        db,
        `SELECT channel, COUNT(*) AS sent, COUNT(delivered_at) AS delivered, COUNT(opened_at) AS opened, COUNT(clicked_at) AS clicked,
                COUNT(bounced_at) AS bounced, COUNT(unsubscribed_at) AS unsubscribed
           FROM messages WHERE sent_at >= ? AND sent_at < ? GROUP BY channel`,
        a,
        b,
      );
      const by = Object.fromEntries(CHANNELS.map((c) => [c, r.find((x) => x.channel === c)?.sent ?? 0])) as Record<Channel, number>;
      const sum = (k: "sent" | "delivered" | "opened" | "clicked" | "bounced" | "unsubscribed", only?: Channel) =>
        r.filter((x) => !only || x.channel === only).reduce((s, x) => s + x[k], 0);
      return {
        sent: sum("sent"),
        byChannel: by,
        delivered: sum("delivered"),
        emailSent: by.email,
        emailOpened: sum("opened", "email"),
        clicked: sum("clicked"),
        bounced: sum("bounced"),
        unsubscribed: sum("unsubscribed"),
      };
    };
    const held = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM messages WHERE state = 'held' AND created_at >= ?", from)!.n;
    const series: Array<{ day: string; email: number; sms: number; whatsapp: number }> = [];
    const perDay = all<{ day: string; channel: Channel; n: number }>(
      db,
      "SELECT substr(sent_at, 1, 10) AS day, channel, COUNT(*) AS n FROM messages WHERE sent_at >= ? GROUP BY day, channel",
      iso(to - 14 * 86_400_000),
    );
    for (let i = 13; i >= 0; i--) {
      const day = iso(to - i * 86_400_000).slice(0, 10);
      const row = { day, email: 0, sms: 0, whatsapp: 0 };
      for (const x of perDay) if (x.day === day) row[x.channel] = x.n;
      series.push(row);
    }
    const links = all<{ url: string; n: number }>(db, "SELECT url, COUNT(*) AS n FROM clicks WHERE at >= ? GROUP BY url ORDER BY n DESC LIMIT 50", from);
    const byPath = new Map<string, number>();
    for (const l of links) {
      const u = URL.parse(l.url);
      const label = u ? `${u.pathname}${u.searchParams.get("utm_campaign") ? `?utm_campaign=${u.searchParams.get("utm_campaign")}` : ""}` : l.url;
      byPath.set(label, (byPath.get(label) ?? 0) + l.n);
    }
    return {
      days,
      from,
      totals: { ...totals(from, iso(to + 1)), held },
      before: totals(before, from),
      series,
      links: [...byPath]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([label, clicks]) => ({ label, clicks })),
      providers: providers(),
    };
  }

  function settings() {
    const c = config;
    return {
      config: c,
      yaml,
      file: opts.fileState?.() ?? null,
      variables: c ? namedVariables(c).map((name) => ({ name, set: !!env[name] })) : [],
      publicUrl: core.publicUrl,
    };
  }

  /** The addresses each provider is told to call. The SMS ones carry a secret, so only admins see them. */
  function hookUrls() {
    const s = core.hookSecret();
    return {
      ses: `${core.publicUrl}/hooks/ses`,
      smsReports: `${core.publicUrl}/hooks/sms/${s}`,
      smsInbound: `${core.publicUrl}/hooks/sms/${s}/inbound`,
      whatsapp: `${core.publicUrl}/hooks/whatsapp`,
    };
  }

  function gauges() {
    const by: Record<string, number> = {};
    for (const r of all<{ state: string; n: number }>(db, "SELECT state, COUNT(*) AS n FROM messages GROUP BY state")) by[r.state] = r.n;
    return {
      messages: by,
      sentByChannel: Object.fromEntries(
        all<{ channel: string; n: number }>(db, "SELECT channel, COUNT(*) AS n FROM messages WHERE sent_at IS NOT NULL GROUP BY channel").map((r) => [
          r.channel,
          r.n,
        ]),
      ),
      outbox: one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM outbox")!.n,
      providerErrors: providers().filter((p) => p.state === "failing").length,
    };
  }

  /** One pass of everything that runs on a timer, in order; tests call it with a fake clock. */
  async function step() {
    await campaigns.tick();
    await journeys.tick();
    const sent = await dispatcher.tick();
    await people.flush();
    return sent;
  }

  /** Starts the timers; returns a function that stops them. */
  function start() {
    const recovered = dispatcher.recover();
    if (recovered) core.log("warn", "messages left sending by the last stop are marked unknown and not sent again", { count: recovered });
    const loops: NodeJS.Timeout[] = [];
    const every = (ms: number, fn: () => Promise<unknown>) => {
      let running = false;
      const t = setInterval(() => {
        if (running) return;
        running = true;
        fn()
          .catch((err) => core.log("error", "background task failed", { error: String(err) }))
          .finally(() => (running = false));
      }, ms);
      loops.push(t);
    };
    every(1000, async () => {
      await campaigns.tick();
      await journeys.tick();
      await dispatcher.tick();
    });
    every(10_000, () => people.flush());
    every(120_000, () => dispatcher.pullSmsReports((id, r) => results.report("sms", id, r, "report")));
    let lastPoll = 0;
    every(5_000, async () => {
      const each = config?.products.audience?.changesEvery ?? 60_000;
      if (clock() - lastPoll < each) return;
      lastPoll = clock();
      await journeys.pollSegments();
    });
    return () => loops.forEach(clearInterval);
  }

  /** Deletes what is no longer needed: clicks older than two years. Messages themselves stay with their campaign. */
  function purge() {
    run(db, "DELETE FROM clicks WHERE at < ?", iso(clock() - 730 * 86_400_000));
  }

  return {
    core,
    setConfig,
    config: () => config,
    settings,
    summary,
    overview,
    hookUrls,
    gauges,
    providers,
    templates,
    lists,
    campaigns,
    journeys,
    people,
    results,
    hooks,
    dispatcher,
    links,
    step,
    start,
    purge,
  };
}

export type Messages = ReturnType<typeof createMessages>;
