// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  /** Messages by state. */
  messages: Record<string, number>;
  /** Messages sent, by channel. */
  sentByChannel: Record<string, number>;
  /** Calls to Consent and Audience waiting to be made. */
  outbox: number;
  /** Providers whose last call failed. */
  providerErrors: number;
  /** 1 when the settings file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

const STATES = ["waiting", "queued", "sending", "sent", "delivered", "held", "suppressed", "failed", "bounced", "unknown", "cancelled"];

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="messages",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_messages_messages Messages, by state.",
    "# TYPE openasy_messages_messages gauge",
    ...STATES.map((s) => `openasy_messages_messages{state="${s}"} ${g.messages[s] ?? 0}`),
    "# HELP openasy_messages_sent Messages sent, by channel.",
    "# TYPE openasy_messages_sent gauge",
    ...["email", "sms", "whatsapp"].map((c) => `openasy_messages_sent{channel="${c}"} ${g.sentByChannel[c] ?? 0}`),
    "# HELP openasy_messages_outbox Calls to Consent and Audience waiting to be made.",
    "# TYPE openasy_messages_outbox gauge",
    `openasy_messages_outbox ${g.outbox}`,
    "# HELP openasy_messages_provider_errors Providers whose last call failed.",
    "# TYPE openasy_messages_provider_errors gauge",
    `openasy_messages_provider_errors ${g.providerErrors}`,
    "# HELP openasy_messages_config_error 1 when the settings file could not be applied and its last good version is in use.",
    "# TYPE openasy_messages_config_error gauge",
    `openasy_messages_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
