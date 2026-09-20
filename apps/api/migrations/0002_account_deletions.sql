-- 既存環境にも退会中マーカーを追加する。新規環境でも安全に適用できるよう
-- CREATE IF NOT EXISTS とする。
CREATE TABLE IF NOT EXISTS account_deletions (
  user_id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL
);
