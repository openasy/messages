import {
  AppShell,
  BarList,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  StackedBarChart,
  StatusBadge,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  FileText,
  KeyRound,
  LayoutDashboard,
  LogIn,
  LogOut,
  MailX,
  Plug,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  UserRound,
  Users,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Campaign, Overview, ProductLink, Provider, Settings, Summary } from "./api.ts";
import { CampaignsPage } from "./campaigns.tsx";
import { CHART_SERIES, channelName, fmt, pct, useApi, useLoad, type Call } from "./common.tsx";
import { useT, type T } from "./i18n.ts";
import { JourneysPage } from "./journeys.tsx";
import { BouncesPage, IntegrationsPage, SettingsFilePage, TemplatesPage } from "./pages.tsx";

const PAGES = ["campaigns", "journeys", "templates", "bounces", "integrations", "settings", "account", "members", "signin", "tokens"] as const;
type Page = "overview" | (typeof PAGES)[number];
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["overview", ...PAGES];
function parseRoute(path: string): Page {
  const [page] = path.replace(/^\//, "").split("/");
  return (PAGES as readonly string[]).includes(page ?? "") ? (page as Page) : "overview";
}

// ---------------------------------------------------------------- Overview

function providerDetail(p: Provider, t: T) {
  const parts = [channelName(p.channel, t) + (p.role === "fallback" ? ` ${t("overview.fallback")}` : ""), p.detail, t("overview.perSecond", { rate: p.rate })];
  if (p.missing.length) parts.push(t("overview.missing", { names: p.missing.join(", ") }));
  else if (p.state === "failing" && p.error) parts.push(p.error);
  return parts.join(" · ");
}

const PROVIDER_TONE = { working: "success", failing: "danger", standby: "neutral", waiting: "warning" } as const;

function OverviewPage({ call, summary }: { call: Call; summary: Summary | undefined }) {
  const t = useT();
  const [o] = useLoad<Overview>(call, "/api/v1/overview?days=30");
  if (o === null) return <EmptyState title={t("overview.failed")} />;
  const x = o?.totals;
  const openRate = x && x.emailSent ? (x.emailOpened / x.emailSent) * 100 : null;
  const openBefore = o && o.before.emailSent ? (o.before.emailOpened / o.before.emailSent) * 100 : null;
  const delta = openRate !== null && openBefore !== null ? Math.round((openRate - openBefore) * 10) / 10 : null;
  return (
    <>
      <PageHeader title={t("overview.title")} description={t("overview.description")} />
      {summary &&
        Object.entries(summary.waiting).map(([c, why]) => (
          <Callout key={c} tone="warning" title={t("overview.waiting", { channel: channelName(c as "email", t) })} className="mb-2.5">
            {why}
          </Callout>
        ))}
      {summary && summary.unknown > 0 && (
        <Callout tone="warning" title={t("overview.unknown", { count: summary.unknown })} className="mb-2.5">
          {t("overview.unknownDetail")}
        </Callout>
      )}
      {x && (
        <>
          <KpiGrid minWidth={160} className="mb-2.5">
            <KpiCard
              label={t("overview.sent")}
              value={fmt(x.sent)}
              icon={Send}
              delta={{
                label: t("overview.byChannel", { email: fmt(x.byChannel.email), sms: fmt(x.byChannel.sms), whatsapp: fmt(x.byChannel.whatsapp) }),
                intent: "neutral",
              }}
            />
            <KpiCard label={t("overview.delivered")} value={pct(x.delivered, x.sent)} />
            <KpiCard
              label={t("overview.opened")}
              value={openRate === null ? "–" : `${Math.round(openRate * 10) / 10}%`}
              unit={t("overview.emailUnit")}
              delta={
                delta === null
                  ? undefined
                  : {
                      label: t("overview.points", { change: (delta > 0 ? "+" : "") + delta }),
                      direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
                      intent: delta >= 0 ? "good" : "bad",
                    }
              }
            />
            <KpiCard label={t("overview.clicked")} value={pct(x.clicked, x.sent)} />
            <KpiCard label={t("overview.held")} value={fmt(x.held)} icon={ShieldCheck} delta={{ label: t("overview.heldDetail"), intent: "neutral" }} />
            <KpiCard
              label={t("overview.unsubscribed")}
              value={pct(x.unsubscribed, x.sent)}
              delta={{ label: t("overview.people", { count: x.unsubscribed }), intent: "neutral" }}
            />
          </KpiGrid>
          <div className="ms-split-side mb-2.5 grid gap-2.5">
            <Panel title={t("overview.perDay")} description={t("overview.perDayDetail")}>
              <StackedBarChart
                label={t("overview.perDayLabel")}
                categories={o.series.map((d) =>
                  new Date(`${d.day}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }),
                )}
                segments={CHART_SERIES.map((c) => ({ id: c, name: channelName(c, t) }))}
                values={o.series.map((d) => [d.email, d.sms, d.whatsapp])}
                height={200}
                xTicks={7}
              />
            </Panel>
            <Panel title={t("overview.providers")} description={t("overview.providersDetail")} flush>
              {o.providers.length ? (
                <ul aria-label={t("overview.providers")} className="ms-list flex flex-col">
                  {o.providers.map((p) => (
                    <li key={`${p.channel}:${p.role}`} className="flex items-center gap-2 border-b border-subtle px-3 py-2 last:border-0">
                      <span className="flex min-w-0 grow flex-col">
                        <span className="truncate text-sm text-fg">{p.name}</span>
                        <span className="truncate text-2xs text-fg-muted" title={providerDetail(p, t)}>
                          {providerDetail(p, t)}
                        </span>
                      </span>
                      <StatusBadge tone={PROVIDER_TONE[p.state]}>{t(`provider.${p.state}`)}</StatusBadge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-3 text-sm text-fg-muted">{t("overview.noProviders")}</p>
              )}
            </Panel>
          </div>
          <Panel title={t("overview.links")} description={t("overview.linksDetail")}>
            {o.links.length ? (
              <BarList label={t("overview.links")} items={o.links.map((l) => ({ id: l.label, label: l.label, value: l.clicks }))} />
            ) : (
              <p className="text-sm text-fg-muted">{t("overview.noClicks")}</p>
            )}
          </Panel>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AuthSettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("auth.adminsOnly")}>{t("auth.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`auth.${page}`)}
        description={t(`auth.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("auth.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const page = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [settings, setSettings] = useState<Settings>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "messages" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Summary>("/api/v1/summary").then(setSummary, () => {});
    void call<Settings>("/api/v1/settings").then(setSettings, () => {});
  }, [call]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 30_000);
    return () => clearInterval(timer);
  }, [reload]);

  // The search window (Cmd+K) finds campaigns by name.
  const onSearch = useMemo(
    () => async (q: string, signal: AbortSignal) => {
      const r = await call<{ campaigns: Campaign[] }>("/api/v1/campaigns", { signal });
      const words = q.toLocaleLowerCase();
      return r.campaigns
        .filter((c) => c.name.toLocaleLowerCase().includes(words))
        .slice(0, 10)
        .map((c) => ({ id: `campaign:${c.id}`, label: c.name, detail: msg(`state.${c.state}`), kind: msg("search.campaign"), icon: Send, href: "/campaigns" }));
    },
    [call, msg],
  );

  const nav = [
    { id: "overview", label: msg("nav.overview"), icon: LayoutDashboard },
    { id: "campaigns", label: msg("nav.campaigns"), icon: Send, count: summary?.campaigns.active || undefined },
    { id: "journeys", label: msg("nav.journeys"), icon: Workflow },
    { id: "templates", label: msg("nav.templates"), icon: FileText },
    { id: "bounces", label: msg("nav.bounces"), icon: MailX, count: summary?.bounces.hard || undefined },
  ];
  const footerNav = [
    { id: "integrations", label: msg("nav.integrations"), icon: Plug },
    { id: "settings", label: msg("nav.settings"), icon: SettingsIcon },
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);

  return (
    <AppShell
      product="messages"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={page}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {summary?.file?.error && page !== "settings" && (
        <Callout tone="danger" title={msg("file.notApplied")} className="mb-2.5">
          {summary.file.error}
        </Callout>
      )}
      {page === "account" || page === "members" || page === "signin" || page === "tokens" ? (
        <AuthSettingsPage page={page} />
      ) : !settings?.config ? (
        <PageHeader title={msg("loading")} />
      ) : page === "campaigns" ? (
        <CampaignsPage call={call} settings={settings} onChanged={reload} />
      ) : page === "journeys" ? (
        <JourneysPage call={call} onChanged={reload} />
      ) : page === "templates" ? (
        <TemplatesPage call={call} settings={settings} />
      ) : page === "bounces" ? (
        <BouncesPage call={call} onChanged={reload} />
      ) : page === "integrations" ? (
        <IntegrationsPage call={call} settings={settings} summary={summary} />
      ) : page === "settings" ? (
        <SettingsFilePage settings={settings} />
      ) : (
        <OverviewPage call={call} summary={summary} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Messages">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
