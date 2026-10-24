CREATE TABLE `emby_deletion_settings` (
  `id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
  `mode` text NOT NULL DEFAULT 'off' CHECK (`mode` IN ('off', 'observe', 'delete')),
  `server_id` text NOT NULL DEFAULT '',
  `libraries_json` text NOT NULL DEFAULT '[]',
  `secret_hash` text
);
--> statement-breakpoint
INSERT INTO `emby_deletion_settings` (`id`) VALUES (1);
--> statement-breakpoint
CREATE TABLE `emby_deletion_events` (
  `id` text PRIMARY KEY NOT NULL,
  `dedup_key` text NOT NULL UNIQUE,
  `server_id` text NOT NULL,
  `item_id` text NOT NULL,
  `event_at` integer,
  `received_at` integer NOT NULL,
  `path` text,
  `library_id` text,
  `output_path` text,
  `file_id` text,
  `file_updated_at` integer,
  `movie_id` text,
  `status` text NOT NULL CHECK (`status` IN ('pending', 'completed', 'ignored', 'needs_review')),
  `attempts` integer NOT NULL DEFAULT 0,
  `missing_since` integer,
  `next_attempt_at` integer NOT NULL,
  `result` text,
  `completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `emby_deletion_events_due_idx` ON `emby_deletion_events` (`status`, `next_attempt_at`);
