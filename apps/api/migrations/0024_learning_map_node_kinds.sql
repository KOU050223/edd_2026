-- リポジトリから作ったマップのノードの「種類」（#322）。画面の色分けと凡例に使う。
-- 種類を付けたノードだけが行を持つ（種類なし・手で作るマップ・言語別マップには行が無い）。
-- 共有の版（learning_map_versions）には入れない。根拠（learning_map_node_sources）と同じ扱い。
--
-- 値は contract/repo-maps.ts の REPO_MAP_NODE_KINDS と同じにする。

CREATE TABLE learning_map_node_kinds (
  map_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('core', 'event', 'state', 'record', 'system')),
  PRIMARY KEY (map_id, concept_id),
  FOREIGN KEY (map_id, concept_id)
    REFERENCES learning_map_nodes (map_id, concept_id) ON DELETE CASCADE
);
