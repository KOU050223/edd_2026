-- マップを AI で作るときに作る確認問題（#247）。対象は AI で作るマップだけ（手で作るマップでは作らない）。
--
-- ## user_concept_checks.origin
--
-- その組をいつ作ったか。map_creation はマップを作るときにマップの定義だけから作った組で、
-- 本人の質問などの個人のデータを含まない。共有の側へ上げられるのはこれだけ（判定は #244 で足す）。
-- on_demand は解くときに作った組で、本人の質問を材料にしうる。作り直すと on_demand に戻る。
ALTER TABLE user_concept_checks
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'on_demand' CHECK (origin IN ('on_demand', 'map_creation'));

-- ## learning_maps の作成時の問題の状態
--
-- creation_checks_level: マップを AI で作るときに「確認問題も作る」を選んだら、そのときの技術レベル。
--   NULL なら作成時の問題を作らない（手で作ったマップ・断ったマップ）。
-- creation_checks_attempts: 作成時の問題を頼んだ回数。全部失敗したときにもう一度だけ頼めるよう数える。
-- creation_checks_done_at: 1組でも保存できた時刻。以後は作成時の問題を頼めない。
-- creation_checks_started_at_ms: 作っている最中の印（頼んだ時刻）。印がある間は次の要求を通さない
--   （同時に2回頼まれて二重に作らないため）。終われば消す。Worker が途中で止まって印が残っても
--   固まらないよう、一定時間（maps/creation-checks.ts の CREATION_CHECKS_LEASE_MS）を過ぎた印は無いものとして扱う。
ALTER TABLE learning_maps
  ADD COLUMN creation_checks_level TEXT CHECK (creation_checks_level IN ('intro', 'basic', 'advanced'));
ALTER TABLE learning_maps ADD COLUMN creation_checks_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE learning_maps ADD COLUMN creation_checks_done_at TEXT;
ALTER TABLE learning_maps ADD COLUMN creation_checks_started_at_ms INTEGER;
