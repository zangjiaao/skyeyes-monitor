-- 删除只隐藏记录。dedupe_key、链接和标题留在表里，避免同一条内容被重新采集。
ALTER TABLE records ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_records_deleted_at ON records (deleted_at);
