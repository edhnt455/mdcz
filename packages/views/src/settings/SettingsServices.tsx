import type { Configuration } from "@mdcz/shared/config";
import type { Website } from "@mdcz/shared/enums";
import type { WatermarkPreviewInput, WatermarkPreviewResult } from "@mdcz/shared/posterBadges";
import type {
  ApiKeyDto,
  IntegrationStatusResponse,
  NetworkCheckCookiesResponse,
  SiteConnectivityProbeResponse,
  TranslateTestInputDto,
  TranslateTestResponse,
} from "@mdcz/shared/serverDtos";
import type { SiteHealth } from "@mdcz/shared/siteResults";
import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { PathAutocompleteResult } from "../path";

export interface SettingsBrowseFilter {
  name: string;
  extensions: string[];
}

export interface SettingsBrowseResult {
  canceled?: boolean;
  paths?: string[];
}

export interface SettingsPathSuggestion {
  label: string;
  path: string;
}

export interface SettingsCrawlerSiteInfo {
  site: Website;
  name: string;
  enabled: boolean;
  native: boolean;
  health?: SiteHealth;
}

export interface SettingsWatermarkDirectoryInfo {
  path: string;
  warnings?: string[];
}

export interface SettingsWatermarkDirectoryOpenResult {
  copied?: boolean;
  message?: string;
  path?: string;
  unsupported?: boolean;
}

export type SettingsTranslateTestInput = TranslateTestInputDto;

/** Server only: API keys that downloaders and cloud drives use to reach the automation endpoints. */
export interface SettingsIntegrationServices {
  /** The origin downloaders reach this server at, as the browser sees it. */
  origin: string;
  listApiKeys: () => Promise<ApiKeyDto[]>;
  /** Returns the new key's secret, shown once. */
  createApiKey: (name: string) => Promise<string>;
  revokeApiKey: (id: string) => Promise<void>;
  /** Sends a message through each enabled channel using the settings as edited, saved or not. */
  testNotification: (settings: Configuration["notifications"]) => Promise<void>;
  status: () => Promise<IntegrationStatusResponse>;
}

export interface SettingsServices {
  browsePath: (kind: "file" | "directory", filters?: SettingsBrowseFilter[]) => Promise<SettingsBrowseResult>;
  getPathSuggestions?: (kind: "file" | "directory") => SettingsPathSuggestion[];
  integrations?: SettingsIntegrationServices;
  isServer?: boolean;
  settingsTarget?: "desktop" | "server";
  suggestDirectoryPath?: (path: string) => Promise<PathAutocompleteResult>;
  watermarkDirectoryActionLabel?: string;
  checkCookies: () => Promise<NetworkCheckCookiesResponse>;
  ensureWatermarkDirectory: () => Promise<SettingsWatermarkDirectoryInfo>;
  previewWatermark: (input: WatermarkPreviewInput) => Promise<WatermarkPreviewResult>;
  getInFlightSaves: () => number;
  subscribeInFlightSaves?: (listener: () => void) => () => void;
  incrementInFlightSaves: () => void;
  decrementInFlightSaves: () => void;
  listCrawlerSites: () => Promise<{ sites: SettingsCrawlerSiteInfo[] }>;
  openWatermarkDirectory: () => Promise<SettingsWatermarkDirectoryOpenResult | undefined>;
  probeSiteConnectivity: (site: Website) => Promise<SiteConnectivityProbeResponse>;
  relaunchApp: () => Promise<void>;
  resetConfig: (path?: string) => Promise<unknown>;
  saveConfig: (config?: Partial<Configuration>) => Promise<unknown>;
  testTranslation: (input: SettingsTranslateTestInput) => Promise<TranslateTestResponse>;
  updateCurrentConfigCache?: (flatPayload: Record<string, unknown>) => void;
}

export interface SettingsNotifier {
  error: (message: string) => void;
  info: (message: string) => void;
  success: (message: string, options?: { action?: { label: string; onClick: () => void } }) => void;
}

interface SettingsServicesProviderProps {
  children?: ReactNode;
  notifier: SettingsNotifier;
  services: SettingsServices;
}

const SettingsServicesContext = createContext<SettingsServices | null>(null);
const SettingsNotifierContext = createContext<SettingsNotifier | null>(null);

export function SettingsServicesProvider({ children, notifier, services }: SettingsServicesProviderProps) {
  return (
    <SettingsServicesContext.Provider value={services}>
      <SettingsNotifierContext.Provider value={notifier}>{children}</SettingsNotifierContext.Provider>
    </SettingsServicesContext.Provider>
  );
}

export function useSettingsServices(): SettingsServices {
  const services = useContext(SettingsServicesContext);
  if (!services) {
    throw new Error("Settings views must be wrapped in <SettingsServicesProvider>");
  }
  return services;
}

export function useSettingsNotifier(): SettingsNotifier {
  const notifier = useContext(SettingsNotifierContext);
  if (!notifier) {
    throw new Error("Settings views must be wrapped in <SettingsServicesProvider>");
  }
  return notifier;
}

export function useSettingsInFlightSaves(): number {
  const services = useSettingsServices();
  return useSyncExternalStore(
    services.subscribeInFlightSaves ?? (() => () => undefined),
    services.getInFlightSaves,
    services.getInFlightSaves,
  );
}
