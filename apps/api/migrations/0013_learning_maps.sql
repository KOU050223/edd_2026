-- 利用者が手で作る学習マップ（Issue #242 / Web/18）。
--
-- 形は言語別マップと同じ木の形で、ノードは Concept、線は「前提 → 次」を表す。
-- 配置（列・行）は保存しない。前提の段数から Web 側で組み立てる（layoutTrees）。
--
-- **ここに入るのは利用者のデータである。** learning_maps は users(id) を
-- ON DELETE CASCADE で参照し、ノード・線・「理解すること」はマップから CASCADE で消える。
-- 退会の `DELETE FROM users` 1文で全部消える。

-- ## learning_maps
--
-- id はサーバーが採番する `m` + 英小文字と数字 8 文字（例: m7k2x9qa）。
-- 最初は作成者だけのもの。共有への切り替えは Web/20 (#244) で作るが、列は今から持つ。
CREATE TABLE learning_maps (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  created_at TEXT NOT NULL,
  -- updated_at は ISO 8601 の文字列表現、_ms 側は並び替え用の数値（0010_conversations.sql と同じ形）。
  updated_at TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
-- 一覧と VS Code 向けの読み出しは、更新の新しいマップから順に読む。
CREATE INDEX idx_learning_maps_owner_updated
  ON learning_maps (owner_user_id, updated_at_ms DESC, id);

-- ## learning_map_nodes
--
-- ノードは2種類ある。
-- - そのマップのノード（is_reference = 0）: concept_id は `<マップの ID>.<識別子>` を
--   サーバーが採番し、表示名（label）と概要（summary）をこの行が持つ。
-- - 既存の Concept への参照（is_reference = 1）: 固定の Concept（例: go.defer）か、
--   自分の他のマップのノードを元の ID のまま置く。表示名・概要は元のものを使うので持たない。
-- position はマップの中での並び（学習の順）。
CREATE TABLE learning_map_nodes (
  map_id TEXT NOT NULL REFERENCES learning_maps(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL,
  is_reference INTEGER NOT NULL CHECK (is_reference IN (0, 1)),
  label TEXT,
  summary TEXT,
  position INTEGER NOT NULL,
  PRIMARY KEY (map_id, concept_id),
  CHECK ((is_reference = 1) = (label IS NULL)),
  CHECK ((is_reference = 1) = (summary IS NULL))
);
-- 参照を解決するとき（他のマップのノードを ID で引く）に使う。
CREATE INDEX idx_learning_map_nodes_concept ON learning_map_nodes (concept_id);

-- ## learning_map_edges
--
-- 「前提（from）→ 次（to）」。どちらも同じマップのノードを指す。循環は API が拒否する。
CREATE TABLE learning_map_edges (
  map_id TEXT NOT NULL,
  from_concept_id TEXT NOT NULL,
  to_concept_id TEXT NOT NULL,
  PRIMARY KEY (map_id, from_concept_id, to_concept_id),
  FOREIGN KEY (map_id, from_concept_id)
    REFERENCES learning_map_nodes (map_id, concept_id) ON DELETE CASCADE,
  FOREIGN KEY (map_id, to_concept_id)
    REFERENCES learning_map_nodes (map_id, concept_id) ON DELETE CASCADE,
  CHECK (from_concept_id <> to_concept_id)
);

-- ## learning_objectives
--
-- Concept の「理解すること」（設計/05 #224）。手で書いた項目と AI で作った項目を
-- 同じ形で持ち、出どころを source に記録する（設計/06 #234、Web/19 #243）。
--
-- 固定の Concept の項目（今は packages/domain のモック）も、後でこの表へ移す（#245）。
-- そのため map_id は NULL を許す。マップのノードの項目だけが map_id を持ち、
-- (map_id, concept_id) でノードを CASCADE 参照する。ノード・マップを消すと項目も消える。
-- 外部キーの列のどれかが NULL の行（固定の Concept の項目）は、SQLite では参照を検査しない。
--
-- id は `<Concept ID>:<識別子>`。理解度の記録がこの ID を指すので、label を書き換えても変えない。
CREATE TABLE learning_objectives (
  id TEXT PRIMARY KEY,
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
CREATE INDEX idx_learning_objectives_concept ON learning_objectives (concept_id, position);
CREATE INDEX idx_learning_objectives_map ON learning_objectives (map_id, concept_id);
