-- 言語別マップの作成者（#245 の決定 N4）。
--
-- ## fixed_map_creators
--
-- その言語のマップ（packages/domain/concepts.md の language）の作成者だけが、
-- 固定の Concept の「理解すること」を AI で作り、手で直せる。
-- **作成者を変える API は作らない。** 行は手で SQL を流して入れる（apps/api/README.md）。
-- Auth0 の sub を公開リポジトリのマイグレーションに書かないため、ここでは行を入れない。
-- #218 で言語別マップを D1 へ移すときは、この作成者をそのままマップの持ち主にする。
-- 退会では users と一緒に消える。項目（learning_objectives）は作成者に属さないので残る。
CREATE TABLE fixed_map_creators (
  language TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (language, user_id)
);

-- ## fixed_objective_revisions
--
-- 固定の Concept の「理解すること」の版。確定（PUT .../concepts/:conceptId/objectives）のたびに
-- 新しい値を振る。確定は今の項目を読んで ID を確かめてから書くので、その間に別の確定が入ったら
-- 書かない（読んだときの版と違えば 409）。行が無いのは、まだ一度も確定していない Concept。
CREATE TABLE fixed_objective_revisions (
  concept_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL
);
