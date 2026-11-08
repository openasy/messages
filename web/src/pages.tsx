// Templates, Bounces, Integrations and Settings.
import {
  Badge,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  PageHeader,
  Panel,
  SegmentedControl,
  SelectField,
  StatusBadge,
  TextField,
  useAgo,
  type Column,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Pencil, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Bounce, Channel, Hooks, OptOut, Preview, Settings, Summary, Template } from "./api.ts";
import { Code, Notice, channelName, useLoad, when, type Call } from "./common.tsx";
import { FileSettingsPage } from "./FileSettings.tsx";
import { useT, type T } from "./i18n.ts";

// ---------------------------------------------------------------- Templates

function TemplateDialog({
  call,
  open,
  onOpenChange,
  editing,
  onDone,
}: {
  call: Call;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: Template | null;
  onDone: (t: Template) => void;
}) {
  const t = useT();
  const [channel, setChannel] = useState<Channel>(editing?.channel ?? "email");
  const [name, setName] = useState(editing?.name ?? "");
  const [lang, setLang] = useState(editing?.lang ?? "tr");
  const [subject, setSubject] = useState(editing?.subject ?? "");
  const [body, setBody] = useState(editing?.body ?? "");
  const [format, setFormat] = useState<"text" | "html">(editing?.format ?? "text");
  const [waName, setWaName] = useState(editing?.waName ?? "");
  const [params, setParams] = useState((editing?.waParams ?? []).join("\n"));
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setError(null);
    const fields = {
      name,
      lang,
      body,
      ...(channel === "email" && { subject, format }),
      ...(channel === "whatsapp" && {
        waName: waName || name,
        waParams: params
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
      }),
    };
    try {
      const r = editing
        ? await call<Template>(`/api/v1/templates/${editing.id}`, { method: "PATCH", body: JSON.stringify(fields) })
        : await call<Template>("/api/v1/templates", { method: "POST", body: JSON.stringify({ ...fields, channel }) });
      onDone(r);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? t("templates.edit", { name: editing.name }) : t("templates.new")}
      description={t("templates.dialogDetail", { example: "{{first_name}}", fallback: "{{first_name|there}}" })}
      size="lg"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!name}>
            {t("templates.save")}
          </Button>
        </>
      }
    >
      {!editing && (
        <SegmentedControl
          label={t("campaigns.channel")}
          value={channel}
          onChange={setChannel}
          options={(["email", "sms", "whatsapp"] as const).map((c) => ({ value: c, label: channelName(c, t) }))}
        />
      )}
      <div className="ms-two grid gap-2">
        <TextField label={t("templates.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder="welcome-tr" mono />
        <TextField label={t("templates.lang")} value={lang} onChange={(e) => setLang(e.target.value)} mono />
      </div>
      {channel === "email" && (
        <>
          <TextField label={t("templates.subject")} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Hoş geldiniz, {{first_name}}" />
          <SegmentedControl
            label={t("templates.format")}
            value={format}
            onChange={setFormat}
            options={[
              { value: "text", label: t("templates.formatText") },
              { value: "html", label: "HTML" },
            ]}
          />
        </>
      )}
      {channel === "whatsapp" && (
        <>
          <TextField label={t("templates.waName")} hint={t("templates.waNameHint")} value={waName} onChange={(e) => setWaName(e.target.value)} mono />
        </>
      )}
      <label className="flex flex-col gap-1 text-xs font-medium text-fg">
        {channel === "whatsapp" ? t("templates.waBody") : t("templates.body")}
        <textarea className="ms-textarea" value={body} onChange={(e) => setBody(e.target.value)} rows={channel === "email" ? 10 : 4} />
        <span className="text-2xs font-normal text-fg-muted">
          {channel === "sms"
            ? t("templates.smsHint")
            : channel === "email"
              ? t("templates.emailHint")
              : t("templates.waBodyHint", { one: "{{1}}", two: "{{2}}" })}
        </span>
      </label>
      {channel === "whatsapp" && (
        <label className="flex flex-col gap-1 text-xs font-medium text-fg">
          {t("templates.waParams", { one: "{{1}}", two: "{{2}}" })}
          <textarea className="ms-textarea" value={params} onChange={(e) => setParams(e.target.value)} rows={3} placeholder={"{{first_name}}\n{{company}}"} />
          <span className="text-2xs font-normal text-fg-muted">{t("templates.waParamsHint", { example: "{{first_name}}" })}</span>
        </label>
      )}
      {error && (
        <Callout tone="danger" title={t("templates.notSaved")}>
          {error}
        </Callout>
      )}
    </Dialog>
  );
}

function approvalName(a: string, t: T) {
  const known = ["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED"] as const;
  return (known as readonly string[]).includes(a) ? t(`approval.${a as (typeof known)[number]}`) : a;
}

function approvalTone(a: string) {
  return a === "APPROVED" ? "success" : a === "PENDING" ? "warning" : "danger";
}

export function TemplatesPage({ call, settings }: { call: Call; settings: Settings }) {
  const t = useT();
  const { can } = useAuth();
  const [data, reload] = useLoad<{ templates: Template[] }>(call, "/api/v1/templates");
  const [active, setActive] = useState<string | null>(null);
  const [who, setWho] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dialog, setDialog] = useState<"new" | "edit" | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "success" | "danger" } | null>(null);
  const list = data?.templates ?? [];
  const cur = list.find((x) => x.id === active) ?? list[0];
  useEffect(() => {
    if (!cur) return;
    let live = true;
    void call<Preview>(`/api/v1/templates/${cur.id}/preview`, { method: "POST", body: JSON.stringify({ as: who }) }).then(
      (p) => live && setPreview(p),
      () => live && setPreview(null),
    );
    return () => {
      live = false;
    };
  }, [call, cur, who]);
  const cols: Column<Template>[] = [
    { id: "name", header: t("templates.template"), cell: (x) => <span className="font-mono text-xs font-medium">{x.name}</span> },
    { id: "channel", header: t("campaigns.channel"), cell: (x) => <Badge>{channelName(x.channel, t)}</Badge> },
    {
      id: "used",
      header: t("templates.usedBy"),
      cell: (x) => <span className="text-xs">{x.usedBy.length ? x.usedBy.join(", ") : t("templates.notUsed")}</span>,
    },
    {
      id: "approval",
      header: t("templates.approval"),
      cell: (x) =>
        x.channel === "whatsapp" ? (
          <StatusBadge tone={x.approval ? approvalTone(x.approval) : "neutral"}>
            {x.approval ? approvalName(x.approval, t) : t("templates.notAsked")}
          </StatusBadge>
        ) : (
          <span className="text-xs text-fg-muted">–</span>
        ),
    },
  ];
  const sync = () =>
    void call<{ updated: number; added: number }>("/api/v1/templates/sync", { method: "POST" }).then(
      (r) => (setNotice({ text: t("templates.synced", { updated: r.updated, added: r.added }), tone: "success" }), reload()),
      (err: Error) => setNotice({ text: err.message, tone: "danger" }),
    );
  return (
    <>
      <PageHeader
        title={t("templates.title")}
        description={t("templates.description", { example: "{{first_name}}" })}
        actions={
          can("editor") && (
            <>
              {settings.config.providers.whatsapp && (
                <Button icon={<RefreshCw />} onClick={sync}>
                  {t("templates.sync")}
                </Button>
              )}
              <Button variant="primary" icon={<Plus />} onClick={() => setDialog("new")}>
                {t("templates.new")}
              </Button>
            </>
          )
        }
      />
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {data && !list.length ? (
        <EmptyState title={t("templates.none")}>{t("templates.noneDetail")}</EmptyState>
      ) : (
        <div className="ms-halves grid gap-2.5">
          <Panel flush aria-label={t("templates.all")}>
            <DataTable
              label={t("templates.title")}
              columns={cols}
              rows={list}
              getRowId={(x) => x.id}
              onRowClick={(x) => (setActive(x.id), setWho(0))}
              activeRowId={cur?.id}
              minWidth={520}
              loading={data === undefined}
            />
          </Panel>
          {cur && (
            <Panel
              aria-label={t("templates.preview")}
              title={t("templates.previewOf", { name: cur.name })}
              actions={
                <span className="flex items-center gap-1.5">
                  {preview && preview.people.length > 1 && (
                    <SelectField
                      aria-label={t("templates.previewAs")}
                      value={String(who)}
                      onChange={(e) => setWho(Number(e.target.value))}
                      options={preview.people.map((p) => ({ value: String(p.index), label: t("templates.as", { name: p.name }) }))}
                      className="w-40"
                    />
                  )}
                  {can("editor") && (
                    <Button size="xs" icon={<Pencil />} onClick={() => setDialog("edit")}>
                      {t("templates.editButton")}
                    </Button>
                  )}
                </span>
              }
            >
              {preview ? (
                <div className="flex flex-col gap-2 rounded-md border border-line bg-canvas p-3 text-sm text-fg">
                  {cur.channel === "email" && (
                    <span className="text-xs text-fg-muted">{t("templates.fromSubject", { from: preview.from ?? "", subject: preview.subject ?? "" })}</span>
                  )}
                  {preview.html ? (
                    // The template's HTML is shown in a frame that runs no script and reaches nothing of this page.
                    <iframe title={t("templates.preview")} sandbox="" srcDoc={preview.html} className="ms-frame" />
                  ) : (
                    <p className="ms-pre m-0">{preview.text}</p>
                  )}
                  <span className="text-2xs text-fg-muted">
                    {cur.channel === "email"
                      ? t("templates.footEmail")
                      : cur.channel === "sms"
                        ? t("templates.footSms", { stop: settings.config.providers.sms?.stop ?? "" })
                        : t("templates.footWhatsApp")}
                  </span>
                </div>
              ) : (
                <p className="text-sm text-fg-muted">{t("loading")}</p>
              )}
            </Panel>
          )}
        </div>
      )}
      {dialog && (
        <TemplateDialog
          key={dialog === "edit" ? cur?.id : "new"}
          call={call}
          open
          onOpenChange={(o) => !o && setDialog(null)}
          editing={dialog === "edit" ? (cur ?? null) : null}
          onDone={(x) => {
            setDialog(null);
            setActive(x.id);
            setNotice({ text: t("templates.saved", { name: x.name }), tone: "success" });
            reload();
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- Bounces

export function BouncesPage({ call, onChanged }: { call: Call; onChanged: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [data, reload] = useLoad<{ bounces: Bounce[] }>(call, "/api/v1/bounces");
  const [optouts] = useLoad<{ optouts: OptOut[] }>(call, "/api/v1/optouts");
  const [notice, setNotice] = useState<string | null>(null);
  const cols: Column<Bounce>[] = [
    { id: "address", header: t("bounces.address"), cell: (b) => <span className="font-mono text-xs">{b.address}</span> },
    { id: "kind", header: t("bounces.bounce"), cell: (b) => <Badge tone={b.kind === "hard" ? "danger" : "warning"}>{t(`bounces.${b.kind}`)}</Badge> },
    { id: "reason", header: t("bounces.reason"), cell: (b) => <span className="text-xs">{b.reason}</span> },
    { id: "from", header: t("bounces.from"), cell: (b) => <span className="text-xs">{b.from ?? "–"}</span> },
    { id: "at", header: t("bounces.when"), cell: (b) => <span className="text-xs whitespace-nowrap">{when(b.at)}</span> },
    {
      id: "act",
      header: <span className="sr-only">{t("bounces.action")}</span>,
      label: t("bounces.action"),
      align: "right",
      cell: (b) =>
        b.kind === "hard" && can("editor") ? (
          <Button
            size="xs"
            onClick={() =>
              void call(`/api/v1/bounces/${b.id}`, { method: "DELETE" }).then(() => {
                setNotice(t("bounces.cleared", { address: b.address }));
                reload();
                onChanged();
              })
            }
          >
            {t("bounces.fixed")}
          </Button>
        ) : null,
    },
  ];
  const sources: Record<OptOut["source"], string> = { unsubscribe: t("optouts.unsubscribe"), stop: t("optouts.stop"), complaint: t("optouts.complaint") };
  return (
    <>
      <PageHeader title={t("bounces.title")} description={t("bounces.description")} />
      {notice && <Notice>{notice}</Notice>}
      <Panel flush title={t("bounces.notSentTo")} className="mb-2.5">
        <DataTable
          label={t("bounces.title")}
          columns={cols}
          rows={data?.bounces ?? []}
          getRowId={(b) => String(b.id)}
          minWidth={860}
          loading={data === undefined}
          empty={t("bounces.none")}
        />
      </Panel>
      <Panel flush title={t("optouts.title")} description={t("optouts.description")}>
        <DataTable
          label={t("optouts.title")}
          columns={[
            { id: "address", header: t("bounces.address"), cell: (o: OptOut) => <span className="font-mono text-xs">{o.address}</span> },
            { id: "channel", header: t("campaigns.channel"), cell: (o: OptOut) => <Badge>{channelName(o.channel, t)}</Badge> },
            { id: "source", header: t("optouts.how"), cell: (o: OptOut) => <span className="text-xs">{sources[o.source]}</span> },
            { id: "at", header: t("bounces.when"), cell: (o: OptOut) => <span className="text-xs whitespace-nowrap">{when(o.at)}</span> },
          ]}
          rows={optouts?.optouts ?? []}
          getRowId={(o) => `${o.channel}:${o.address}:${o.at}`}
          minWidth={600}
          pageSize={20}
          loading={optouts === undefined}
          empty={t("optouts.none")}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Integrations

export function IntegrationsPage({ call, settings, summary }: { call: Call; settings: Settings; summary: Summary | undefined }) {
  const t = useT();
  const { can } = useAuth();
  const [hooks] = useLoad<Hooks>(call, can("admin") ? "/api/v1/hooks" : null);
  const c = settings.config;
  const origin = settings.publicUrl;
  const link = (id: "consent" | "audience") => summary?.links.find((l) => l.id === id);
  const linkState = (id: "consent" | "audience") => {
    const l = link(id);
    if (!l?.linked) return <StatusBadge tone="neutral">{t("integrations.notLinked")}</StatusBadge>;
    if (!l.tokenSet) return <StatusBadge tone="warning">{t("integrations.tokenMissing", { name: l.tokenVariable ?? "" })}</StatusBadge>;
    if (l.error) return <StatusBadge tone="danger">{t("integrations.failing")}</StatusBadge>;
    return <StatusBadge tone="success">{l.okAt ? t("integrations.working") : t("integrations.linked")}</StatusBadge>;
  };
  const hook = (k: keyof Hooks) => (hooks ? hooks[k] : can("admin") ? t("loading") : t("integrations.adminsSee"));
  return (
    <>
      <PageHeader title={t("integrations.title")} description={t("integrations.description")} />
      <div className="ms-halves grid gap-2.5">
        <Panel title={t("integrations.consent")} description={t("integrations.consentDetail")} actions={linkState("consent")}>
          <p className="text-xs text-fg-muted">
            {c.consent.check === "consent"
              ? t("integrations.consentOn", { purpose: c.consent.purpose, channel: c.consent.whatsapp.toUpperCase() })
              : t("integrations.consentOwn")}
          </p>
          {link("consent")?.error && <p className="mt-1 text-xs text-danger-text">{link("consent")!.error}</p>}
        </Panel>
        <Panel title={t("integrations.audience")} description={t("integrations.audienceDetail")} actions={linkState("audience")}>
          <Code label={t("integrations.audience")}>{`# audience.yaml
sources:
  messages: { token: AUDIENCE_MESSAGES_TOKEN, url: ${origin}, delete: true }`}</Code>
          {link("audience")?.error && <p className="mt-1 text-xs text-danger-text">{link("audience")!.error}</p>}
        </Panel>
        <Panel title={t("integrations.analytics")} description={t("integrations.analyticsDetail")}>
          <Code
            label={t("integrations.analytics")}
          >{`https://www.example.com/pricing?utm_source=${c.tracking.utmSource}&utm_medium=email&utm_campaign=october-newsletter`}</Code>
        </Panel>
        <Panel title={t("integrations.events")} description={t("integrations.eventsDetail")}>
          <Code label={t("integrations.events")}>{`curl -s -X POST ${origin}/api/v1/events -H "authorization: Bearer $TOKEN" \\
  -H "content-type: application/json" -d '{ "events": [{ "type": "signup",
  "person": { "email": "gizem@example.com", "userId": "u-0877", "name": "Gizem Avcı" } }] }'`}</Code>
          <p className="mt-2 text-xs">
            <a href="/api/docs/">{t("integrations.reference")}</a>
          </p>
        </Panel>
        {c.providers.email && (
          <Panel title={t("integrations.ses")} description={t("integrations.sesDetail")}>
            <Code label={t("integrations.ses")}>{hook("ses")}</Code>
          </Panel>
        )}
        {c.providers.sms && (
          <Panel
            title={t("integrations.sms", { provider: c.providers.sms.kind === "netgsm" ? "Netgsm" : "İleti Merkezi" })}
            description={t("integrations.smsDetail")}
          >
            <dl className="ms-facts grid gap-x-2 gap-y-1 text-xs">
              <dt className="text-fg-muted">{t("integrations.reports")}</dt>
              <dd className="m-0 font-mono break-all">{hook("smsReports")}</dd>
              <dt className="text-fg-muted">{t("integrations.inbound")}</dt>
              <dd className="m-0 font-mono break-all">{hook("smsInbound")}</dd>
            </dl>
          </Panel>
        )}
        {c.providers.whatsapp && (
          <Panel title={t("integrations.whatsapp")} description={t("integrations.whatsappDetail", { token: String(c.providers.whatsapp.verifyToken ?? "") })}>
            <Code label={t("integrations.whatsapp")}>{hook("whatsapp")}</Code>
          </Panel>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Settings

function providerLine(p: Record<string, unknown> & { kind: string; rate: number }, t: T): string {
  const rate = t("settings.rate", { rate: p.rate });
  if (p.kind === "ses") return `Amazon SES, ${String(p.region)} · ${rate}`;
  if (p.kind === "smtp") return `${String(p.host)}:${String(p.port)} (${String(p.security)}) · ${rate}`;
  if (p.kind === "netgsm" || p.kind === "iletimerkezi")
    return `${p.kind === "netgsm" ? "Netgsm" : "İleti Merkezi"}, ${t("settings.senderName", { name: String(p.sender) })} · ${rate}`;
  return `WhatsApp Business, ${String(p.phoneNumberId)} · ${rate}`;
}

export function SettingsFilePage({ settings }: { settings: Settings }) {
  const t = useT();
  const ago = useAgo();
  const c = settings.config;
  const file = settings.file;
  const name = file?.path.split("/").pop() ?? "messages.yaml";
  const e = c.providers.email;
  return (
    <FileSettingsPage
      file={name}
      applied={file?.appliedAt ? ago(file.appliedAt) : t("settings.notYet")}
      yaml={settings.yaml || t("settings.noFile")}
      problems={
        file && (file.error || file.warnings.length > 0) ? (
          <Callout tone={file.error ? "danger" : "warning"} title={file.error ? t("settings.notApplied") : t("settings.warnings")} className="mb-2.5">
            <ul className="ms-list flex flex-col gap-1">
              {[...(file.error ? [file.error] : []), ...file.warnings].map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        ) : undefined
      }
      groups={[
        {
          title: t("settings.providers"),
          description: t("settings.providersDetail"),
          items: [
            {
              label: t("channel.email"),
              value: e
                ? `${providerLine(e.primary, t)}${e.fallback ? `; ${t("settings.fallback", { line: providerLine(e.fallback, t) })}` : ""}`
                : t("settings.none"),
              path: "providers.email",
            },
            { label: t("channel.sms"), value: c.providers.sms ? providerLine(c.providers.sms, t) : t("settings.none"), path: "providers.sms" },
            {
              label: t("channel.whatsapp"),
              value: c.providers.whatsapp ? providerLine(c.providers.whatsapp, t) : t("settings.none"),
              path: "providers.whatsapp",
            },
            {
              label: t("settings.keys"),
              value: settings.variables.length ? (
                <ul className="ms-list flex flex-col gap-0.5">
                  {settings.variables.map((v) => (
                    <li key={v.name} className="flex items-center gap-1.5">
                      <code className="font-mono text-2xs">{v.name}</code>
                      <StatusBadge tone={v.set ? "success" : "warning"}>{v.set ? t("settings.set") : t("settings.notSet")}</StatusBadge>
                    </li>
                  ))}
                </ul>
              ) : (
                t("settings.none")
              ),
              path: "environment",
            },
          ],
        },
        {
          title: t("settings.sending"),
          items: [
            { label: t("settings.sender"), value: c.sender.email ? `${c.sender.name} <${c.sender.email}>` : c.sender.name, path: "sender" },
            {
              label: t("settings.consent"),
              value: c.consent.check === "consent" ? t("settings.consentValue", { purpose: c.consent.purpose }) : t("settings.consentOwn"),
              path: "consent.check",
            },
            {
              label: t("settings.quiet"),
              value: c.limits.quietHours ? t("settings.quietValue", { span: c.limits.quietHours.text, zone: c.limits.timezone }) : t("settings.off"),
              path: "limits.quiet_hours",
            },
            { label: t("settings.softBounces"), value: t("settings.softBouncesValue", { count: c.limits.softBounceTries }), path: "limits.soft_bounce_tries" },
            { label: t("settings.links"), value: t("settings.linksValue", { source: c.tracking.utmSource }), path: "tracking" },
            { label: t("settings.opens"), value: c.tracking.opens ? t("settings.on") : t("settings.off"), path: "tracking.opens" },
          ],
        },
      ]}
    />
  );
}
