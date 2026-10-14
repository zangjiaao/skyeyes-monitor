ALTER TABLE records ADD COLUMN news_edition TEXT;
INSERT OR IGNORE INTO settings (key, value) VALUES ('google_news_editions', 'en-US,zh-CN');
