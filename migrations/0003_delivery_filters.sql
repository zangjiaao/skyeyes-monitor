ALTER TABLE records ADD COLUMN title_key TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN url_key TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN time_status TEXT NOT NULL DEFAULT 'in_window';
ALTER TABLE records ADD COLUMN relevance_score REAL;
ALTER TABLE records ADD COLUMN exclude_reason TEXT;
ALTER TABLE records ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0;
ALTER TABLE records ADD COLUMN author_followers INTEGER;
ALTER TABLE records ADD COLUMN author_created_at TEXT;

CREATE INDEX idx_records_url_key ON records (url_key);
CREATE INDEX idx_records_title_key ON records (title_key);

-- 已有行如果没有发布时间，不能进入日报。
UPDATE records
SET time_status = 'unknown', exclude_reason = 'time:unknown'
WHERE published_at IS NULL OR published_at = '';

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('min_text_length', '20'),
  ('exclude_words', ''),
  ('blocked_accounts', ''),
  ('min_followers', '0'),
  ('min_account_age_days', '0'),
  ('exclude_retweets', '1'),
  ('exclude_ads', '1'),
  ('relevance_enabled', '1'),
  ('relevance_threshold', '40');
