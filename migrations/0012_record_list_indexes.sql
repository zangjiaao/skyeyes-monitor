-- 数据页按未删除行筛选、按发布时间和相关度排序。
CREATE INDEX idx_records_list_published ON records (deleted_at, published_at);
CREATE INDEX idx_records_list_country ON records (deleted_at, country_id, published_at);
CREATE INDEX idx_records_list_source ON records (deleted_at, source, published_at);
CREATE INDEX idx_records_list_target ON records (deleted_at, matched_target);
CREATE INDEX idx_records_list_target_id ON records (deleted_at, matched_target_id);
CREATE INDEX idx_records_list_score ON records (deleted_at, relevance_score);
CREATE INDEX idx_records_list_translation ON records (deleted_at, translation_status);
CREATE INDEX idx_records_list_spam ON records (deleted_at, is_spam);
