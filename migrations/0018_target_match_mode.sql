-- 旧目标保持连续短语匹配；all_words 要求每条条件中的所有词同时出现。
ALTER TABLE targets ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'phrase'
  CHECK (match_mode IN ('phrase', 'all_words'));
