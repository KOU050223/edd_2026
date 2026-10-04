-- 利用者ごとの確認問題と、その生成への同意（Issue #236 / 設計/07）。
--
-- ## user_concept_checks
--
-- 確認問題を全員で使い回さず、利用者ごとに生成して保存する。生成の入力には、
-- 利用者が選んだ技術レベル・範囲と、その項目で自力解決した本人の質問が入るので、
-- **ここに入るのは個人の学習データである。** 全員共通の concept_checks（0009）とは逆に
-- users(id) を ON DELETE CASCADE で参照し、退会の `DELETE FROM users` 1文で消える。
-- 学習データの削除（DELETE /v1/learning-events）とエクスポートの対象にも含める。
--
-- 1人・1 Concept・1つの狙い（target）につき1組を持つ。target は
-- `concept` / `summary` / 「理解すること」の項目 ID（`<Concept ID>:<識別子>`）のどれかで、
-- 項目 ID はコロンを含むので前の2つと衝突しない（packages/domain の checkTargetOf）。
-- 「作り直す」はこの1行を上書きする。
--
-- 利用者の回答内容はここにも、他のどこにも保存しない（#43）。
CREATE TABLE user_concept_checks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL,
  target TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('concept', 'summary', 'objective')),
  -- scope が objective のときだけ持つ。target と同じ値になる。
  objective_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('intro', 'basic', 'advanced')),
  -- ConceptCheck の conceptId / overview / practice を JSON で持つ。受理時に検証済みの形だけを書く。
  body TEXT NOT NULL,
  model TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, concept_id, target),
  CHECK ((scope = 'objective') = (objective_id IS NOT NULL))
);

-- ## check_generation_consents
--
-- 確認問題の生成で本人の質問を AI へ送ることへの同意のうち、「今後表示しない」を
-- 選んだ記録（#236）。送信の同意（Web Worker の KV）とは別物で、版も別に持つ
-- （packages/domain の CHECK_GENERATION_CONSENT_VERSION）。版が今と違う記録は同意として扱わない。
-- 設定画面から取り消すと行を消す。退会では users と一緒に消える。
CREATE TABLE check_generation_consents (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  granted_at TEXT NOT NULL
);
