ALTER TABLE subtitle_update_jobs ADD COLUMN bindings_json TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE TABLE subtitle_update_state (
  movie_id TEXT PRIMARY KEY NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  subtitle_fingerprint TEXT NOT NULL,
  notify_pending INTEGER NOT NULL DEFAULT 0
);
