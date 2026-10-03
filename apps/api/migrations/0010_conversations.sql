-- 会話履歴（Issue #204）。質問文・選択テキスト・AI の回答の本文を、
-- 「質問履歴の保存」オプトインを有効にした利用者の分だけ保存する。
-- 設計の正本は docs/conversation-history.md。
--
-- messages を正規化せず JSON 列にするのは、learning_events.concept_ids を
-- JSON 文字列で持つ既存の流儀に合わせるため。会話は1レコード単位で
-- upsert・読み出しするので、メッセージ単位のテーブルは要らない。
CREATE TABLE conversations (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 保存したクライアント。CONTRACT 側の picklist と揃える。
  origin TEXT NOT NULL CHECK (origin IN ('desktop', 'vscode', 'web', 'cli')),
  -- 送信元の端末。診断と将来の端末別表示のための記録で、読み出しの条件には使わない。
  client_id TEXT,
  title TEXT,
  language TEXT,
  file_name TEXT,
  -- JSON: ConversationMessage[] = { role: "context"|"user"|"assistant", text, at }[]
  messages TEXT NOT NULL,
  message_count INTEGER NOT NULL CHECK (message_count >= 1),
  -- 回答が最後まで届いたか。中断された会話は 0 で残る。
  complete INTEGER NOT NULL DEFAULT 1 CHECK (complete IN (0, 1)),
  -- occurred_at は ISO 8601 の文字列表現、_ms 側は比較・並び替え用の数値。
  -- イベントと同じく両方持つ（0001_initial.sql と同じ形）。
  occurred_at TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  -- イベントと同じくユーザー単位の冪等性。ID はクライアント採番で
  -- グローバルには一意でない。
  PRIMARY KEY (user_id, id)
);
-- GET /v1/conversations の一覧は更新時刻の降順でカーソルを進める。
CREATE INDEX idx_conversations_user_updated
  ON conversations (user_id, updated_at_ms DESC, id);

-- 「質問履歴の保存」オプトイン。既定は無効（0）。
-- PUT /v1/user-settings で省略されたときは保存済みの値を維持する
-- （contract/user-settings.ts を参照）。列の既定値だけに頼ると、
-- 省略した入力が上書きで黙って 0 に倒れる。
ALTER TABLE user_settings
  ADD COLUMN save_conversation_history INTEGER NOT NULL DEFAULT 0
    CHECK (save_conversation_history IN (0, 1));
