ALTER TABLE batches ADD COLUMN enqueued_at TEXT;

CREATE INDEX idx_batches_unenqueued ON batches (run_id, status, enqueued_at);
