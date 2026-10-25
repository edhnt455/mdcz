import type { ToolDefinition, ToolId } from "@mdcz/shared/toolCatalog";
import { Button } from "@mdcz/ui";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useToolNavigationStore } from "../state/toolNavigationStore";
import { ToolCatalogView } from "./ToolCatalogView";
import { ToolCardIcon } from "./ToolScaffold";

export interface ToolsRouteViewProps {
  tools: ToolDefinition[];
  renderDetail: (toolId: ToolId) => ReactNode;
}

export function ToolsRouteView({ tools, renderDetail }: ToolsRouteViewProps) {
  const pageScrollRef = useRef<HTMLDivElement>(null);
  const storedToolId = useToolNavigationStore((state) => state.selectedToolId);
  const selectedToolId = tools.some((tool) => tool.id === storedToolId) ? storedToolId : null;
  const setSelectedTool = useToolNavigationStore((state) => state.selectTool);

  const scrollToTop = () => {
    window.requestAnimationFrame(() => {
      pageScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    });
  };

  const handleSelectTool = (toolId: ToolId) => {
    setSelectedTool(toolId);
    scrollToTop();
  };

  const handleBackToOverview = () => {
    setSelectedTool(null);
    scrollToTop();
  };

  return (
    <div ref={pageScrollRef} className="h-full w-full overflow-y-auto bg-surface-canvas scroll-smooth">
      {selectedToolId === null ? (
        <main className="mx-auto w-full max-w-[1120px] px-6 py-8 md:px-8 lg:px-10 lg:py-10">
          <ToolCatalogView
            renderIcon={(tool) => <ToolCardIcon icon={tool.overviewIcon} />}
            tools={tools}
            onSelect={handleSelectTool}
          />
        </main>
      ) : (
        <main className="mx-auto flex w-full max-w-[1120px] flex-col px-6 py-6 md:px-8 lg:px-10 lg:py-8">
          <div className="sticky top-0 z-10 mb-6 w-fit rounded-full bg-surface-canvas/92 pt-1 backdrop-blur-sm">
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={handleBackToOverview}
              className="h-12 w-12 rounded-full bg-surface-low text-foreground shadow-[0_12px_24px_rgba(15,23,42,0.06)] hover:bg-surface-raised/80"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </div>

          {renderDetail(selectedToolId)}
          <div className="h-2" />
        </main>
      )}
    </div>
  );
}
