CREATE INDEX library_items_number_lower_idx ON library_items(lower(number));
--> statement-breakpoint
CREATE INDEX strm_cloud_bindings_resource_idx ON strm_cloud_bindings(json_extract(snapshot_json, '$.connectionId'), json_extract(snapshot_json, '$.target.fileid'));
--> statement-breakpoint
CREATE INDEX emby_deletion_events_history_idx ON emby_deletion_events(status, received_at);
