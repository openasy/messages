// Journeys: each one's steps with who is at each, its state, and the dialog that makes one.
import { Button, Callout, Dialog, EmptyState, KpiCard, KpiGrid, PageHeader, Panel, SelectField, StatusBadge, Tabs, TextField } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Ban, Clock, GitBranch, Pause, Play, Plus, Trash2, type LucideIcon } from "lucide-react";
import { useState } from "react";
import type { Channel, Journey, Segment, Step, Template } from "./api.ts";
import { CHANNEL_ICON, Notice, channelName, fmt, pct, useLoad, type Call } from "./common.tsx";
import { useT, type T } from "./i18n.ts";

const STEP_ICON: Record<"trigger" | "wait" | "branch" | "exit", LucideIcon> = { trigger: Play, wait: Clock, branch: GitBranch, exit: Ban };

function duration(minutes: number, t: T) {
  if (minutes % 1440 === 0) return t("journeys.days", { count: minutes / 1440 });
  if (minutes % 60 === 0) return t("journeys.hours", { count: minutes / 60 });
  return t("journeys.minutes", { count: minutes });
}

function goalText(j: Journey, t: T) {
  const goal = j.goal?.kind === "event" ? t("journeys.goalEvent", { event: j.goal.event }) : j.goal?.kind === "segment-left" ? t("journeys.goalLeft") : null;
  return goal ? t("journeys.leavesOn", { goal }) : t("journeys.leavesOptOut");
}

interface Row {
  id: string;
  kind: "trigger" | "send" | "wait" | "branch" | "exit";
  title: string;
  detail: string;
  channel?: Channel;
  now: number;
  passed: number;
}

function rows(j: Journey, templates: Template[], t: T): Row[] {
  const stat = (id: string): Journey["stats"]["steps"][number] => j.stats.steps.find((s) => s.id === id) ?? { id, now: 0, passed: 0 };
  const tname = (id: string) => templates.find((x) => x.id === id)?.name ?? id;
  const title = (s: Step) => s.title || s.id;
  const out: Row[] = [
    {
      id: "trigger",
      kind: "trigger",
      title: j.trigger.kind === "event" ? t("journeys.triggerEvent", { event: j.trigger.event }) : t("journeys.triggerSegment", { name: j.trigger.name }),
      detail: j.trigger.kind === "event" ? t("journeys.triggerEventDetail", { event: j.trigger.event }) : t("journeys.triggerSegmentDetail"),
      now: 0,
      passed: j.stats.entered,
    },
  ];
  j.steps.forEach((s, i) => {
    const st = stat(s.id);
    if (s.kind === "send") {
      const sent = st.sent ?? 0;
      const held = st.held ?? 0;
      out.push({
        id: s.id,
        kind: "send",
        channel: s.channel,
        title: s.title || t("journeys.sendTitle", { channel: channelName(s.channel, t) }),
        detail: held
          ? t("journeys.onlyWithConsent", { channel: channelName(s.channel, t), sent: fmt(sent), of: fmt(st.passed) })
          : t("journeys.templateDetail", { name: tname(s.templateId) }),
        now: st.now,
        passed: st.passed,
      });
    } else if (s.kind === "wait")
      out.push({
        id: s.id,
        kind: "wait",
        title: s.title || t("journeys.waitTitle", { time: duration(s.minutes, t) }),
        detail: "",
        now: st.now,
        passed: st.passed,
      });
    else if (s.kind === "branch") {
      const test =
        s.test === "consent"
          ? t("journeys.testConsent", { channel: channelName(s.channel ?? "email", t) })
          : s.test === "field"
            ? t("journeys.testField", { field: s.field ?? "", value: s.value ?? "" })
            : t(`journeys.test.${s.test}${s.negate ? "Not" : ""}`);
      const next = j.stats.steps[i + 1]?.passed ?? 0;
      const others =
        s.otherwise === "exit"
          ? t("journeys.othersLeave", { yes: fmt(next), no: fmt(Math.max(0, st.passed - next)) })
          : t("journeys.othersGo", { step: j.steps.find((x) => x.id === s.otherwise)?.title || s.otherwise });
      out.push({ id: s.id, kind: "branch", title: s.title || test, detail: s.title ? `${test} · ${others}` : others, now: st.now, passed: st.passed });
    } else out.push({ id: s.id, kind: "exit", title: title(s) === s.id ? t("journeys.leaves") : title(s), detail: goalText(j, t), now: 0, passed: st.passed });
  });
  if (j.steps.at(-1)?.kind !== "exit")
    out.push({ id: "end", kind: "exit", title: t("journeys.leaves"), detail: goalText(j, t), now: 0, passed: j.stats.converted });
  return out;
}

type Draft = {
  kind: Step["kind"];
  channel: Channel;
  templateId: string;
  minutes: number;
  unit: "minutes" | "hours" | "days";
  test: "opened" | "clicked" | "consent";
  negate: boolean;
};
const blank = (kind: Step["kind"]): Draft => ({ kind, channel: "email", templateId: "", minutes: 1, unit: "days", test: "opened", negate: true });

function NewJourneyDialog({
  call,
  open,
  onOpenChange,
  templates,
  onDone,
}: {
  call: Call;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  templates: Template[];
  onDone: (j: Journey) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<"event" | "segment">("event");
  const [event, setEvent] = useState("signup");
  const [segment, setSegment] = useState("");
  const [goal, setGoal] = useState("");
  const [steps, setSteps] = useState<Draft[]>([blank("send")]);
  const [error, setError] = useState<string | null>(null);
  const [segments] = useLoad<{ segments: Segment[] }>(call, open ? "/api/v1/segments" : null);
  const set = (i: number, patch: Partial<Draft>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const segs = segments?.segments ?? [];
  const chosenSegment = segment || segs[0]?.id || "";

  async function submit() {
    setError(null);
    const factor = { minutes: 1, hours: 60, days: 1440 };
    const body = {
      name: name.trim(),
      trigger:
        trigger === "event"
          ? { kind: "event", event: event.trim() }
          : { kind: "segment", segment: chosenSegment, name: segs.find((s) => s.id === chosenSegment)?.name },
      goal: goal === "segment-left" ? { kind: "segment-left" } : goal.trim() ? { kind: "event", event: goal.trim() } : null,
      steps: steps.map((s, i) => {
        const id = `s${i + 1}`;
        if (s.kind === "send") return { id, kind: "send", channel: s.channel, templateId: s.templateId || templates.find((x) => x.channel === s.channel)?.id };
        if (s.kind === "wait") return { id, kind: "wait", minutes: Math.round(s.minutes * factor[s.unit]) };
        if (s.kind === "branch")
          return {
            id,
            kind: "branch",
            test: s.test,
            negate: s.test === "consent" ? false : s.negate,
            channel: s.test === "consent" ? s.channel : null,
            otherwise: "exit",
          };
        return { id, kind: "exit" };
      }),
    };
    try {
      const j = await call<Journey>("/api/v1/journeys", { method: "POST", body: JSON.stringify(body) });
      setName("");
      setSteps([blank("send")]);
      onDone(j);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("journeys.new")}
      description={t("journeys.newDetail")}
      size="lg"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void submit();
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {t("journeys.saveDraft")}
          </Button>
        </>
      }
    >
      <TextField label={t("journeys.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("journeys.namePlaceholder")} />
      <div className="ms-two grid gap-2">
        <SelectField
          label={t("journeys.trigger")}
          value={trigger}
          onChange={(e) => setTrigger(e.target.value as "event" | "segment")}
          options={[
            { value: "event", label: t("journeys.triggerKindEvent") },
            { value: "segment", label: t("journeys.triggerKindSegment") },
          ]}
        />
        {trigger === "event" ? (
          <TextField label={t("journeys.event")} value={event} onChange={(e) => setEvent(e.target.value)} mono />
        ) : (
          <SelectField
            label={t("journeys.segment")}
            value={chosenSegment}
            onChange={(e) => setSegment(e.target.value)}
            options={segs.map((s) => ({ value: s.id, label: s.name }))}
          />
        )}
      </div>
      <TextField
        label={t("journeys.goal")}
        hint={trigger === "segment" ? t("journeys.goalHintSegment") : t("journeys.goalHint")}
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="invoice_sent"
        mono
      />
      <fieldset className="flex flex-col gap-2 border-0">
        <legend className="mb-1 text-xs font-semibold text-fg-muted">{t("journeys.steps")}</legend>
        <ol aria-label={t("journeys.stepsToMake")} className="ms-list flex flex-col gap-2">
          {steps.map((s, i) => (
            <li key={i} className="ms-step-edit grid items-end gap-2 rounded-md border border-line p-2">
              <SelectField
                aria-label={t("journeys.stepKind", { n: i + 1 })}
                value={s.kind}
                onChange={(e) => set(i, { kind: e.target.value as Step["kind"] })}
                options={(["send", "wait", "branch", "exit"] as const).map((k) => ({ value: k, label: t(`journeys.kind.${k}`) }))}
              />
              {s.kind === "send" && (
                <>
                  <SelectField
                    aria-label={t("campaigns.channel")}
                    value={s.channel}
                    onChange={(e) => set(i, { channel: e.target.value as Channel, templateId: "" })}
                    options={(["email", "sms", "whatsapp"] as const).map((c) => ({ value: c, label: channelName(c, t) }))}
                  />
                  <SelectField
                    aria-label={t("campaigns.template")}
                    value={s.templateId}
                    onChange={(e) => set(i, { templateId: e.target.value })}
                    options={templates.filter((x) => x.channel === s.channel).map((x) => ({ value: x.id, label: x.name }))}
                  />
                </>
              )}
              {s.kind === "wait" && (
                <>
                  <TextField
                    aria-label={t("journeys.howLong")}
                    label=""
                    type="number"
                    min={1}
                    value={s.minutes}
                    onChange={(e) => set(i, { minutes: Number(e.target.value) || 1 })}
                  />
                  <SelectField
                    aria-label={t("journeys.unitLabel")}
                    value={s.unit}
                    onChange={(e) => set(i, { unit: e.target.value as Draft["unit"] })}
                    options={(["minutes", "hours", "days"] as const).map((u) => ({ value: u, label: t(`journeys.unit.${u}`) }))}
                  />
                </>
              )}
              {s.kind === "branch" && (
                <>
                  <SelectField
                    aria-label={t("journeys.testLabel")}
                    value={s.test === "consent" ? "consent" : `${s.test}:${s.negate ? "not" : "yes"}`}
                    onChange={(e) => {
                      const [test, n] = e.target.value.split(":");
                      set(i, { test: test as Draft["test"], negate: n === "not" });
                    }}
                    options={[
                      { value: "opened:not", label: t("journeys.test.openedNot") },
                      { value: "opened:yes", label: t("journeys.test.opened") },
                      { value: "clicked:not", label: t("journeys.test.clickedNot") },
                      { value: "clicked:yes", label: t("journeys.test.clicked") },
                      { value: "consent", label: t("journeys.testConsentPick") },
                    ]}
                  />
                  {s.test === "consent" ? (
                    <SelectField
                      aria-label={t("campaigns.channel")}
                      value={s.channel}
                      onChange={(e) => set(i, { channel: e.target.value as Channel })}
                      options={(["email", "sms", "whatsapp"] as const).map((c) => ({ value: c, label: channelName(c, t) }))}
                    />
                  ) : (
                    <span className="pb-1.5 text-xs text-fg-muted">{t("journeys.othersLeaveShort")}</span>
                  )}
                </>
              )}
              {s.kind === "exit" && <span className="pb-1.5 text-xs text-fg-muted">{t("journeys.exitShort")}</span>}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                icon={<Trash2 />}
                aria-label={t("journeys.removeStep", { n: i + 1 })}
                onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}
                disabled={steps.length === 1}
              />
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-1.5">
          {(["send", "wait", "branch", "exit"] as const).map((k) => (
            <Button key={k} type="button" size="xs" icon={<Plus />} onClick={() => setSteps((s) => [...s, blank(k)])}>
              {t(`journeys.kind.${k}`)}
            </Button>
          ))}
        </div>
      </fieldset>
      {error && (
        <Callout tone="danger" title={t("journeys.notSaved")}>
          {error}
        </Callout>
      )}
    </Dialog>
  );
}

export function JourneysPage({ call, onChanged }: { call: Call; onChanged: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [data, reload] = useLoad<{ journeys: Journey[] }>(call, "/api/v1/journeys");
  const [templates] = useLoad<{ templates: Template[] }>(call, "/api/v1/templates");
  const [id, setId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const list = data?.journeys ?? [];
  const j = list.find((x) => x.id === id) ?? list[0];
  const label = (x: Journey) => t(`journeyState.${x.state}`);
  const act = (path: string) =>
    void call<Journey>(`/api/v1/journeys/${j!.id}/${path}`, { method: "POST" }).then(
      () => {
        setNotice(null);
        reload();
        onChanged();
      },
      (err: Error) => setNotice(err.message),
    );
  return (
    <>
      <PageHeader
        title={t("journeys.title")}
        description={t("journeys.description")}
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              {t("journeys.new")}
            </Button>
          )
        }
      />
      {notice && <Notice tone="danger">{notice}</Notice>}
      {data && !list.length && <EmptyState title={t("journeys.none")}>{t("journeys.noneDetail")}</EmptyState>}
      {j && (
        <>
          <div className="mb-2.5">
            <Tabs label={t("journeys.journey")} value={j.id} onChange={setId} items={list.map((x) => ({ value: x.id, label: x.name, count: label(x) }))} />
          </div>
          <div className="ms-split-side grid gap-2.5">
            <Panel aria-label={t("journeys.steps")} title={t("journeys.stepsOf", { name: j.name })} description={t("journeys.stepsDetail")}>
              <ol aria-label={t("journeys.journeySteps")} className="ms-list flex flex-col">
                {rows(j, templates?.templates ?? [], t).map((s, i, all) => {
                  const Icon = s.kind === "send" && s.channel ? CHANNEL_ICON[s.channel] : STEP_ICON[s.kind as keyof typeof STEP_ICON];
                  return (
                    <li key={s.id} className="ms-step relative flex gap-3 pb-3 last:pb-0">
                      {i < all.length - 1 && <span aria-hidden className="ms-step-line" />}
                      <span
                        className={`ms-step-dot grid size-7 shrink-0 place-items-center rounded-full border ${s.kind === "send" ? "border-accent/30 bg-accent-soft text-accent" : "border-line bg-surface text-fg-muted"}`}
                      >
                        <Icon aria-hidden className="size-3.5" />
                      </span>
                      <span className="flex min-w-0 grow flex-col">
                        <span className="text-sm font-medium text-fg">{s.title}</span>
                        {s.detail && <span className="text-xs text-fg-muted">{s.detail}</span>}
                      </span>
                      <span className="shrink-0 text-end font-mono text-xs tabular-nums">
                        {fmt(s.passed)}
                        {s.now > 0 && <span className="block text-2xs text-accent-text">{t("journeys.hereNow", { count: s.now })}</span>}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </Panel>
            <div className="flex flex-col gap-2.5">
              <KpiGrid minWidth={130}>
                <KpiCard label={t("journeys.entered")} value={fmt(j.stats.entered)} unit={t("journeys.days30")} />
                <KpiCard label={t("journeys.converted")} value={j.stats.entered ? pct(j.stats.converted, j.stats.entered) : "–"} />
              </KpiGrid>
              <Panel title={t("journeys.state")}>
                <div className="flex flex-col gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={j.state === "live" ? "success" : "neutral"}>{label(j)}</StatusBadge>
                    {can("editor") && j.state === "live" && (
                      <Button size="xs" icon={<Pause />} onClick={() => act("pause")}>
                        {t("journeys.pause")}
                      </Button>
                    )}
                    {can("editor") && j.state !== "live" && (
                      <Button size="xs" icon={<Play />} onClick={() => act("start")}>
                        {j.state === "paused" ? t("journeys.resume") : t("journeys.start")}
                      </Button>
                    )}
                  </span>
                  {j.state === "paused" && (
                    <p role="status" className="text-xs text-fg-muted">
                      {t("journeys.pausedDetail")}
                    </p>
                  )}
                  {j.problem && <p className="text-xs text-danger-text">{j.problem}</p>}
                  <p className="text-2xs text-fg-muted">{t("journeys.analytics", { campaign: j.utmCampaign })}</p>
                </div>
              </Panel>
            </div>
          </div>
        </>
      )}
      <NewJourneyDialog
        call={call}
        open={creating}
        onOpenChange={setCreating}
        templates={templates?.templates ?? []}
        onDone={(x) => {
          setCreating(false);
          setId(x.id);
          reload();
        }}
      />
    </>
  );
}
