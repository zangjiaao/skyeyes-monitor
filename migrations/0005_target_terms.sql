ALTER TABLE targets ADD COLUMN terms TEXT NOT NULL DEFAULT '';
ALTER TABLE targets ADD COLUMN exclude_terms TEXT NOT NULL DEFAULT '';
ALTER TABLE targets ADD COLUMN case_sensitive INTEGER NOT NULL DEFAULT 0;

-- 旧的单检索词成为该目标的第一条检索词。
UPDATE targets SET terms = query WHERE terms = '';

ALTER TABLE records ADD COLUMN matched_term TEXT NOT NULL DEFAULT '';
