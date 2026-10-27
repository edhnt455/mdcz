import type { ReactNode } from "react";
import { useT } from "../i18n";
import { SectionAnchor } from "./SectionAnchor";
import { useSettingsSearch } from "./SettingsSearchContext";
import { SettingsSectionModeProvider } from "./SettingsSectionModeContext";
import { useSettingsServices } from "./SettingsServices";
import { SiteListSection } from "./SiteListSection";
import { Subsection } from "./Subsection";
import { IntegrationAccessPanel, QbittorrentStatusLine, useIntegrationStatus } from "./sections/IntegrationAccessPanel";
import { MediaServerSection } from "./sections/MediaServerSections";
import {
  AggregationBehaviorSection,
  AggregationPrioritySection,
  AggregationScrapeSection,
  AssetDownloadsSection,
  FilenameFilteringSection,
  NamingSection,
  NetworkConnectionSection,
  NfoSection,
  NotificationsSection,
  PathMappingsField,
  PathsSection,
  QbittorrentSection,
  ScrapePacingSection,
  TranslateSection,
} from "./settingsContent";
import type { FieldAnchor } from "./settingsRegistry";

interface SiteOptionsProps {
  siteOptions: string[];
}

export function PathsTopLevelSection() {
  const t = useT();
  return (
    <SectionAnchor
      id="paths"
      label={t.settingsFields.sections.paths.label}
      title={t.settingsFields.sections.paths.label}
    >
      <PathsSection />
    </SectionAnchor>
  );
}

export function ScrapeTopLevelSection() {
  const t = useT();
  return (
    <SectionAnchor
      id="scrape"
      label={t.settingsFields.sections.scrape.label}
      title={t.settingsFields.sections.scrape.label}
    >
      <Subsection title={t.settings.subsections.scrapePacing} className="mb-6 last:mb-0">
        <ScrapePacingSection />
      </Subsection>
      <Subsection title={t.settings.subsections.filenameFiltering} className="mb-6 last:mb-0">
        <FilenameFilteringSection />
      </Subsection>
    </SectionAnchor>
  );
}

export function SitesTopLevelSection() {
  const t = useT();
  return (
    <SectionAnchor
      id="sites"
      label={t.settingsFields.sections.sites.label}
      title={t.settingsFields.sections.sites.label}
    >
      <SiteListSection />
    </SectionAnchor>
  );
}

export function NetworkTopLevelSection() {
  const t = useT();
  return (
    <SectionAnchor
      id="network"
      label={t.settingsFields.sections.network.label}
      title={t.settingsFields.sections.network.label}
    >
      <Subsection title={t.settings.subsections.proxyAndRequests} className="mb-6 last:mb-0">
        <NetworkConnectionSection />
      </Subsection>
    </SectionAnchor>
  );
}

export function TranslateTopLevelSection() {
  const t = useT();
  return (
    <SectionAnchor
      id="translate"
      label={t.settingsFields.sections.translate.label}
      title={t.settingsFields.sections.translate.label}
    >
      <TranslateSection />
    </SectionAnchor>
  );
}

export function NamingTopLevelSection() {
  const t = useT();
  return (
    <SectionAnchor
      id="naming"
      label={t.settingsFields.sections.naming.label}
      title={t.settingsFields.sections.naming.label}
    >
      <NamingSection />
    </SectionAnchor>
  );
}

export function DownloadTopLevelSection() {
  const t = useT();
  return (
    <SectionAnchor
      id="download"
      label={t.settingsFields.sections.download.label}
      title={t.settingsFields.sections.download.label}
    >
      <Subsection title={t.settings.subsections.assetDownloads} className="mb-6 last:mb-0">
        <AssetDownloadsSection />
      </Subsection>
      <Subsection title="NFO" className="mb-6 last:mb-0">
        <NfoSection />
      </Subsection>
    </SectionAnchor>
  );
}

export function MediaServerTopLevelSection() {
  const t = useT();
  return (
    <SectionAnchor
      id="mediaServer"
      label={t.settingsFields.sections.mediaServer.label}
      title={t.settingsFields.sections.mediaServer.label}
    >
      <MediaServerSection />
    </SectionAnchor>
  );
}

/** Downloader access, qBittorrent polling and notifications; only the server receives callbacks and sends messages. */
export function AutomationTopLevelSection() {
  const t = useT();
  const services = useSettingsServices();
  const search = useSettingsSearch();
  const status = useIntegrationStatus(services.integrations);

  return (
    <SectionAnchor
      id="automation"
      label={t.settingsFields.sections.automation.label}
      title={t.settingsFields.sections.automation.label}
    >
      <Subsection
        title={t.settings.integrations.access}
        description={t.settings.integrations.accessDescription}
        className="mb-6 last:mb-0"
      >
        {/* The key panel holds no settings fields, so a search only ever matches the fields around it. */}
        {services.integrations && !search.hasActiveFilters ? (
          <IntegrationAccessPanel
            integrations={services.integrations}
            cloudDriveLastEventAt={status?.cloudDrive.lastEventAt ?? null}
          />
        ) : null}
        <PathMappingsField />
      </Subsection>
      <Subsection
        title={t.settings.integrations.qbittorrent}
        description={t.settings.integrations.qbittorrentDescription}
        className="mb-6 last:mb-0"
      >
        <QbittorrentSection
          status={status && !search.hasActiveFilters ? <QbittorrentStatusLine status={status.qbittorrent} /> : null}
        />
      </Subsection>
      <Subsection title={t.settings.integrations.notifications} className="mb-6 last:mb-0">
        <NotificationsSection />
      </Subsection>
    </SectionAnchor>
  );
}

export function AdvancedTopLevelSection({ siteOptions }: SiteOptionsProps) {
  const t = useT();
  const search = useSettingsSearch();

  if (!search.hasVisibleAdvancedEntries) {
    return null;
  }

  return (
    <SectionAnchor
      id="advancedSettings"
      label={t.settings.subsections.advanced}
      title={t.settings.subsections.advanced}
    >
      <SettingsSectionModeProvider mode="advanced">
        <AdvancedDomainSubsection anchor="scrape">
          <AggregationPrioritySection siteOptions={siteOptions} />
          <AggregationScrapeSection />
          <AggregationBehaviorSection />
        </AdvancedDomainSubsection>

        <AdvancedDomainSubsection anchor="download">
          <AssetDownloadsSection />
        </AdvancedDomainSubsection>
      </SettingsSectionModeProvider>
    </SectionAnchor>
  );
}

function AdvancedDomainSubsection({ anchor, children }: { anchor: FieldAnchor; children: ReactNode }) {
  const t = useT();
  const search = useSettingsSearch();

  if (!search.isAdvancedAnchorVisible(anchor)) {
    return null;
  }

  return (
    <Subsection title={t.settingsFields.sections[anchor].label} className="mb-6 last:mb-0">
      {children}
    </Subsection>
  );
}
