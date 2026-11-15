UPDATE emby_deletion_events
SET step = 'cleaning_source', result = 'cleaning_source', next_attempt_at = 0
WHERE step = 'verifying_cloud';
--> statement-breakpoint
UPDATE emby_deletion_events
SET result = 'cleaning_records', next_attempt_at = 0
WHERE result = 'confirming_source_cleanup';
--> statement-breakpoint
UPDATE scrape_conflict_resolutions
SET step = 'cleaning_local'
WHERE step = 'verifying_cloud';
--> statement-breakpoint
UPDATE pending_items
SET deletion_json = json_set(deletion_json, '$.step', 'cleaning_source')
WHERE json_extract(deletion_json, '$.step') = 'verifying_cloud';
