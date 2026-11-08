// Settings that are kept in the product's YAML file: shown here, read-only, with the file as it was applied. They are
// changed in the file and reviewed like code; the product reads it again within a minute.
//
// Rebuilt here from published @openasy/ui components after the FileSettings page of the ui repo's Storybook
// (src/stories/shared/FileSettings.tsx), which is not in a published @openasy/ui version yet. When it is, this file
// gives way to the library's.
import { Callout, Panel, PageHeader, StatusBadge } from "@openasy/ui";
import { FileCode } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "./i18n.ts";

export interface FileSetting {
  label: string;
  value: ReactNode;
  /** Where it is in the file, such as site.languages. */
  path: string;
}

export interface FileSettingsGroup {
  title: string;
  description?: string;
  items: FileSetting[];
}

export function FileSettingsPage({
  file,
  applied,
  groups,
  yaml,
  problems,
}: {
  file: string;
  /** When it was applied, as people read it: "yesterday". */
  applied: string;
  groups: FileSettingsGroup[];
  yaml: string;
  /** Why the file on disk is not applied, and what to fix that did not stop it. */
  problems?: ReactNode;
}) {
  const t = useT();
  return (
    <>
      <PageHeader
        title={t("settings.title")}
        description={t("settings.description", { file })}
        meta={<StatusBadge tone="success">{t("settings.applied", { when: applied })}</StatusBadge>}
      />
      <Callout tone="info" title={t("settings.readOnly", { file })} className="mb-2.5">
        {t("settings.readOnlyDetail")}
      </Callout>
      {problems}
      <div className="kb-split-halves grid gap-2.5">
        <div className="flex min-w-0 flex-col gap-2.5">
          {groups.map((g) => (
            <Panel key={g.title} title={g.title} description={g.description} aria-label={g.title}>
              <dl className="kb-settings-list grid gap-x-3 gap-y-2 text-xs">
                {g.items.map((i) => (
                  <div key={i.path} className="contents">
                    <dt className="flex flex-col text-fg-muted">
                      {i.label}
                      <code className="truncate font-mono text-2xs text-fg-muted">{i.path}</code>
                    </dt>
                    <dd className="m-0 min-w-0 text-fg">{i.value}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          ))}
        </div>
        <Panel
          title={file}
          description={t("settings.asApplied", { when: applied })}
          actions={<FileCode aria-hidden className="size-3.5 text-fg-muted" />}
          className="self-start"
        >
          <pre
            aria-label={t("settings.yamlLabel", { file })}
            className="kb-code m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg"
          >
            {yaml}
          </pre>
        </Panel>
      </div>
    </>
  );
}
