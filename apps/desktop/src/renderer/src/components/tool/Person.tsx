import { toErrorMessage } from "@mdcz/shared/error";
import { useT } from "@mdcz/views/i18n";
import { useToolNavigationStore } from "@mdcz/views/state/toolNavigationStore";
import { PersonMediaLibraryDetail, type PersonServer, type PersonSyncMode } from "@mdcz/views/tools";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ipc } from "@/client/ipc";

export function Person() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const server = useToolNavigationStore((state) => state.personServer);
  const setServer = useToolNavigationStore((state) => state.selectPersonServer);
  const [modes, setModes] = useState<Record<PersonServer, { info: PersonSyncMode; photo: PersonSyncMode }>>({
    emby: { info: "missing", photo: "missing" },
    jellyfin: { info: "missing", photo: "missing" },
  });
  const stateQ = useQuery({ queryKey: ["person-sync"], queryFn: ipc.tool.personSyncStatus, refetchInterval: 2000 });
  const checkM = useMutation({
    mutationFn: (target: PersonServer) =>
      target === "emby" ? ipc.tool.checkEmbyConnection() : ipc.tool.checkJellyfinConnection(),
  });
  const syncM = useMutation({
    mutationFn: ({ target, kind }: { target: PersonServer; kind: "info" | "photo" }) => {
      const mode = modes[target][kind];
      if (target === "emby")
        return kind === "photo" ? ipc.tool.syncEmbyActorPhoto(mode) : ipc.tool.syncEmbyActorInfo(mode);
      return kind === "photo" ? ipc.tool.syncJellyfinActorPhoto(mode) : ipc.tool.syncJellyfinActorInfo(mode);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["person-sync"] }),
  });
  const job = stateQ.data?.job;
  const running = job?.status === "running" ? job : null;
  const activeServer = running?.server ?? server;
  const panelState = (target: PersonServer) => ({
    checkPending: checkM.isPending && checkM.variables === target,
    checkResult: checkM.variables === target ? (checkM.data ?? null) : null,
    infoMode: modes[target].info,
    photoMode: modes[target].photo,
    infoSyncRunning:
      (running?.server === target && running.kind === "info") ||
      (syncM.isPending && syncM.variables?.target === target && syncM.variables.kind === "info"),
    photoSyncRunning:
      (running?.server === target && running.kind === "photo") ||
      (syncM.isPending && syncM.variables?.target === target && syncM.variables.kind === "photo"),
    progress: running?.server === target && running.total > 0 ? (running.current / running.total) * 100 : 0,
    infoText:
      target === "emby"
        ? modes[target].info === "missing"
          ? t.desktop.embyInfoMissing
          : t.desktop.embyInfoAll
        : modes[target].info === "missing"
          ? t.desktop.jellyfinInfoMissing
          : t.desktop.jellyfinInfoAll,
    photoText:
      target === "emby"
        ? modes[target].photo === "missing"
          ? t.desktop.embyPhotoMissing
          : t.desktop.embyPhotoAll
        : modes[target].photo === "missing"
          ? t.desktop.jellyfinPhotoMissing
          : t.desktop.jellyfinPhotoAll,
    photoNotice: target === "emby" ? t.web.photoAdminNotice : undefined,
  });
  return (
    <div className="space-y-4">
      <PersonMediaLibraryDetail
        activeServer={activeServer}
        emby={panelState("emby")}
        jellyfin={panelState("jellyfin")}
        syncState={stateQ.data}
        settingsDisabled={syncM.isPending}
        onServerChange={setServer}
        onCheck={(target) => checkM.mutate(target)}
        onInfoModeChange={(target, mode) =>
          setModes((current) => ({ ...current, [target]: { ...current[target], info: mode } }))
        }
        onPhotoModeChange={(target, mode) =>
          setModes((current) => ({ ...current, [target]: { ...current[target], photo: mode } }))
        }
        onOpenSettings={() => {
          void navigate({ to: "/settings", search: { section: "mediaServer" } });
        }}
        onSyncInfo={(target) => syncM.mutate({ target, kind: "info" })}
        onSyncPhoto={(target) => syncM.mutate({ target, kind: "photo" })}
      />
      {(stateQ.error || syncM.error || checkM.error) && (
        <p role="alert" className="text-sm text-destructive">
          {toErrorMessage(stateQ.error ?? syncM.error ?? checkM.error)}
        </p>
      )}
    </div>
  );
}
