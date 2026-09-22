-- Managed AI の利用量（Issue #89 / Auth/10）。
--
-- KV ではなく D1 に置く。理由は2つある。
--
-- 1. 退会（docs/auth.md §8 / apps/api/src/routes/account.ts）が
--    `DELETE FROM users` 1文で全データを消せることに依っているため。
--    `users(id)` を ON DELETE CASCADE で参照していれば、退会の経路を変えずに
--    利用量も一緒に消える。KV へ置くと退会が知っているべき削除対象が増え、
--    消し忘れが「退会したのに利用量だけ残る」として表に出る（user_settings と同じ判断）。
-- 2. 書き込み頻度が KV の単価に見合わない。1ユーザー月150回が上限なので、
--    KV 書き込みの無料枠（1,000回/日）を使う理由が無く、$5.00/100万回（読み取りの10倍）
--    を払う理由も無い（docs/auth.md §10.4）。
--
-- 期間ごとに1行を持ち、回数とトークン数を加算する。日次と月次を別の行にせず
-- 1行に持つのは、上限の判定が「同じ1行を読む」で済むため。
-- 日が変わったら day_key を見て日次だけを 0 から数え直す。
CREATE TABLE ai_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 暦月（UTC）。`YYYY-MM`。月次の上限と安全弁はこの単位で数える。
  month_key TEXT NOT NULL,
  -- 集計した日（UTC）。`YYYY-MM-DD`。この行が持つ日次の回数がどの日のものかを表す。
  day_key TEXT NOT NULL,
  -- 当月の累計リクエスト数。政策値の月間上限（150回）と突き合わせる。
  monthly_requests INTEGER NOT NULL DEFAULT 0,
  -- day_key の日の累計リクエスト数。政策値の日次上限（15回）と突き合わせる。
  daily_requests INTEGER NOT NULL DEFAULT 0,
  -- 当月の累計トークン数（入力 + 出力）。利用者へ見せない安全弁。
  monthly_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, month_key)
);
