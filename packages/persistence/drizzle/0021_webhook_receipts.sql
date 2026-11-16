CREATE TABLE emby_notification_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  result_json TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
