// What the pages share: data loading with the session, formatting, channels and states.
import { useAuth } from "@openasy/auth/react";
import { Mail, MessageCircle, MessageSquare, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type CampaignState, type Channel } from "./api.ts";
import type { T } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path when it changes; `reload` loads it again. undefined while loading, null when it failed. */
export function useLoad<R>(call: Call, path: string | null) {
  const [data, setData] = useState<R | null>();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    void call<R>(path).then(
      (d) => live && setData(d),
      () => live && setData(null),
    );
    return () => {
      live = false;
    };
  }, [call, path, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return [data, reload] as const;
}

/** A status line after something was done, read out by screen readers. */
export function Notice({ children, tone = "success" }: { children: ReactNode; tone?: "success" | "danger" }) {
  return (
    <div role="status" className={`mb-2.5 rounded-md px-3 py-2 text-sm text-fg ${tone === "success" ? "bg-success-soft" : "bg-danger-soft"}`}>
      {children}
    </div>
  );
}

export function Code({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre aria-label={label} className="ms-code m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

export const fmt = (n: number) => n.toLocaleString();
export const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 1000) / 10}%` : "–");

export const CHANNEL_ICON: Record<Channel, LucideIcon> = { email: Mail, sms: MessageSquare, whatsapp: MessageCircle };
export const channelName = (c: Channel, t: T) => t(`channel.${c}`);

export const STATE_TONE: Record<CampaignState, "neutral" | "info" | "warning" | "success"> = {
  draft: "neutral",
  scheduled: "info",
  sending: "warning",
  paused: "neutral",
  sent: "success",
};

/** A date and time, short: 3 Nov 10:00. */
export const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";

/** A local datetime-local value from a Date. */
export function localInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Tomorrow at 10:00, local time: the default for a new campaign. */
export function tomorrowTen() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d;
}

/** The channels in the order the charts stack them. */
export const CHART_SERIES: Channel[] = ["email", "sms", "whatsapp"];
