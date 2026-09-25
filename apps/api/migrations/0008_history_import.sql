-- 外部 AI 履歴からの学習引き継ぎ（Issue #157）のための2表。
--
-- 生の会話本文はここへ置かない。docs/architecture.md の
-- 「必要以上に保存・送信しない」方針に従い、サーバーが持つのは
-- 正規化された LearningEvidence と、その取り込み単位である
-- import_sessions だけである。会話本文の分析は端末内で完結させ、
-- Managed AI を使う場合も本文は使い捨てで保存しない。

-- 1回の Import の実行単位。Undo はこの単位で行う。
-- IF NOT EXISTS: 0007_history_import.sql 名で一度適用した環境が
-- 改名後のこのファイルを再実行しても、重複エラーで止まらないようにする。
CREATE TABLE IF NOT EXISTS import_sessions (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- packages/domain の ImportSessionStatus。サーバーが観測するのは
  -- applied / undone だけだが、ドメインの状態機械と同じ語彙で持つ。
  status TEXT NOT NULL,
  -- desktop / agent / file / connector のいずれか。
  imported_by TEXT NOT NULL,
  -- 取り込みに使った履歴ソース（codex など）の配列を JSON 文字列で持つ。
  providers TEXT NOT NULL,
  -- 分析に回った会話数。Evidence が少なくても「何件読んだか」が分かるようにする。
  conversation_count INTEGER NOT NULL,
  -- 正規化で採用されなかった観測数（棄却 + unmapped）。Ignored の内訳に使う。
  ignored_count INTEGER NOT NULL DEFAULT 0,
  -- unmapped 候補を JSON 文字列で持つ。上限付き（書き込み側で切る）。
  -- 「一覧に無い話題」が分かると Concept 一覧の育て方の材料になる。
  unmapped_candidates TEXT NOT NULL DEFAULT '[]',

  -- Evidence は作成後に変わらないため、作成時に集計して持つ。
  -- 一覧表示のたびに learning_evidence を集計しないための列。
  evidence_count INTEGER NOT NULL,
  concept_count INTEGER NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  PRIMARY KEY (user_id, id)
);

-- 外部履歴から正規化された学習の根拠。追記のみで、Undo は
-- 「import_session_id 単位で DELETE → sessions 側を undone にする」で行う。
CREATE TABLE IF NOT EXISTS learning_evidence (
  -- `${importSessionId}:${provider}:${sourceId}`。Normalizer が採番する。
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- import_sessions(user_id, id) の複合主キーを指す論理上の外部キー。
  -- D1 の batch で同じトランザクションに入れるため、ここでは FK を張らず
  -- 書き込み側の順序（セッションを先に入れる）で整合を保つ。
  import_session_id TEXT NOT NULL,

  provider TEXT NOT NULL,
  imported_by TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- ConceptId の配列を JSON 文字列で持つ。learning_events.concept_ids と同じ表現。
  concept_ids TEXT NOT NULL,

  observed_at TEXT,
  confidence REAL NOT NULL,
  external_ref_hash TEXT,

  -- サーバーが受理した時刻。Undo や照合の診断に使う。
  received_at_ms INTEGER NOT NULL,

  PRIMARY KEY (user_id, id)
);

-- Undo（セッション単位の削除）と「なぜこの状態か」の出典表示に使う。
CREATE INDEX IF NOT EXISTS idx_learning_evidence_user_session
  ON learning_evidence (user_id, import_session_id);
-- ソース単位の削除（DELETE /v1/learning-evidence?provider=...）に使う。
CREATE INDEX IF NOT EXISTS idx_learning_evidence_user_provider
  ON learning_evidence (user_id, provider);
