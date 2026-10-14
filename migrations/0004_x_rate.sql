CREATE TABLE rate_slots (
  name TEXT PRIMARY KEY,
  next_at_ms INTEGER NOT NULL
);

CREATE TABLE rate_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  status INTEGER NOT NULL,
  retry_after_seconds REAL,
  delay_seconds INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX idx_rate_events_recorded ON rate_events (source, recorded_at);

INSERT OR IGNORE INTO settings (key, value) VALUES ('x_qps', '0.2');
