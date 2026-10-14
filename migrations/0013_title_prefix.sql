-- 标题去重改为等值匹配。D1 的模式串最长 50 字节，24 个中文或印地语字符大约 72 字节。
ALTER TABLE records ADD COLUMN title_prefix TEXT NOT NULL DEFAULT '';

-- SQLite 的 substr / length 按 Unicode 字符计数，与 JS 的 Array.from(titleKey).slice(0, 12) 一致。
UPDATE records
SET title_prefix = substr(title_key, 1, 12)
WHERE length(title_key) >= 12;

CREATE INDEX idx_records_title_prefix ON records (title_prefix);
