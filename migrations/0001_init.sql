CREATE TABLE countries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  country_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'organization', 'keyword', 'handle')),
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_targets_country ON targets (country_id, enabled);

CREATE TABLE recipients (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  slot_key TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  finished_at TEXT,
  batches_total INTEGER NOT NULL DEFAULT 0,
  batches_done INTEGER NOT NULL DEFAULT 0,
  batches_failed INTEGER NOT NULL DEFAULT 0,
  records_added INTEGER NOT NULL DEFAULT 0,
  email_status TEXT,
  email_error TEXT,
  notes TEXT
);

CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  country_id TEXT NOT NULL,
  source TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  target_ids TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  items_found INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX idx_batches_run ON batches (run_id, status);

CREATE TABLE records (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  external_id TEXT,
  url TEXT NOT NULL,
  country_id TEXT NOT NULL,
  country_name TEXT NOT NULL,
  matched_target_id TEXT,
  matched_target TEXT NOT NULL,
  author_handle TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  author_url TEXT NOT NULL DEFAULT '',
  original_text TEXT NOT NULL,
  published_at TEXT,
  collected_at TEXT NOT NULL,
  translation_zh TEXT,
  run_id TEXT NOT NULL
);

CREATE INDEX idx_records_collected ON records (collected_at);
CREATE INDEX idx_records_country ON records (country_id, collected_at);
CREATE INDEX idx_records_published ON records (published_at);

CREATE TABLE api_usage (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  source TEXT NOT NULL,
  calls INTEGER NOT NULL,
  items INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX idx_api_usage_time ON api_usage (recorded_at, source);
