// Campaigns: the list with results, one campaign beside it, and the dialog that makes one.
import {
  Badge,
  BarList,
  Button,
  Callout,
  Checkbox,
  DataTable,
  Dialog,
  PageHeader,
  Panel,
  SegmentedControl,
  SelectField,
  StatusBadge,
  TextField,
  type Column,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Pause, Play, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Campaign, Channel, Estimate, List, Segment, Settings, Template } from "./api.ts";
import { CHANNEL_ICON, Notice, STATE_TONE, channelName, fmt, localInput, pct, tomorrowTen, useLoad, when, type Call } from "./common.tsx";
import { useT, type T } from "./i18n.ts";

const CHANNELS: Channel[] = ["email", "sms", "whatsapp"];

/** People whose consent held when their message was sent: consent is only known at that moment. */
const allowedOf = (c: Campaign) => c.counts.sent + c.counts.failed + c.counts.unknown;

export function providerOf(settings: Settings, channel: Channel): string | null {
  const p = settings.config.providers;
  if (channel === "email") return p.email ? (p.email.primary.kind === "ses" ? "Amazon SES" : String(p.email.primary.host ?? "SMTP")) : null;
  if (channel === "sms") return p.sms ? (p.sms.kind === "netgsm" ? "Netgsm" : "İleti Merkezi") : null;
  return p.whatsapp ? "WhatsApp Business" : null;
}

function whenText(c: Campaign, t: T) {
  if (c.state === "draft") return t("campaigns.notScheduled");
  if (c.state === "paused") return t("campaigns.paused");
  if (c.state === "scheduled") return when(c.scheduledAt);
  if (c.state === "sending") return when(c.startedAt);
  return when(c.finishedAt ?? c.startedAt);
}

function NewCampaignDialog({
  call,
  open,
  onOpenChange,
  onDone,
  templates,
}: {
  call: Call;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (c: Campaign, scheduled: boolean) => void;
  templates: Template[];
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<Channel>("email");
  const [audience, setAudience] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [ab, setAb] = useState(false);
  const [subjectB, setSubjectB] = useState("");
  const [templateB, setTemplateB] = useState("");
  const [estimate, setEstimate] = useState<Estimate | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [segments] = useLoad<{ segments: Segment[] }>(call, open ? "/api/v1/segments" : null);
  const [lists] = useLoad<{ lists: List[] }>(call, open ? "/api/v1/lists" : null);
  const options = useMemo(
    () => [
      ...(segments?.segments ?? []).map((s) => ({ value: `segment:${s.id}`, label: `${s.name} · ${fmt(s.size)}` })),
      ...(lists?.lists ?? []).map((l) => ({ value: `list:${l.id}`, label: t("campaigns.listOption", { name: l.name, size: fmt(l.size) }) })),
    ],
    [segments, lists, t],
  );
  const ofChannel = templates.filter((x) => x.channel === channel);
  const chosenAudience = audience || options[0]?.value || "";
  const chosenTemplate = ofChannel.some((x) => x.id === templateId) ? templateId : (ofChannel[0]?.id ?? "");
  const [kind, id] = chosenAudience.split(/:(.*)/s) as ["segment" | "list", string];

  useEffect(() => {
    if (!open || !chosenAudience) return;
    let live = true;
    setEstimate(undefined);
    void call<Estimate>("/api/v1/estimate", { method: "POST", body: JSON.stringify({ channel, audience: { kind, id } }) }).then(
      (e) => live && setEstimate(e),
      () => live && setEstimate(null),
    );
    return () => {
      live = false;
    };
  }, [call, open, channel, chosenAudience, kind, id]);

  async function submit(schedule: boolean) {
    setError(null);
    try {
      const abBody = ab ? (channel === "email" && subjectB.trim() ? { subject: subjectB.trim() } : { templateId: templateB || null }) : null;
      const c = await call<Campaign>("/api/v1/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          channel,
          audience: { kind, id, name: options.find((o) => o.value === chosenAudience)?.label.split(" · ")[0] },
          templateId: chosenTemplate,
          ab: abBody,
        }),
      });
      const done = schedule
        ? await call<Campaign>(`/api/v1/campaigns/${c.id}/schedule`, { method: "POST", body: JSON.stringify({ at: tomorrowTen().toISOString() }) })
        : c;
      setName("");
      setAb(false);
      onDone(done, schedule);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const ready = !!name.trim() && !!chosenAudience && !!chosenTemplate;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("campaigns.new")}
      description={t("campaigns.newDetail")}
      size="lg"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void submit(true);
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={!ready} onClick={() => void submit(false)}>
            {t("campaigns.saveDraft")}
          </Button>
          <Button type="submit" variant="primary" disabled={!ready}>
            {t("campaigns.scheduleTomorrow")}
          </Button>
        </>
      }
    >
      <TextField label={t("campaigns.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("campaigns.namePlaceholder")} />
      <SegmentedControl
        label={t("campaigns.channel")}
        value={channel}
        onChange={setChannel}
        options={CHANNELS.map((c) => ({ value: c, label: channelName(c, t) }))}
      />
      {options.length ? (
        <SelectField label={t("campaigns.audience")} value={chosenAudience} onChange={(e) => setAudience(e.target.value)} options={options} />
      ) : (
        <p className="text-sm text-fg-muted">{segments === null ? t("campaigns.noAudienceLinked") : t("campaigns.noAudience")}</p>
      )}
      {ofChannel.length ? (
        <SelectField
          label={t("campaigns.template")}
          value={chosenTemplate}
          onChange={(e) => setTemplateId(e.target.value)}
          options={ofChannel.map((x) => ({ value: x.id, label: x.subject ? `${x.name} · ${x.subject}` : x.name }))}
        />
      ) : (
        <p className="text-sm text-fg-muted">{t("campaigns.noTemplate", { channel: channelName(channel, t) })}</p>
      )}
      <Checkbox label={t("campaigns.abTest")} description={t("campaigns.abTestDetail")} checked={ab} onChange={(e) => setAb(e.target.checked)} />
      {ab &&
        (channel === "email" ? (
          <TextField label={t("campaigns.subjectB")} value={subjectB} onChange={(e) => setSubjectB(e.target.value)} />
        ) : (
          <SelectField
            label={t("campaigns.templateB")}
            value={templateB}
            onChange={(e) => setTemplateB(e.target.value)}
            options={[{ value: "", label: "–" }, ...ofChannel.filter((x) => x.id !== chosenTemplate).map((x) => ({ value: x.id, label: x.name }))]}
          />
        ))}
      <p role="status" className="rounded-md bg-canvas px-2.5 py-2 text-sm text-fg">
        {estimate === undefined ? (
          t("campaigns.estimating")
        ) : estimate === null ? (
          t("campaigns.estimateFailed")
        ) : (
          <>
            <span className="font-semibold">{fmt(estimate.allowed)}</span> {t(`campaigns.mayGet.${channel}`, { size: fmt(estimate.size) })}{" "}
            {t("campaigns.othersNoYes", { channel: channelName(channel, t) })}
            {estimate.counted < estimate.size && ` ${t("campaigns.counted", { count: estimate.counted })}`}
          </>
        )}
      </p>
      {error && (
        <Callout tone="danger" title={t("campaigns.notSaved")}>
          {error}
        </Callout>
      )}
    </Dialog>
  );
}

function CampaignPanel({ c, settings, call, onChanged }: { c: Campaign; settings: Settings; call: Call; onChanged: (c: Campaign, notice: string) => void }) {
  const t = useT();
  const { can } = useAuth();
  const [at, setAt] = useState(localInput(tomorrowTen()));
  const ch = channelName(c.channel, t);
  const allowed = allowedOf(c);
  const steps = [
    { id: "allowed", label: t("campaigns.consentHeld"), value: allowed },
    { id: "delivered", label: t("campaigns.delivered"), value: c.counts.delivered },
    {
      id: "opened",
      label: c.channel === "sms" ? t("campaigns.readSms") : c.channel === "whatsapp" ? t("campaigns.read") : t("campaigns.opened"),
      value: c.counts.opened,
    },
    { id: "clicked", label: t("campaigns.clicked"), value: c.counts.clicked },
  ];
  const act = async (path: string, body?: unknown) => {
    const r = await call<Campaign>(`/api/v1/campaigns/${c.id}/${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
    return r;
  };
  const provider = providerOf(settings, c.channel) ?? t("campaigns.noProvider");
  return (
    <Panel
      aria-label={t("campaigns.campaign")}
      title={c.name}
      description={`${t("campaigns.through", { channel: ch, provider })} · ${c.audience.name} · ${whenText(c, t)}`}
      actions={<StatusBadge tone={STATE_TONE[c.state]}>{t(`state.${c.state}`)}</StatusBadge>}
    >
      <div className="flex flex-col gap-3">
        {c.startedAt && (
          <p className="text-xs text-fg-muted">
            {t("campaigns.heldBack", { audience: fmt(c.audienceSize), held: fmt(c.counts.held), channel: ch })}
            {c.noAddress > 0 && ` ${t("campaigns.noAddress", { count: c.noAddress })}`}
            {c.counts.queued + c.counts.waiting > 0 && ` ${t("campaigns.toGo", { count: c.counts.queued + c.counts.waiting })}`}
          </p>
        )}
        {c.problem && (
          <Callout tone="warning" title={t("campaigns.problem")}>
            {c.problem}
          </Callout>
        )}
        {c.state === "draft" || c.state === "scheduled" || (c.state === "paused" && !c.startedAt) ? (
          <Callout tone="info" title={c.state === "scheduled" ? t("campaigns.sends", { when: when(c.scheduledAt) }) : t("campaigns.notScheduledYet")}>
            {c.state === "scheduled"
              ? `${t("campaigns.askedAgain")}${c.optOutsSince ? ` ${t("campaigns.optOutsSince", { count: c.optOutsSince })}` : ""}`
              : t("campaigns.chooseTime")}
          </Callout>
        ) : (
          <BarList label={t("campaigns.results")} items={steps} max={Math.max(1, allowed)} format={(v) => `${fmt(v)} · ${pct(v, allowed)}`} />
        )}
        {c.ab && (
          <section aria-label={t("campaigns.abTest")} className="flex flex-col gap-1.5 border-t border-line pt-2.5">
            <h3 className="text-xs font-semibold text-fg-muted">
              {t("campaigns.abHeading", { share: c.ab.share, metric: t(`campaigns.metric.${c.ab.metric}`) })}
            </h3>
            {(["a", "b"] as const).map((k) => (
              <div key={k} className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm ${c.ab!.winner === k ? "ms-winner" : "border-line"}`}>
                <Badge mono>{k.toUpperCase()}</Badge>
                <span className="min-w-0 grow truncate text-fg">{c.ab![k]}</span>
                <span className="shrink-0 font-mono text-xs tabular-nums">
                  {c.ab!.results[k].rate === null ? "–" : t(`campaigns.rate.${c.ab!.metric}`, { rate: c.ab!.results[k].rate })}
                </span>
                {c.ab!.winner === k && <StatusBadge tone="success">{t("campaigns.winner")}</StatusBadge>}
              </div>
            ))}
          </section>
        )}
        {c.startedAt && (
          <dl className="ms-facts grid gap-x-2 gap-y-1 border-t border-line pt-2.5 text-xs">
            <dt className="text-fg-muted">{t("campaigns.unsubscribed")}</dt>
            <dd className="m-0 text-fg">{t("campaigns.unsubscribedValue", { count: c.counts.unsubscribed, n: fmt(c.counts.unsubscribed) })}</dd>
            <dt className="text-fg-muted">{t("campaigns.bounced")}</dt>
            <dd className="m-0 text-fg">{t("campaigns.bouncedValue", { n: fmt(c.counts.bounced) })}</dd>
            {c.counts.unknown > 0 && (
              <>
                <dt className="text-fg-muted">{t("campaigns.unknown")}</dt>
                <dd className="m-0 text-fg">{t("campaigns.unknownValue", { n: fmt(c.counts.unknown) })}</dd>
              </>
            )}
            {c.counts.failed > 0 && (
              <>
                <dt className="text-fg-muted">{t("campaigns.failed")}</dt>
                <dd className="m-0 text-fg">{fmt(c.counts.failed)}</dd>
              </>
            )}
          </dl>
        )}
        {can("editor") && (c.state === "scheduled" || c.state === "sending") && (
          <div>
            <Button size="sm" icon={<Pause />} onClick={() => void act("pause").then((r) => onChanged(r, t("campaigns.pausedNotice", { name: c.name })))}>
              {t("campaigns.pause")}
            </Button>
          </div>
        )}
        {can("editor") && (c.state === "draft" || c.state === "paused") && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void act("schedule", { at: new Date(at).toISOString() }).then((r) =>
                onChanged(r, t("campaigns.scheduledNotice", { name: c.name, when: when(r.scheduledAt) })),
              );
            }}
          >
            <TextField
              label={c.startedAt ? t("campaigns.resumeAt") : t("campaigns.sendAt")}
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
            <Button size="sm" type="submit" variant="primary" icon={<Play />}>
              {c.startedAt ? t("campaigns.resume") : t("campaigns.schedule")}
            </Button>
          </form>
        )}
      </div>
    </Panel>
  );
}

export function CampaignsPage({ call, settings, onChanged }: { call: Call; settings: Settings; onChanged: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [data, reload] = useLoad<{ campaigns: Campaign[] }>(call, "/api/v1/campaigns");
  const [templates] = useLoad<{ templates: Template[] }>(call, "/api/v1/templates");
  const [active, setActive] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(reload, 10_000);
    return () => clearInterval(timer);
  }, [reload]);
  const rows = data?.campaigns ?? [];
  const cur = rows.find((c) => c.id === active) ?? rows[0];
  const cols: Column<Campaign>[] = [
    {
      id: "name",
      header: t("campaigns.campaign"),
      width: "32%",
      cell: (c) => {
        const Icon = CHANNEL_ICON[c.channel];
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Icon aria-label={channelName(c.channel, t)} className="size-3.5 shrink-0 text-fg-muted" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{c.name}</span>
              <span className="truncate text-2xs text-fg-muted">{c.audience.name}</span>
            </span>
          </span>
        );
      },
    },
    { id: "state", header: t("campaigns.state"), cell: (c) => <StatusBadge tone={STATE_TONE[c.state]}>{t(`state.${c.state}`)}</StatusBadge> },
    { id: "when", header: t("campaigns.when"), cell: (c) => <span className="text-xs whitespace-nowrap">{whenText(c, t)}</span> },
    {
      id: "allowed",
      header: t("campaigns.recipients"),
      align: "right",
      mono: true,
      sortValue: allowedOf,
      cell: (c) => (c.startedAt ? fmt(allowedOf(c)) : "–"),
    },
    {
      id: "opened",
      header: t("campaigns.opened"),
      align: "right",
      cell: (c) => <span className="font-mono text-xs">{c.counts.sent && c.channel !== "sms" ? pct(c.counts.opened, c.counts.sent) : "–"}</span>,
    },
    {
      id: "clicked",
      header: t("campaigns.clicked"),
      align: "right",
      cell: (c) => <span className="font-mono text-xs">{c.counts.sent ? pct(c.counts.clicked, c.counts.sent) : "–"}</span>,
    },
  ];
  return (
    <>
      <PageHeader
        title={t("campaigns.title")}
        description={t("campaigns.description")}
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              {t("campaigns.new")}
            </Button>
          )
        }
      />
      {notice && <Notice>{notice}</Notice>}
      <div className="ms-split-side-wide grid gap-2.5">
        <Panel flush aria-label={t("campaigns.all")}>
          <DataTable
            label={t("campaigns.title")}
            columns={cols}
            rows={rows}
            getRowId={(c) => c.id}
            onRowClick={(c) => setActive(c.id)}
            activeRowId={cur?.id}
            minWidth={680}
            loading={data === undefined}
            empty={t("campaigns.none")}
          />
        </Panel>
        {cur && (
          <CampaignPanel
            key={cur.id}
            c={cur}
            settings={settings}
            call={call}
            onChanged={(_c, n) => {
              setNotice(n);
              reload();
              onChanged();
            }}
          />
        )}
      </div>
      <NewCampaignDialog
        call={call}
        open={creating}
        onOpenChange={setCreating}
        templates={templates?.templates ?? []}
        onDone={(c, scheduled) => {
          setCreating(false);
          setActive(c.id);
          setNotice(scheduled ? t("campaigns.createdScheduled", { name: c.name, when: when(c.scheduledAt) }) : t("campaigns.createdDraft", { name: c.name }));
          reload();
          onChanged();
        }}
      />
    </>
  );
}
