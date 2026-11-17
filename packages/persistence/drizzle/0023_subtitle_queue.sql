ALTER TABLE subtitle_update_jobs RENAME TO subtitle_update_jobs_previous;
--> statement-breakpoint
CREATE TABLE subtitle_update_jobs (
  task_id TEXT PRIMARY KEY NOT NULL,
  movie_key TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'queued',
  progress TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
--> statement-breakpoint
INSERT INTO subtitle_update_jobs (task_id, movie_key, inputs_json, status, stage, result_json, warnings_json, error, created_at, updated_at, completed_at)
SELECT task_id, json_extract(input_json, '$.mediaPath'), json_array(json(input_json)), status, CASE status WHEN 'running' THEN 'scanning' WHEN 'failed' THEN 'scanning' ELSE status END, result_json, warnings_json, error, created_at, created_at,
  CASE WHEN status IN ('completed', 'failed') THEN created_at END
FROM subtitle_update_jobs_previous;
--> statement-breakpoint
CREATE INDEX subtitle_update_jobs_queue_idx ON subtitle_update_jobs(status, created_at);
--> statement-breakpoint
CREATE INDEX subtitle_update_jobs_movie_idx ON subtitle_update_jobs(movie_key, status);
--> statement-breakpoint
CREATE TABLE subtitle_update_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES subtitle_update_jobs(task_id),
  input_json TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX subtitle_update_events_task_idx ON subtitle_update_events(task_id);
--> statement-breakpoint
INSERT INTO subtitle_update_events(event_id, task_id, input_json)
SELECT event_id, task_id, input_json FROM subtitle_update_jobs_previous;
--> statement-breakpoint
DROP TABLE subtitle_update_jobs_previous;
