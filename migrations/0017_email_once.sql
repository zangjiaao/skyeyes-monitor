-- 日报发送前抢占 email_sent_at。成功后保留，失败后清空，以便下一次收尾重试。
ALTER TABLE runs ADD COLUMN email_sent_at TEXT;

-- 日报和测试信的发送记录。收件人是当时的地址列表，不是配置页的当前名单。
CREATE TABLE email_log (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  kind TEXT NOT NULL,
  recipients TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  message_id TEXT,
  attachment_mode TEXT NOT NULL,
  attachment_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_email_log_created ON email_log (created_at DESC, id DESC);
