-- 保存任务启动时的范围，以及按来源的查询进度与最近活动。
ALTER TABLE runs ADD COLUMN scope_json TEXT;
ALTER TABLE batches ADD COLUMN queries_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE batches ADD COLUMN queries_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE batches ADD COLUMN items_received INTEGER NOT NULL DEFAULT 0;
ALTER TABLE batches ADD COLUMN last_activity_at TEXT;
ALTER TABLE batches ADD COLUMN phase TEXT;
ALTER TABLE batches ADD COLUMN wait_reason TEXT;
ALTER TABLE batches ADD COLUMN current_query_json TEXT;

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  batch_id TEXT,
  source TEXT,
  type TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_run_events_run ON run_events (run_id, id DESC);

CREATE INDEX idx_records_run ON records (run_id);
