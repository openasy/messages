// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export type Channel = "email" | "sms" | "whatsapp";

export interface ProductLink {
  id: string;
  url: string;
}

export type ConfigFile = { path: string; appliedAt: string | null; error: string | null; warnings: string[] } | null;

export interface Provider {
  channel: Channel;
  role: "primary" | "fallback";
  kind: "ses" | "smtp" | "netgsm" | "iletimerkezi" | "whatsapp";
  name: string;
  detail: string;
  rate: number;
  missing: string[];
  state: "working" | "failing" | "standby" | "waiting";
  okAt: string | null;
  error: string | null;
  sent: number;
}

export interface LinkState {
  id: "consent" | "audience";
  linked: boolean;
  url: string | null;
  tokenVariable: string | null;
  tokenSet: boolean;
  okAt: string | null;
  error: string | null;
}

export interface Summary {
  file: ConfigFile;
  campaigns: { active: number };
  journeys: { live: number };
  bounces: { hard: number };
  unknown: number;
  waiting: Partial<Record<Channel, string>>;
  providers: Provider[];
  links: LinkState[];
  outbox: number;
}

type ProviderConfig = Record<string, unknown> & { kind: Provider["kind"]; rate: number };

export interface Config {
  sender: { name: string; email: string | null; replyTo: string | null; address: string | null };
  providers: {
    email: { primary: ProviderConfig; fallback: ProviderConfig | null } | null;
    sms: (ProviderConfig & { sender: string; stop: string }) | null;
    whatsapp: (ProviderConfig & { phoneNumberId: string }) | null;
  };
  consent: { check: "consent" | "own"; purpose: string; whatsapp: "sms" | "call" };
  products: {
    consent: { url: string | null; token: string } | null;
    audience: { url: string | null; token: string; events: boolean; changesEvery: number } | null;
  };
  limits: { quietHours: { start: number; end: number; text: string } | null; timezone: string; softBounceTries: number; phoneCountry: string };
  tracking: { opens: boolean; clicks: boolean; utmSource: string };
}

export interface Settings {
  config: Config;
  yaml: string;
  file: ConfigFile;
  variables: Array<{ name: string; set: boolean }>;
  publicUrl: string;
}

export interface Totals {
  sent: number;
  byChannel: Record<Channel, number>;
  delivered: number;
  emailSent: number;
  emailOpened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
}

export interface Overview {
  days: number;
  from: string;
  totals: Totals & { held: number };
  before: Totals;
  series: Array<{ day: string; email: number; sms: number; whatsapp: number }>;
  links: Array<{ label: string; clicks: number }>;
  providers: Provider[];
}

export interface Template {
  id: string;
  name: string;
  channel: Channel;
  lang: string;
  subject: string | null;
  body: string;
  format: "text" | "html";
  waName: string | null;
  waParams: string[];
  approval: string | null;
  usedBy: string[];
}

export interface Preview {
  as: number;
  people: Array<{ index: number; name: string }>;
  from: string | null;
  subject: string | null;
  text: string;
  html: string | null;
}

export interface List {
  id: string;
  name: string;
  size: number;
  withEmail: number;
  withPhone: number;
}

export interface Segment {
  id: string;
  name: string;
  size: number;
}

export interface Counts {
  messages: number;
  waiting: number;
  queued: number;
  held: number;
  suppressed: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
  failed: number;
  unknown: number;
  cancelled: number;
}

export interface Variant {
  sent: number;
  opened: number;
  clicked: number;
  rate: number | null;
}

export type CampaignState = "draft" | "scheduled" | "sending" | "paused" | "sent";

export interface Campaign {
  id: string;
  name: string;
  slug: string;
  channel: Channel;
  audience: { kind: "segment" | "list"; id: string; name: string };
  template: { id: string; name: string; subject: string | null };
  ab: null | {
    share: number;
    metric: "opened" | "clicked";
    waitHours: number;
    winner: "a" | "b" | null;
    a: string;
    b: string;
    results: { a: Variant; b: Variant };
  };
  state: CampaignState;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  reading: boolean;
  audienceSize: number;
  noAddress: number;
  problem: string | null;
  counts: Counts;
  optOutsSince: number;
}

export interface Estimate {
  size: number;
  counted: number;
  withAddress: number;
  suppressed: number;
  allowed: number;
}

export type Step =
  | { id: string; kind: "send"; title: string; channel: Channel; templateId: string }
  | { id: string; kind: "wait"; title: string; minutes: number }
  | {
      id: string;
      kind: "branch";
      title: string;
      test: "opened" | "clicked" | "consent" | "field";
      negate: boolean;
      steps: string[];
      channel: Channel | null;
      field: string | null;
      value: string | null;
      otherwise: string;
    }
  | { id: string; kind: "exit"; title: string };

export interface Journey {
  id: string;
  name: string;
  slug: string;
  utmCampaign: string;
  state: "draft" | "live" | "paused";
  trigger: { kind: "event"; event: string } | { kind: "segment"; segment: string; name: string };
  goal: { kind: "event"; event: string } | { kind: "segment-left" } | null;
  steps: Step[];
  problem: string | null;
  stats: {
    entered: number;
    converted: number;
    active: number;
    steps: Array<{ id: string; now: number; passed: number; sent?: number; held?: number; opened?: number; clicked?: number }>;
  };
}

export interface Bounce {
  id: number;
  channel: Channel;
  address: string;
  kind: "hard" | "soft";
  reason: string;
  from: string | null;
  at: string;
}

export interface OptOut {
  channel: Channel;
  address: string;
  source: "unsubscribe" | "stop" | "complaint";
  at: string;
}

export interface Hooks {
  ses: string;
  smsReports: string;
  smsInbound: string;
  whatsapp: string;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
