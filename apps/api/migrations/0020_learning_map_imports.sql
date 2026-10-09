-- 共有マップの取り込み（Issue #244 / Web/20、2026-10-09 の決定 T3・T4・T6）。
--
-- 取り込むと、共有の側のその時点の版を、取り込んだ人の新しいマップ（個人マップ）へ複製する。
-- **ノードと「理解すること」は元の ID のまま写す。** 理解度の記録（学習イベントの concept_ids・
-- objective_ids、確認問題の objective_id）がこの ID を指すので、取り込んだ人の理解度は共有の側で見ても
-- 個人マップで見ても同じ値になる。学習データは利用者ごとに分かれていて、共有されるのはマップの形だけ。

-- ## learning_objectives を「マップ＋項目 ID」で一意にする
--
-- 0013 では項目 ID だけで一意だった。取り込みで同じ ID の項目が別の利用者のマップに入るので、
-- マップのノードの項目は (map_id, id) で、固定の Concept の項目（map_id が NULL）は id だけで一意にする。
-- 表の主キーは ALTER TABLE で変えられないので作り直す。この表を参照する外部キーは無い。
CREATE TABLE learning_objectives_v2 (
  id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  map_id TEXT,
  label TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'ai')),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (map_id, concept_id)
    REFERENCES learning_map_nodes (map_id, concept_id) ON DELETE CASCADE
);
INSERT INTO learning_objectives_v2
  (id, concept_id, map_id, label, source, position, created_at, updated_at)
SELECT id, concept_id, map_id, label, source, position, created_at, updated_at
FROM learning_objectives;
DROP TABLE learning_objectives;
ALTER TABLE learning_objectives_v2 RENAME TO learning_objectives;

CREATE UNIQUE INDEX idx_learning_objectives_fixed_id ON learning_objectives (id)
  WHERE map_id IS NULL;
CREATE UNIQUE INDEX idx_learning_objectives_map_id ON learning_objectives (map_id, id)
  WHERE map_id IS NOT NULL;
CREATE INDEX idx_learning_objectives_concept ON learning_objectives (concept_id, position);
CREATE INDEX idx_learning_objectives_map ON learning_objectives (map_id, concept_id);

-- ## learning_maps の取り込み元
--
-- 取り込んだマップ（個人マップ）だけが持つ。手で作ったマップ・AI で作ったマップは NULL。
-- source_map_id: 取り込み元の共有マップの ID。元が消えても残す（外部キーにしない）。
-- source_version: 取り込んだ（取り込み直した）版の番号。新しい版があれば「更新あり」。
-- source_key: 取り込んだときの「リンクだけ」の鍵（決定 U1）。元の持ち主が鍵を作り直したら、
--   新しい版は読めない（「更新あり」は出ない）。全員に共有されたマップから取り込んだなら NULL。
-- source_title: 取り込んだ時点の元の題名。元が読めなくなっても、どこから取り込んだかを出すため。
-- source_node_ids: 取り込んだ版のノードの Concept ID の JSON 配列。取り込み直しで、共有の側で消された
--   ノード（選んで消すか残す）と、個人マップで足したノード（そのまま残す）を見分ける（T4）。
ALTER TABLE learning_maps ADD COLUMN source_map_id TEXT;
ALTER TABLE learning_maps ADD COLUMN source_version INTEGER;
ALTER TABLE learning_maps ADD COLUMN source_key TEXT;
ALTER TABLE learning_maps ADD COLUMN source_title TEXT;
ALTER TABLE learning_maps ADD COLUMN source_node_ids TEXT;

-- 同じ共有マップを 2 回は取り込めない（取り込み直しを使う、T3）。
CREATE UNIQUE INDEX idx_learning_maps_source ON learning_maps (owner_user_id, source_map_id)
  WHERE source_map_id IS NOT NULL;

-- ## imported_map_checks
--
-- 取り込んだ版の公開の確認問題（T6）。取り込み（取り込み直し）のときに版の中身から写す。
-- 解くのは #250。元のマップが消えても、取り込んだ人の手元には残る。
-- 取り込んだ人のマップに属するので、マップを消す・退会すると CASCADE で消える。
-- 形は user_concept_checks（0012）と同じ（1 Concept・1 つの狙いにつき 1 組）。
CREATE TABLE imported_map_checks (
  map_id TEXT NOT NULL REFERENCES learning_maps(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL,
  target TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('concept', 'objective')),
  objective_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('intro', 'basic', 'advanced')),
  body TEXT NOT NULL,
  model TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (map_id, concept_id, target),
  CHECK ((scope = 'objective') = (objective_id IS NOT NULL))
);
