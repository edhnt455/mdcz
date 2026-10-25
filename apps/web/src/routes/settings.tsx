import { type FieldAnchor, isFieldAnchor, SettingsPage } from "@mdcz/views/settings";
import { openEmbyPhotoSync } from "@mdcz/views/state/toolNavigationStore";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useConfigProfiles, useCurrentConfig, useDefaultConfig } from "../hooks/configQueries";
import { createProfileActions, createSettingsServices } from "./settingsController";

const SettingsRoute = () => {
  const { section } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const configQ = useCurrentConfig();
  const defaultsQ = useDefaultConfig();
  const profilesQ = useConfigProfiles();
  const services = useMemo(
    () => ({
      ...createSettingsServices(queryClient),
      openActorPhotoSync: () => {
        openEmbyPhotoSync();
        void navigate({ to: "/tools" });
      },
    }),
    [queryClient, navigate],
  );
  const profileActions = useMemo(() => createProfileActions(queryClient), [queryClient]);

  return (
    <SettingsPage
      config={configQ.data}
      configError={configQ.error}
      defaultConfig={defaultsQ.data}
      profiles={profilesQ.data}
      profilesLoading={profilesQ.isLoading}
      services={services}
      profileActions={profileActions}
      initialSection={section}
    />
  );
};

export const Route = createFileRoute("/settings")({
  validateSearch: (search): { section?: FieldAnchor } => ({
    section: isFieldAnchor(search.section) ? search.section : undefined,
  }),
  component: SettingsRoute,
});
