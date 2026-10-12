CREATE TABLE IF NOT EXISTS countries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'organization', 'keyword')),
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_targets_country_active ON targets (country_id, active);

CREATE TABLE IF NOT EXISTS recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  collected_date TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('collecting', 'finalizing', 'completed', 'partial')),
  expected_batches INTEGER NOT NULL DEFAULT 0,
  completed_batches INTEGER NOT NULL DEFAULT 0,
  failed_batches INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  finalize_started_at TEXT,
  created_at TEXT NOT NULL,
  finalized_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_collected_date ON runs (collected_date, created_at);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  country_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('x', 'web')),
  provider_id TEXT NOT NULL,
  target_ids TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_batches_run ON batches (run_id, status);

CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('x', 'web')),
  external_id TEXT,
  url TEXT NOT NULL,
  original_text TEXT NOT NULL,
  published_at TEXT,
  author_handle TEXT,
  author_name TEXT,
  author_url TEXT,
  country_id INTEGER NOT NULL,
  country_code TEXT NOT NULL,
  country_name TEXT NOT NULL,
  matched_target TEXT NOT NULL,
  collected_date TEXT NOT NULL,
  translation_zh TEXT,
  run_id TEXT NOT NULL,
  lang TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_collected ON records (collected_date);
CREATE INDEX IF NOT EXISTS idx_records_country ON records (country_code, collected_date);
CREATE INDEX IF NOT EXISTS idx_records_untranslated ON records (id) WHERE translation_zh IS NULL;
