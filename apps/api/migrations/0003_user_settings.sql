-- ユーザー設定。1ユーザー1行で、追記ではなく上書きする。
--
-- KV ではなく D1 に置く理由は、退会（docs/auth.md §8 / apps/api/src/routes/account.ts）が
-- `DELETE FROM users` 1文で全データを消せることに依っているため。
-- `users(id)` を ON DELETE CASCADE で参照していれば、退会の経路を変えずに
-- 設定も一緒に消える。KV へ置くと、退会が明示的に知っている必要のある
-- 削除対象が増え、消し忘れが「退会したのに設定だけ残る」として表に出る。
CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 画面に出す表示名。未設定は空文字ではなく NULL で表す。
  display_name TEXT,
  -- Learning Map の既定の表示期間（日）。/activity の選択肢と揃える。
  activity_period_days INTEGER NOT NULL DEFAULT 30
    CHECK (activity_period_days IN (7, 30, 90)),
  updated_at TEXT NOT NULL
);
