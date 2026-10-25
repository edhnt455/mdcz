ALTER TABLE `library_item_files` ADD COLUMN `strm_source_json` text;
--> statement-breakpoint
ALTER TABLE `emby_deletion_settings` ADD COLUMN `movie_pilot_json` text;
--> statement-breakpoint
ALTER TABLE `emby_deletion_events` ADD COLUMN `event_type` text NOT NULL DEFAULT 'library.deleted';
--> statement-breakpoint
ALTER TABLE `emby_deletion_events` ADD COLUMN `step` text NOT NULL DEFAULT 'validating';
--> statement-breakpoint
ALTER TABLE `emby_deletion_events` ADD COLUMN `snapshot_json` text;
--> statement-breakpoint
ALTER TABLE `emby_deletion_events` ADD COLUMN `cloud_deleted_at` integer;
--> statement-breakpoint
CREATE TABLE `strm_cloud_bindings` (
  `file_id` text PRIMARY KEY NOT NULL,
  `library_id` text NOT NULL,
  `link_path` text NOT NULL,
  `source_path` text NOT NULL,
  `snapshot_json` text NOT NULL,
  `blocked` integer NOT NULL DEFAULT 0 CHECK (`blocked` IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `strm_cloud_bindings_source_idx` ON `strm_cloud_bindings` (`source_path`);
