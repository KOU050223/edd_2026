-- 監査ログ（基盤/08 #122）。「誰がいつ何をしたか」を後から追うための記録。
--
-- 記録するのは利用者の不可逆な操作だけである。学習イベント本体は
-- learning_events が正本なので二重に持たず、習熟度の手動上書きや設定変更のような
-- 取り消せる操作は対象にしない（docs/architecture.md「監視・監査ログ・障害時の再送」）。
--
-- users(id) を ON DELETE CASCADE で参照する。退会が `DELETE FROM users` 1文で
-- 全データを消せる前提を崩さないため（0004_ai_usage.sql と同じ判断）。
-- 退会するとこのログも消える。退会そのものの証跡はここには残らず、
-- Workers の構造化ログと Auth0 のテナントログで追う。
CREATE TABLE audit_log (
  -- 誰が。Auth0 の sub。
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 何をしたか。"learning_events.exported" / "learning_events.deleted" など。
  -- 値の一覧は repository/types.ts の AuditAction が持つ。
  action TEXT NOT NULL,
  -- いつ。サーバーが処理した時刻（epoch ミリ秒）。
  occurred_at_ms INTEGER NOT NULL,
  -- 操作の補足（消した件数など）。JSON 文字列。無ければ NULL。
  detail TEXT
);

-- 「この利用者が何をしたか」を時系列で読むための索引。
CREATE INDEX idx_audit_log_user_occurred ON audit_log (user_id, occurred_at_ms);
