-- 示例种子数据，全部是占位符。
-- 不要把真实的国家、监测对象、关键词或收件人写入 Git。
-- 真实数据请用管理 API 写入，或复制本文件为 seed/local.sql（已在 .gitignore 中）后再执行。
--
-- 远程：npx wrangler d1 execute DB --remote --file=seed/example.sql
-- 本地：npx wrangler d1 execute DB --local --file=seed/example.sql

INSERT INTO countries (code, name, created_at) VALUES
  ('country-a', 'Country A placeholder', '2026-01-01T00:00:00.000Z'),
  ('country-b', 'Country B placeholder', '2026-01-01T00:00:00.000Z');

INSERT INTO targets (country_id, kind, name, query, active, created_at)
SELECT id, 'person', 'Example Person A1', 'Example Person A1', 1, '2026-01-01T00:00:00.000Z'
FROM countries WHERE code = 'country-a';

INSERT INTO targets (country_id, kind, name, query, active, created_at)
SELECT id, 'organization', 'Example Org A1', 'Example Org A1', 1, '2026-01-01T00:00:00.000Z'
FROM countries WHERE code = 'country-a';

INSERT INTO targets (country_id, kind, name, query, active, created_at)
SELECT id, 'keyword', 'example-keyword-a', 'example-keyword-a', 1, '2026-01-01T00:00:00.000Z'
FROM countries WHERE code = 'country-a';

INSERT INTO targets (country_id, kind, name, query, active, created_at)
SELECT id, 'person', 'Example Person B1', 'Example Person B1', 1, '2026-01-01T00:00:00.000Z'
FROM countries WHERE code = 'country-b';

INSERT INTO targets (country_id, kind, name, query, active, created_at)
SELECT id, 'organization', 'Example Org B1', 'Example Org B1', 1, '2026-01-01T00:00:00.000Z'
FROM countries WHERE code = 'country-b';

INSERT INTO recipients (email, active, created_at) VALUES
  ('ops-placeholder@example.com', 1, '2026-01-01T00:00:00.000Z');
