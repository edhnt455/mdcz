CREATE TABLE subtitle_update_jobs (
  task_id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at INTEGER NOT NULL
);
