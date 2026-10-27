import { toErrorMessage } from "@mdcz/shared/error";
import { openNewWorkbenchTask } from "@mdcz/views/adapters/workbenchSession";
import { useT } from "@mdcz/views/i18n";
import {
  ActivityTimelineCard,
  hasActiveActivity,
  OverviewHeroStartCard,
  OverviewMaintenanceCard,
  SiteHealthCard,
} from "@mdcz/views/overview";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { toast } from "sonner";
import { createWebMaintenanceActionPort } from "../adapters/ports";
import { api } from "../client";
import { queryKeys } from "../lib/queryKeys";
import { ErrorBanner } from "../routeCommon";
import { buildHref } from "../routeHelpers";

export const hasWorkbenchOutput = (input: {
  libraryCount: number;
  output?: { fileCount: number; totalBytes: number } | null;
  recentCount: number;
}): boolean =>
  input.libraryCount > 0 ||
  (input.output?.fileCount ?? 0) > 0 ||
  (input.output?.totalBytes ?? 0) > 0 ||
  input.recentCount > 0;

export function OverviewPage() {
  const t = useT();
  const navigate = useNavigate();
  const maintenancePort = useMemo(() => createWebMaintenanceActionPort(), []);
  const librariesQ = useQuery({ queryKey: queryKeys.libraries.all, queryFn: () => api.libraries.list(), retry: false });
  const overviewQ = useQuery({
    queryKey: queryKeys.overview.summary,
    queryFn: () => api.overview.summary(),
    retry: false,
  });
  const sitesQ = useQuery({ queryKey: queryKeys.overview.sites, queryFn: () => api.crawler.listSites(), retry: false });
  const activityQ = useQuery({
    queryKey: queryKeys.activity.list,
    queryFn: () => api.activity.list({ limit: 12 }),
    refetchInterval: (query) => (hasActiveActivity(query.state.data?.entries ?? []) ? 3_000 : false),
    retry: false,
  });
  const openWorkbench = async (mode: "scrape" | "maintenance") => {
    try {
      await openNewWorkbenchTask(mode, () => maintenancePort.discardSession());
      await navigate(
        mode === "maintenance" ? { to: buildHref("/workbench", { intent: "maintenance" }) } : { to: "/workbench" },
      );
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  };
  const output = overviewQ.data?.output;
  const recent = overviewQ.data?.recentAcquisitions ?? [];
  const configured = hasWorkbenchOutput({
    libraryCount: librariesQ.data?.libraries.length ?? 0,
    output,
    recentCount: recent.length,
  });

  return (
    <main className="h-full overflow-y-auto bg-surface-canvas text-foreground">
      <div className="mx-auto grid w-full max-w-[1600px] grid-cols-12 gap-6 px-6 py-6 md:px-10 lg:px-12 lg:py-8">
        <section className="col-span-12 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <OverviewHeroStartCard
            className="lg:col-span-2"
            data={output}
            hasConfiguredOutput={configured}
            isError={overviewQ.isError}
            isLoading={librariesQ.isLoading || overviewQ.isLoading}
            labels={{ startAction: t.web.goToWorkbench, setupAction: t.libraries.createFirst }}
            onSetup={() => {
              void navigate({ to: "/libraries" });
            }}
            onStart={() => void openWorkbench("scrape")}
          />
          <OverviewMaintenanceCard onOpen={() => void openWorkbench("maintenance")} />
        </section>

        <SiteHealthCard
          sites={sitesQ.data?.sites ?? []}
          onOpenSettings={() => {
            void navigate({ to: buildHref("/settings", { section: "scrape" }) });
          }}
        />

        {overviewQ.error && <ErrorBanner>{toErrorMessage(overviewQ.error)}</ErrorBanner>}

        <ActivityTimelineCard
          entries={activityQ.data?.entries ?? []}
          onOpenMaintenance={() => {
            void navigate({ to: buildHref("/workbench", { intent: "maintenance" }) });
          }}
        />
      </div>
    </main>
  );
}

export const Route = createFileRoute("/overview")({
  component: OverviewPage,
});
