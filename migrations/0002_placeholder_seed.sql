-- 占位数据。仓库是公开的，不要把真实国家、目标、关键词或收件人写进迁移。
-- 上线后在管理后台删掉这些示例，再录入真实名单。

INSERT OR IGNORE INTO countries (id, name, code, enabled, created_at) VALUES
  ('country_demo_alpha', '示例国家甲', 'demo-alpha', 1, '2026-01-01T00:00:00.000Z'),
  ('country_demo_beta', '示例国家乙', 'demo-beta', 1, '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO targets (id, country_id, kind, name, query, enabled, created_at) VALUES
  ('target_demo_a1', 'country_demo_alpha', 'keyword', '示例关键词甲', '示例关键词甲', 1, '2026-01-01T00:00:00.000Z'),
  ('target_demo_a2', 'country_demo_alpha', 'organization', '示例机构甲', '示例机构甲', 1, '2026-01-01T00:00:00.000Z'),
  ('target_demo_b1', 'country_demo_beta', 'keyword', '示例关键词乙', '示例关键词乙', 1, '2026-01-01T00:00:00.000Z'),
  ('target_demo_b2', 'country_demo_beta', 'handle', '示例账号乙', 'example_handle_beta', 0, '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO recipients (id, email, enabled, created_at) VALUES
  ('recipient_demo', 'placeholder@example.com', 0, '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('schedule_hour', '10'),
  ('window_hours', '24'),
  ('batch_size', '12'),
  ('timezone', 'Asia/Shanghai'),
  ('translation_enabled', '1'),
  ('translation_source_lang', 'en'),
  ('translation_target_lang', 'zh'),
  ('email_enabled', '0'),
  ('email_provider', 'resend'),
  ('email_from', ''),
  ('email_from_name', 'SkyEyes'),
  ('x_enabled', '1'),
  ('google_news_enabled', '1'),
  ('gdelt_enabled', '0'),
  ('excel_key', 'skyeyes.xlsx'),
  ('allowed_admin_emails', ''),
  ('app_base_url', ''),
  ('finalize_deadline_minutes', '60'),
  ('x_max_pages', '5');
