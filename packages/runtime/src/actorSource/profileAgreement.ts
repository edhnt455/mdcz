import { ACTOR_PROFILE_METADATA_FIELDS, hasActorProfileFieldValue } from "@mdcz/runtime/shared";
import type { ActorProfile } from "@mdcz/shared/types";

export const actorProfilesAgree = (left: ActorProfile, right: ActorProfile): boolean =>
  ACTOR_PROFILE_METADATA_FIELDS.filter((field) => field !== "description" && field !== "photo_url").every(
    (field) =>
      !hasActorProfileFieldValue(left[field]) ||
      !hasActorProfileFieldValue(right[field]) ||
      left[field] === right[field],
  );
