import { Form } from "@mdcz/ui";
import { lazy, type ReactNode, Suspense, useMemo } from "react";
import type { FieldValues } from "react-hook-form";
import { useForm } from "react-hook-form";
import { SettingsLayout } from "./SettingsLayout";
import { SettingsSearchProvider } from "./SettingsSearchContext";
import { type FieldAnchor, flattenConfig } from "./settingsRegistry";
import { SettingsEditorAutosaveProvider } from "./useAutoSaveField";

const loadSettingsForm = () => import("./SettingsForm");

const LazySettingsForm = lazy(async () => {
  const module = await loadSettingsForm();
  return { default: module.SettingsForm };
});

export function preloadSettingsEditorBody() {
  void loadSettingsForm();
}

interface SettingsEditorProps {
  data: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  defaultConfigReady?: boolean;
  profiles: string[];
  activeProfile: string | null;
  profileLoading?: boolean;
  onSwitchProfile: (name: string) => void;
  onCreateProfile: () => void;
  onDeleteProfile: () => void;
  onResetConfig: () => void;
  onExportProfile: () => void;
  onImportProfile: () => void;
  extraContent?: ReactNode;
  initialSection?: FieldAnchor;
}

export function SettingsEditor({
  data,
  defaultConfig = {},
  defaultConfigReady = false,
  profiles,
  activeProfile,
  profileLoading = false,
  onSwitchProfile,
  onCreateProfile,
  onDeleteProfile,
  onResetConfig,
  onExportProfile,
  onImportProfile,
  extraContent,
  initialSection,
}: SettingsEditorProps) {
  const flatConfigValues = useMemo(() => flattenConfig(data), [data]);
  const flatDefaultValues = useMemo(() => flattenConfig(defaultConfig), [defaultConfig]);
  const form = useForm<FieldValues>({
    defaultValues: flatConfigValues,
    mode: "onChange",
  });

  return (
    <Form {...form}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
        }}
        className="h-full"
      >
        <SettingsEditorAutosaveProvider
          savedValues={flatConfigValues}
          defaultValues={flatDefaultValues}
          defaultValuesReady={defaultConfigReady}
        >
          <SettingsSearchProvider defaultConfig={defaultConfig} defaultConfigReady={defaultConfigReady}>
            <SettingsLayout
              initialSection={initialSection}
              profiles={profiles}
              activeProfile={activeProfile}
              profileLoading={profileLoading}
              onSwitchProfile={onSwitchProfile}
              onCreateProfile={onCreateProfile}
              onDeleteProfile={onDeleteProfile}
              onResetConfig={onResetConfig}
              onExportProfile={onExportProfile}
              onImportProfile={onImportProfile}
            >
              <Suspense fallback={<SettingsFormSkeleton />}>
                <LazySettingsForm extraContent={extraContent} flatDefaults={flatConfigValues} />
              </Suspense>
            </SettingsLayout>
          </SettingsSearchProvider>
        </SettingsEditorAutosaveProvider>
      </form>
    </Form>
  );
}

function SettingsFormSkeleton() {
  const sectionKeys = ["section-a", "section-b", "section-c", "section-d"];
  const rowKeys = ["row-a", "row-b", "row-c", "row-d"];

  return (
    <div className="space-y-10">
      {sectionKeys.map((sectionKey) => (
        <section key={sectionKey} className="space-y-4">
          <div className="space-y-2">
            <div className="h-7 w-40 animate-pulse rounded-full bg-foreground/8" />
            <div className="h-4 w-72 animate-pulse rounded-full bg-foreground/6" />
          </div>
          <div className="space-y-3 rounded-[var(--radius-quiet-xl)] border border-border/30 bg-surface px-5 py-5">
            {rowKeys.map((rowKey) => (
              <div
                key={`${sectionKey}-${rowKey}`}
                className="flex flex-col gap-2 py-2 md:flex-row md:items-center md:justify-between"
              >
                <div className="space-y-2">
                  <div className="h-4 w-36 animate-pulse rounded-full bg-foreground/8" />
                  <div className="h-3 w-56 animate-pulse rounded-full bg-foreground/6" />
                </div>
                <div className="h-8 w-48 animate-pulse rounded-[var(--radius-quiet)] bg-surface-low" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
