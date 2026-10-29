ALTER TABLE `scrape_conflict_resolutions` ADD `error` text;
--> statement-breakpoint
ALTER TABLE `scrape_conflict_resolutions` ADD `updated_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `emby_deletion_events` SET `status` = 'needs_review', `completed_at` = NULL
WHERE `status` = 'ignored' AND `event_type` = 'deep.delete' AND `result` = 'cloud_binding_unverified';
