ALTER TABLE targets ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN ai_summary TEXT;
ALTER TABLE records ADD COLUMN ai_reason TEXT;
ALTER TABLE records ADD COLUMN ai_event_type TEXT;
ALTER TABLE records ADD COLUMN ai_mentions TEXT;
ALTER TABLE records ADD COLUMN ai_provider TEXT;
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('ai_provider', 'deepseek'),
  ('ai_model', 'deepseek-chat'),
  ('ai_enabled', '1');
