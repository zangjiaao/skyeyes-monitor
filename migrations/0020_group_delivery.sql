-- 分组各自选择推送方式，以及邮件要发给哪些收件人。
-- 已有分组保持「邮件」，并挂上当时的全部收件人，避免升级后漏发。
ALTER TABLE countries ADD COLUMN delivery TEXT NOT NULL DEFAULT 'email'
  CHECK (delivery IN ('email', 'none'));

CREATE TABLE country_recipients (
  country_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  PRIMARY KEY (country_id, recipient_id)
);

INSERT INTO country_recipients (country_id, recipient_id)
SELECT countries.id, recipients.id FROM countries CROSS JOIN recipients;
