-- 生成した確認問題の保存（Issue #185 / Web/08）。
--
-- Concept ごとに1組（概要問題と実践問題の2問）を持ち、**全利用者で使い回す。**
-- 生成の入力は Concept の定義だけで、利用者個人の情報を含まない（#184、
-- apps/api/src/checks/prompt.ts）。したがってここに入るのは個人データではなく、
-- 全利用者共有の静的コンテンツである。
--
-- ## user_id を持たず、users(id) を参照しない
--
-- user_settings（0003）や ai_usage（0004）は `users(id)` を ON DELETE CASCADE で
-- 参照し、退会が `DELETE FROM users` 1文で全データを消せる前提を守っている。
-- **この表はその逆の判断をする。** 個人データではないので退会・学習データの削除・
-- エクスポートの対象に含めない。既存の表に倣って CASCADE を付けると、
-- 最初に生成させた利用者が退会した時点で全員分の問題が消える。
--
-- 利用者の回答内容はここにも、他のどこにも保存しない。正誤は learning_events の
-- check_passed / check_failed として Concept と結果だけを記録する（#43 / #77）。
--
-- ## 作り直す条件
--
-- `prompt_sha256` は生成に使ったプロンプト全文の SHA-256 である。プロンプトは
-- Concept の label / summary / 前提 / 次に接続する Concept と、出題の方針・出力形式・
-- 文字数の上限から組み立てるので、そのどれかが変わればハッシュが変わる。
-- `format_version` は、プロンプトに現れない受理側の規則（検証の強化など）を変えたときに
-- 手で上げる版である（apps/api/src/checks/cache.ts の CHECK_FORMAT_VERSION）。
-- 読み出し時にどちらかが現在の値と食い違えば、保存済みを使わずに生成し直して上書きする。
CREATE TABLE concept_checks (
  concept_id TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  -- ConceptCheck の overview / practice を JSON で持つ。受理時に検証済みの形だけを書く。
  body TEXT NOT NULL,
  -- 上流が報告したモデル名。問題の出所を追えるように残す。
  model TEXT NOT NULL,
  generated_at TEXT NOT NULL
);
