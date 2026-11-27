CREATE TABLE collect_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'manual')),
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule_hour INTEGER,
  window_hours INTEGER,
  country_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_collect_jobs_due ON collect_jobs (kind, enabled, schedule_hour);
