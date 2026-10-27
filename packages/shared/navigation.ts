export type AppRouteId =
  | "overview"
  | "workbench"
  | "pending"
  | "tools"
  | "library"
  | "libraries"
  | "settings"
  | "logs"
  | "about";

export interface AppRouteDefinition {
  id: AppRouteId;
  path: string;
  group: "primary" | "system";
}

export const APP_ROUTE_DEFINITIONS: AppRouteDefinition[] = [
  { id: "overview", path: "/overview", group: "primary" },
  { id: "workbench", path: "/workbench", group: "primary" },
  { id: "pending", path: "/pending", group: "primary" },
  { id: "library", path: "/library", group: "primary" },
  { id: "tools", path: "/tools", group: "primary" },
  { id: "libraries", path: "/libraries", group: "system" },
  { id: "settings", path: "/settings", group: "system" },
  { id: "logs", path: "/logs", group: "system" },
  { id: "about", path: "/about", group: "system" },
];

export const PRIMARY_APP_ROUTES = APP_ROUTE_DEFINITIONS.filter((route) => route.group === "primary");
export const SYSTEM_APP_ROUTES = APP_ROUTE_DEFINITIONS.filter((route) => route.group === "system");
