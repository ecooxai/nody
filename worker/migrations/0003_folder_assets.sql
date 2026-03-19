CREATE TABLE IF NOT EXISTS folder_assets (
  id TEXT PRIMARY KEY,
  folder_id TEXT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
