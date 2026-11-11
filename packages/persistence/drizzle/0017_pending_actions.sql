CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL,
  item_updated_at INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('delete', 'confirm')),
  input_json TEXT NOT NULL,
  item_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retrying', 'failed', 'completed')),
  progress TEXT NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX pending_actions_active_item_idx ON pending_actions(item_id)
  WHERE status IN ('queued', 'running', 'retrying');
--> statement-breakpoint
ALTER TABLE pending_items ADD COLUMN task_id TEXT;
--> statement-breakpoint
ALTER TABLE pending_items ADD COLUMN task_kind TEXT;
