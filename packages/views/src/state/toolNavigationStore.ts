import type { ToolId } from "@mdcz/shared/toolCatalog";
import { create } from "zustand";

const STORAGE_KEY = "mdcz:selected-tool-id";
export const useToolNavigationStore = create<{
  selectedToolId: ToolId | null;
  personServer: "emby" | "jellyfin";
  selectTool: (tool: ToolId | null) => void;
  selectPersonServer: (server: "emby" | "jellyfin") => void;
}>((set) => ({
  selectedToolId: typeof sessionStorage === "undefined" ? null : (sessionStorage.getItem(STORAGE_KEY) as ToolId | null),
  personServer: "emby",
  selectTool: (selectedToolId) => {
    set({ selectedToolId });
    if (typeof sessionStorage !== "undefined") {
      if (selectedToolId) sessionStorage.setItem(STORAGE_KEY, selectedToolId);
      else sessionStorage.removeItem(STORAGE_KEY);
    }
  },
  selectPersonServer: (personServer) => set({ personServer }),
}));

export const openEmbyPhotoSync = () => {
  useToolNavigationStore.getState().selectPersonServer("emby");
  useToolNavigationStore.getState().selectTool("media-library-tools");
};
