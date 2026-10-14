ALTER TABLE batches ADD COLUMN lease_expires_at TEXT;
ALTER TABLE batches ADD COLUMN lease_token TEXT;
ALTER TABLE batches ADD COLUMN items_fetched INTEGER NOT NULL DEFAULT 0;
ALTER TABLE batches ADD COLUMN items_deduped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE batches ADD COLUMN items_filtered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE batches ADD COLUMN items_added INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_batches_lease ON batches (status, lease_expires_at);
