-- 一条运行只发一条收尾消息。三个来源链同时结束时，只有抢到这一列的调用会入队。
ALTER TABLE runs ADD COLUMN finalize_enqueued_at TEXT;
