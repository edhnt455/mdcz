import { createContext } from "react";
import type { FieldAnchor } from "./settingsRegistry";

export type SettingsSectionId = FieldAnchor | "advancedSettings";

export const SettingsNavigationContext = createContext<SettingsSectionId | null>(null);
