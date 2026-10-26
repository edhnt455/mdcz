import { ACTOR_IMAGE_SOURCE_OPTIONS, ACTOR_OVERVIEW_SOURCE_OPTIONS } from "@mdcz/shared/actorSource";
import { Button } from "@mdcz/ui";
import {
  BoolField,
  ChipArrayFieldWrapper,
  CookieFieldWrapper,
  TextField,
  UrlField,
} from "../../config-form/FieldRenderer";
import { useT } from "../../i18n";
import { useSettingsSearch } from "../SettingsSearchContext";
import { useSettingsServices } from "../SettingsServices";
import { Subsection } from "../Subsection";
import { EmbyDeletionPanel } from "./EmbyDeletionPanel";

export function MediaServerSection() {
  const t = useT();
  const services = useSettingsServices();
  const search = useSettingsSearch();
  return (
    <>
      <Subsection title="Jellyfin" className="mb-6 last:mb-0">
        <UrlField name="jellyfin.url" />
        <CookieFieldWrapper name="jellyfin.apiKey" />
        <TextField name="jellyfin.userId" />
        <BoolField name="jellyfin.refreshPersonAfterSync" />
        <BoolField name="jellyfin.lockOverviewAfterSync" />
        <BoolField name="jellyfin.notifyAfterPublish" />
      </Subsection>
      <Subsection title="Emby" className="mb-6 last:mb-0">
        <UrlField name="emby.url" />
        <CookieFieldWrapper name="emby.apiKey" />
        <TextField name="emby.userId" />
        <BoolField name="emby.refreshPersonAfterSync" />
        <BoolField name="emby.notifyAfterPublish" />
        <BoolField name="emby.autoSyncActorPhotos" />
        <TextField name="emby.actorPhotoDailySyncTime" />
        {services.openActorPhotoSync && (
          <Button type="button" variant="secondary" onClick={services.openActorPhotoSync}>
            {t.tools.autoPhotoSync.open}
          </Button>
        )}
        {services.embyDeletion && !search.hasActiveFilters ? (
          <EmbyDeletionPanel service={services.embyDeletion} />
        ) : null}
      </Subsection>
      <Subsection
        title={t.settings.subsections.sharedPersonSources}
        description={t.settings.subsections.sharedPersonSourcesHint}
        className="mb-6 last:mb-0"
      >
        <ChipArrayFieldWrapper name="personSync.personOverviewSources" options={[...ACTOR_OVERVIEW_SOURCE_OPTIONS]} />
        <ChipArrayFieldWrapper name="personSync.personImageSources" options={[...ACTOR_IMAGE_SOURCE_OPTIONS]} />
      </Subsection>
    </>
  );
}
