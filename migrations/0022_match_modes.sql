-- SQLite 不能改已有 CHECK。重建 targets，让匹配方式可以是至少一个词或保留全部检索结果。
CREATE TABLE targets_next (
  id TEXT PRIMARY KEY,
  country_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'organization', 'keyword', 'handle')),
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  terms TEXT NOT NULL DEFAULT '',
  exclude_terms TEXT NOT NULL DEFAULT '',
  case_sensitive INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  match_mode TEXT NOT NULL DEFAULT 'phrase'
    CHECK (match_mode IN ('phrase', 'all_words', 'any_word', 'unfiltered'))
);

INSERT INTO targets_next (
  id, country_id, kind, name, query, enabled, created_at, terms, exclude_terms, case_sensitive, description, match_mode
)
SELECT
  id, country_id, kind, name, query, enabled, created_at, terms, exclude_terms, case_sensitive, description, match_mode
FROM targets;

DROP TABLE targets;
ALTER TABLE targets_next RENAME TO targets;
CREATE INDEX idx_targets_country ON targets (country_id, enabled);
