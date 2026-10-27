import { cn } from "@mdcz/ui";
import { LoaderCircle } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { ProfileCapsule } from "./ProfileCapsule";
import { AdvancedSettingsFooterContent } from "./SettingsFooter";
import { SettingsNavigationContext, type SettingsSectionId } from "./SettingsNavigationContext";
import { SettingsSearch } from "./SettingsSearch";
import { useOptionalSettingsSearch } from "./SettingsSearchContext";
import { useSettingsInFlightSaves } from "./SettingsServices";
import { type FieldAnchor, SECTION_ORDER } from "./settingsRegistry";

interface SettingsLayoutProps {
  searchDisabled?: boolean;
  initialSection?: FieldAnchor;
  profiles: string[];
  activeProfile: string | null;
  profileLoading?: boolean;
  onSwitchProfile: (name: string) => void;
  onCreateProfile: () => void;
  onDeleteProfile: () => void;
  onResetConfig: () => void;
  onExportProfile: () => void;
  onImportProfile: () => void;
  children: ReactNode;
}

export function SettingsLayout({
  searchDisabled = false,
  initialSection,
  profiles,
  activeProfile,
  profileLoading = false,
  onSwitchProfile,
  onCreateProfile,
  onDeleteProfile,
  onResetConfig,
  onExportProfile,
  onImportProfile,
  children,
}: SettingsLayoutProps) {
  const t = useT();
  const inFlightSaves = useSettingsInFlightSaves();
  const search = useOptionalSettingsSearch();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [selectedSection, setSelectedSection] = useState<SettingsSectionId>(initialSection ?? "paths");
  const sections: { id: SettingsSectionId; label: string }[] = SECTION_ORDER.filter((id) => {
    return !search || search.hasActiveFilters || search.isAnchorVisible(id);
  }).map((id) => ({ id, label: t.settingsFields.sections[id].label }));
  if (search?.hasVisibleAdvancedEntries) {
    sections.push({ id: "advancedSettings", label: t.settings.subsections.advanced });
  }
  const activeSection = sections.some((section) => section.id === selectedSection)
    ? selectedSection
    : (sections[0]?.id ?? "paths");
  const hasActiveFilters = Boolean(search?.hasActiveFilters);

  useEffect(() => {
    if (initialSection) setSelectedSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [activeSection, hasActiveFilters]);

  return (
    <SettingsNavigationContext.Provider value={activeSection}>
      <div className="flex h-full min-w-0 flex-col overflow-hidden bg-surface">
        <header className="z-30 shrink-0 border-b border-border/40">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-4 sm:px-8 sm:py-5">
            <div className="flex min-w-0 items-center gap-3">
              <h1 className="font-numeric text-lg font-semibold tracking-tight text-foreground">
                {t.settings.layout.title}
              </h1>
              {hasActiveFilters && search && (
                <span className="rounded-full bg-surface-low px-2.5 py-1 text-xs text-muted-foreground">
                  {t.settings.layout.matchCount(search.resultCount)}
                </span>
              )}
            </div>
            <div className="flex min-w-0 flex-1 basis-full items-center justify-end gap-2.5 sm:flex-none sm:basis-auto">
              <SettingsSearch disabled={searchDisabled} className="min-w-0 sm:w-64" />
              <ProfileCapsule
                profiles={profiles}
                activeProfile={activeProfile}
                isLoading={profileLoading}
                onSwitchProfile={onSwitchProfile}
                onCreateProfile={onCreateProfile}
                onDeleteProfile={onDeleteProfile}
                onResetConfig={onResetConfig}
                onExportProfile={onExportProfile}
                onImportProfile={onImportProfile}
              />
            </div>
          </div>
          {!hasActiveFilters && (
            <nav aria-label={t.settings.layout.sections} className="mx-auto max-w-5xl px-4 sm:px-8">
              <div className="flex gap-5 overflow-x-auto">
                {sections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    aria-current={section.id === activeSection ? "page" : undefined}
                    aria-controls={`settings-${section.id}`}
                    disabled={searchDisabled}
                    onClick={() => setSelectedSection(section.id)}
                    className={cn(
                      "shrink-0 cursor-pointer whitespace-nowrap border-b-2 py-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-50",
                      section.id === activeSection
                        ? "border-foreground font-semibold text-foreground"
                        : "border-transparent font-medium text-muted-foreground hover:border-border hover:text-foreground",
                    )}
                  >
                    {section.label}
                  </button>
                ))}
              </div>
            </nav>
          )}
        </header>

        <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-4 py-5 sm:px-8 sm:py-8">{children}</div>
        </div>

        <footer className="shrink-0 border-t border-border/40">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-8">
            <p role="status" className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              {inFlightSaves > 0 && <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />}
              {inFlightSaves > 0 ? t.common.saving : t.settings.layout.autoSaveHint}
            </p>
            {search && (
              <AdvancedSettingsFooterContent
                hasActiveFilters={search.hasActiveFilters}
                isAdvancedVisible={search.isAdvancedVisible}
                onToggleShowAdvanced={search.toggleShowAdvanced}
              />
            )}
          </div>
        </footer>
      </div>
    </SettingsNavigationContext.Provider>
  );
}
