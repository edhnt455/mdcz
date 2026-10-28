CREATE TABLE `scrape_conflict_resolutions` (
  `item_id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `snapshot_json` text NOT NULL,
  `token` text NOT NULL,
  `keep` text,
  `step` text DEFAULT 'validating' NOT NULL,
  `retry_run_id` text
);
