import { SiteHealthCard } from "@mdcz/views/overview";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ipc } from "@/client/ipc";
import { OverviewHeroStartCard } from "@/components/overview/OverviewHeroStartCard";
import { OverviewMaintenanceCard } from "@/components/overview/OverviewMaintenanceCard";

export const Route = createFileRoute("/overview")({
  component: Overview,
});

function Overview() {
  const navigate = useNavigate();
  const sitesQ = useQuery({ queryKey: ["overview", "sites"], queryFn: () => ipc.crawler.listSites() });
  return (
    <div className="h-full overflow-y-auto bg-surface-canvas text-foreground">
      <main className="mx-auto grid w-full max-w-[1600px] grid-cols-12 gap-6 px-6 py-6 md:px-10 lg:px-12 lg:py-8">
        <section className="col-span-12 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <OverviewHeroStartCard className="lg:col-span-2" />
          <OverviewMaintenanceCard />
        </section>

        <SiteHealthCard
          sites={sitesQ.data?.sites ?? []}
          onOpenSettings={() => {
            void navigate({ to: "/settings", search: { section: "scrape" } });
          }}
        />
      </main>
    </div>
  );
}
