import { ipc } from "@/client/ipc";

export const overviewKeys = {
  all: ["overview"] as const,
  output: ["overview", "output-summary"] as const,
};

export const fetchOutputSummary = () => ipc.overview.getOutputSummary();
