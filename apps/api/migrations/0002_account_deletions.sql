-- 0001_initial.sql に含めた account_deletions の既存環境向け補正。
-- 新規環境では 0001 側で作成済みのため、CREATE IF NOT EXISTS にする。
CREATE TABLE IF NOT EXISTS account_deletions (
  user_id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL
);
