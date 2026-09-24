-- 学習履歴を削除した時刻（Issue #79）。
--
-- `DELETE /v1/learning-events` は learning_events を消すだけでは足りない。
-- 同じ利用者の同期リクエストが並行して走っていると、削除より前に受け取った
-- イベントが DELETE の後で INSERT され、「消した」と応答した後に過去の履歴が残る。
-- 同期の INSERT は、受信時刻がこの時刻以前のイベントを書かない
-- （apps/api/src/repository/d1.ts の append）。削除後に新しく届いたイベントは通る。
--
-- 消したイベントの ID は持たない。持つとそれ自体が履歴の保持になる。
-- 持つのは最後に削除した時刻1つだけである。
--
-- users(id) を ON DELETE CASCADE で参照する。退会が `DELETE FROM users` 1文で
-- 全データを消せる前提を崩さないため（0004_ai_usage.sql と同じ判断）。
CREATE TABLE learning_history_resets (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 最後に履歴を削除した時刻（epoch ミリ秒）。受信時刻がこれ以前のイベントは書かない。
  reset_at_ms INTEGER NOT NULL
);
