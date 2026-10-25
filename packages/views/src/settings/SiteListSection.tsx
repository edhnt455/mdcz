import {
  defaultConfiguration,
  isMirrorableSite,
  mirrorUrlSchema,
  normalizeScrapeSiteLists,
  OFFICIAL_SITE_URLS,
  siteSettingsLink,
} from "@mdcz/shared/config";
import { Website } from "@mdcz/shared/enums";
import {
  DEFAULT_R18_METADATA_LANGUAGE,
  R18_METADATA_LANGUAGE_OPTIONS,
  type R18MetadataLanguage,
} from "@mdcz/shared/r18";
import type { FieldKey } from "@mdcz/shared/settingsRegistry";
import type { SiteHealth } from "@mdcz/shared/siteResults";
import { Button, Checkbox, cn, Switch } from "@mdcz/ui";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FieldValues } from "react-hook-form";
import { useFormContext, useWatch } from "react-hook-form";
import { CookieFieldWrapper, UrlField } from "../config-form/FieldRenderer";
import { useT } from "../i18n";
import { describeSiteHealth } from "../overview/SiteHealthCard";
import { valuesEqual } from "./autoSaveUtils";
import { ResetToDefaultButton } from "./ResetToDefaultButton";
import { useOptionalSettingsSearch } from "./SettingsSearchContext";
import { useSettingsServices } from "./SettingsServices";
import { SiteConnectivityPill } from "./SiteConnectivityPill";
import { useAutoSaveField } from "./useAutoSaveField";

const SITES_FIELD = "scrape.sites";
const SITE_ORDER_FIELD = "scrape.siteOrder";
const DIRECT_SITES_FIELD = "network.directSites";
const R18_LANGUAGE_FIELD = "scrape.r18MetadataLanguage";
const SITES_BUNDLE = [SITE_ORDER_FIELD] as const;
const ORDER_BUNDLE = [SITES_FIELD] as const;

const MIRROR_FIELDS = {
  [Website.JAVDB]: "network.javdbUrl",
  [Website.JAVBUS]: "network.javbusUrl",
} as const satisfies Partial<Record<Website, FieldKey>>;

const COOKIE_FIELDS = {
  [Website.JAVDB]: "network.javdbCookie",
  [Website.JAVBUS]: "network.javbusCookie",
  [Website.FANTIA]: "network.fantiaCookie",
} as const satisfies Partial<Record<Website, FieldKey>>;

const normalizeR18Language = (value: unknown): R18MetadataLanguage =>
  value === "en" || value === "ja" ? value : DEFAULT_R18_METADATA_LANGUAGE;

function moveSite(order: readonly Website[], site: Website, direction: -1 | 1): Website[] {
  const index = order.indexOf(site);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return [...order];
  const next = [...order];
  const current = next[index];
  const target = next[nextIndex];
  if (current === undefined || target === undefined) return next;
  next[index] = target;
  next[nextIndex] = current;
  return next;
}

function R18LanguagePreferenceControl({
  value,
  onChange,
}: {
  value: R18MetadataLanguage;
  onChange: (value: R18MetadataLanguage) => void;
}) {
  const t = useT();
  return (
    <fieldset className="inline-flex rounded-[var(--radius-quiet-capsule)] border border-border/50 bg-surface-low p-0.5">
      <legend className="sr-only">{t.settings.sitePriority.r18Language}</legend>
      {R18_METADATA_LANGUAGE_OPTIONS.map((language) => {
        const active = value === language;
        return (
          <button
            key={language}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(language)}
            className={cn(
              "h-7 rounded-[var(--radius-quiet-capsule)] px-2.5 text-[11px] font-medium text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
              active && "bg-surface-floating text-foreground shadow-[0_8px_18px_-16px_rgba(15,23,42,0.5)]",
            )}
          >
            {t.settings.sitePriority.r18Languages[language]}
          </button>
        );
      })}
    </fieldset>
  );
}

export function SiteListSection() {
  const t = useT();
  const form = useFormContext<FieldValues>();
  const search = useOptionalSettingsSearch();
  const services = useSettingsServices();
  const rawSites = (useWatch({ control: form.control, name: SITES_FIELD }) as Website[] | undefined) ?? [];
  const rawOrder = (useWatch({ control: form.control, name: SITE_ORDER_FIELD }) as Website[] | undefined) ?? [];
  const r18Language = normalizeR18Language(useWatch({ control: form.control, name: R18_LANGUAGE_FIELD }));
  const [javdbUrl = "", javbusUrl = ""] =
    (useWatch({ control: form.control, name: ["network.javdbUrl", "network.javbusUrl"] }) as
      | [string | undefined, string | undefined]
      | undefined) ?? [];
  const [useProxy, directSites = []] =
    (useWatch({ control: form.control, name: ["network.useProxy", DIRECT_SITES_FIELD] }) as
      | [boolean | undefined, Website[] | undefined]
      | undefined) ?? [];
  const siteUrls = {
    javdbUrl: mirrorUrlSchema.safeParse(javdbUrl).data ?? "",
    javbusUrl: mirrorUrlSchema.safeParse(javbusUrl).data ?? "",
  };
  const normalized = useMemo(
    () => normalizeScrapeSiteLists(rawSites, rawOrder.length > 0 ? rawOrder : undefined),
    [rawOrder, rawSites],
  );
  const enabled = useMemo(() => new Set(normalized.sites), [normalized.sites]);
  const defaults = useMemo(
    () => normalizeScrapeSiteLists(defaultConfiguration.scrape.sites, defaultConfiguration.scrape.siteOrder),
    [],
  );
  const modified =
    !valuesEqual(normalized.sites, defaults.sites) || !valuesEqual(normalized.siteOrder, defaults.siteOrder);
  const listFieldVisible = !search?.hasActiveFilters || search.isFieldVisible(SITES_FIELD);

  useAutoSaveField(SITES_FIELD, { mode: "immediate", bundlePaths: SITES_BUNDLE });
  useAutoSaveField(SITE_ORDER_FIELD, { mode: "immediate", bundlePaths: ORDER_BUNDLE });
  useAutoSaveField(DIRECT_SITES_FIELD, { mode: "immediate" });
  useAutoSaveField(R18_LANGUAGE_FIELD, { mode: "immediate" });

  const [siteHealth, setSiteHealth] = useState<Partial<Record<Website, SiteHealth>>>({});
  const refreshSiteHealth = useCallback(async () => {
    const { sites } = await services.listCrawlerSites();
    setSiteHealth(Object.fromEntries(sites.flatMap(({ site, health }) => (health ? [[site, health]] : []))));
  }, [services]);
  useEffect(() => {
    void refreshSiteHealth();
  }, [refreshSiteHealth]);

  const applyLists = (siteOrder: Website[], sites: Website[]) => {
    form.setValue(SITE_ORDER_FIELD, siteOrder, { shouldDirty: true, shouldTouch: true });
    form.setValue(SITES_FIELD, sites, { shouldDirty: true, shouldTouch: true });
  };

  const applyEnabled = (nextEnabled: Set<Website>) => {
    applyLists(
      normalized.siteOrder,
      normalized.siteOrder.filter((site) => nextEnabled.has(site)),
    );
  };

  const applyOrder = (siteOrder: Website[]) => {
    applyLists(
      siteOrder,
      siteOrder.filter((site) => enabled.has(site)),
    );
  };

  const setSiteProxy = (site: Website, proxied: boolean) => {
    const next = proxied ? directSites.filter((entry) => entry !== site) : [...directSites, site];
    form.setValue(DIRECT_SITES_FIELD, next, { shouldDirty: true, shouldTouch: true });
  };

  const openSite = (url: string) => {
    if (services.openExternal) {
      void services.openExternal(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const visibleRows = normalized.siteOrder.filter((site) => {
    if (listFieldVisible) return true;
    const mirrorField = MIRROR_FIELDS[site as keyof typeof MIRROR_FIELDS];
    const cookieField = COOKIE_FIELDS[site as keyof typeof COOKIE_FIELDS];
    return (
      (mirrorField !== undefined && search?.isFieldVisible(mirrorField) === true) ||
      (cookieField !== undefined && search?.isFieldVisible(cookieField) === true)
    );
  });

  return (
    <div data-field-name={SITES_FIELD} className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <p className="mr-auto text-sm leading-6">{t.settings.sitePriority.hint}</p>
        <span>{t.settings.sitePriority.enabledSummary(normalized.sites.length, normalized.siteOrder.length)}</span>
        {modified ? (
          <ResetToDefaultButton
            label={t.settingsFields.fields[SITES_FIELD].label}
            onClick={() => applyLists(defaults.siteOrder, defaults.sites)}
          />
        ) : null}
      </div>
      <div className="divide-y overflow-hidden rounded-[var(--radius-quiet-lg)] border border-border/60 bg-surface">
        <div className="flex items-center justify-end gap-2 px-3 py-2">
          <Button type="button" variant="ghost" size="xs" onClick={() => applyEnabled(new Set(normalized.siteOrder))}>
            {t.configForm.selectAll}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => applyEnabled(new Set())}>
            {t.configForm.selectNone}
          </Button>
        </div>
        {visibleRows.map((site) => {
          const checked = enabled.has(site);
          const index = normalized.siteOrder.indexOf(site);
          const description = t.settings.sitePriority.sites[site];
          const href = siteSettingsLink(site, siteUrls);
          const mirrorField = isMirrorableSite(site) ? MIRROR_FIELDS[site] : undefined;
          const cookieField =
            site === Website.JAVDB || site === Website.JAVBUS || site === Website.FANTIA
              ? COOKIE_FIELDS[site]
              : undefined;
          const health = siteHealth[site];
          const healthCopy = health ? describeSiteHealth(t, site, health) : null;
          return (
            <div key={site} className={cn("px-3 py-3", !checked && "text-muted-foreground")}>
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 text-sm">
                <Checkbox
                  checked={checked}
                  aria-label={site}
                  onCheckedChange={(value) => {
                    const next = new Set(enabled);
                    if (value === true) next.add(site);
                    else next.delete(site);
                    applyEnabled(next);
                  }}
                />
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={cn("font-mono text-xs", checked ? "text-foreground" : "text-muted-foreground")}>
                      {site}
                    </span>
                    {href ? (
                      <a
                        href={href}
                        className="font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        onClick={(event) => {
                          event.preventDefault();
                          openSite(href);
                        }}
                      >
                        {href}
                      </a>
                    ) : null}
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">{description}</p>
                  {healthCopy ? (
                    <p className="text-xs leading-5 text-amber-700">
                      {healthCopy.summary} {healthCopy.remedy}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {site === Website.R18_DEV ? (
                    <R18LanguagePreferenceControl
                      value={r18Language}
                      onChange={(language) =>
                        form.setValue(R18_LANGUAGE_FIELD, language, { shouldDirty: true, shouldTouch: true })
                      }
                    />
                  ) : null}
                  <span
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                    title={useProxy ? undefined : t.domain.siteHealth.proxyOff}
                  >
                    {t.domain.siteHealth.useProxy}
                    <Switch
                      size="sm"
                      aria-label={`${site} ${t.domain.siteHealth.useProxy}`}
                      checked={Boolean(useProxy) && !directSites.includes(site)}
                      disabled={!useProxy}
                      onCheckedChange={(proxied) => setSiteProxy(site, proxied)}
                    />
                  </span>
                  <SiteConnectivityPill site={site} onChecked={() => void refreshSiteHealth()} />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={index <= 0}
                    aria-label={t.configForm.orderedSite.moveUp(site)}
                    onClick={() => applyOrder(moveSite(normalized.siteOrder, site, -1))}
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={index < 0 || index >= normalized.siteOrder.length - 1}
                    aria-label={t.configForm.orderedSite.moveDown(site)}
                    onClick={() => applyOrder(moveSite(normalized.siteOrder, site, 1))}
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                </div>
              </div>
              {mirrorField && isMirrorableSite(site) ? (
                <div className="mt-3 pl-7">
                  <UrlField name={mirrorField} placeholder={OFFICIAL_SITE_URLS[site]} />
                </div>
              ) : null}
              {cookieField ? (
                <div className="mt-3 pl-7">
                  <CookieFieldWrapper name={cookieField} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
