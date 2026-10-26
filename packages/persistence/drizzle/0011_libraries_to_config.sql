CREATE TABLE `__new_library_watch_snapshots` (
  `library_id` text PRIMARY KEY NOT NULL,
  `file_keys_json` text NOT NULL
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_library_watch_snapshots` SELECT * FROM `library_watch_snapshots`;
--> statement-breakpoint
DROP TABLE `library_watch_snapshots`;
--> statement-breakpoint
ALTER TABLE `__new_library_watch_snapshots` RENAME TO `library_watch_snapshots`;
--> statement-breakpoint
CREATE TABLE `__new_pending_items` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('no_number', 'not_found', 'ambiguous', 'failed', 'uncensored', 'new_file')),
  `root_id` text NOT NULL REFERENCES `media_roots`(`id`) ON DELETE CASCADE,
  `relative_path` text NOT NULL,
  `library_id` text,
  `movie_id` text REFERENCES `library_items`(`id`) ON DELETE CASCADE,
  `number` text,
  `detail` text,
  `candidates_json` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_pending_items`
  SELECT `id`, `kind`, `root_id`, `relative_path`, NULL, `movie_id`, `number`, `detail`, `candidates_json`, `created_at`, `updated_at`
  FROM `pending_items`;
--> statement-breakpoint
DROP TABLE `pending_items`;
--> statement-breakpoint
ALTER TABLE `__new_pending_items` RENAME TO `pending_items`;
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_items_file_idx` ON `pending_items` (`root_id`, `relative_path`);
--> statement-breakpoint
CREATE INDEX `pending_items_updated_at_idx` ON `pending_items` (`updated_at`);
--> statement-breakpoint
DROP TABLE `media_libraries`;
