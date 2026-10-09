-- 学習マップの共有と版（Issue #244 / Web/20、2026-10-09 の決定 S1-a・T1-a・T2・T5）。
--
-- 持ち主の手元のマップ（learning_maps とその下の表）と、共有の版を分ける。
-- 持ち主が手元を直しても共有の側は変わらず、「共有へ上げる」でその時点の中身を
-- 新しい版として learning_map_versions に残す。持ち主以外は、いちばん新しい版を読む。

-- ## learning_maps.share_scope
--
-- 共有の範囲。NULL は非公開（持ち主だけ）。link は「リンクを知っている人だけ」、
-- public は「全員（共有マップの一覧に出す）」。
-- 0013 の visibility（private / shared）は残し、share_scope が NULL でなければ shared にそろえる。
-- 列の CHECK は ALTER TABLE で足せないので、そろえるのは書く側（repository/d1.ts）の責務。
-- 共有をやめても版は残す（再び共有したら続きの番号になる）。
ALTER TABLE learning_maps ADD COLUMN share_scope TEXT CHECK (share_scope IN ('link', 'public'));

-- 全員の一覧（public）を引く。
CREATE INDEX idx_learning_maps_share_scope ON learning_maps (share_scope)
  WHERE share_scope IS NOT NULL;

-- ## learning_map_versions
--
-- 共有の版。版番号はマップごとに 1 から振る。行は書き換えず、足すだけにする
-- （復元は過去の版の中身で新しい版を作る。履歴は書き換えない）。
--
-- content: 上げた時点の中身の JSON（src/maps/snapshot.ts の MapSnapshot）。
--   ノード・線・「理解すること」と、共有に含めた作成時の確認問題を持つ。
--   作成者の別のマップを指す参照のノードは、元の表示名・概要・項目を写して持つ
--   （持ち主以外からは元のマップが見えないため）。
-- content_hash: content の SHA-256（16進）。確認画面で見せた中身と、上げる中身が同じかを確かめる。
-- author_user_id: 上げた人。今は持ち主だけが上げるが、「誰が」を残すために持つ。
--   マップが消えれば版も消えるので、users を参照しない。
-- restored_from: 復元で作った版なら、元の版番号。
-- checks_included: 作成時の確認問題を共有に含めたか（S1-a、マップ単位で選ぶ）。
-- summary: 前の版からの変更の要約の JSON（足した・消した・変えたノードの数など）。
--
-- **ここに入るのは持ち主の利用者のデータである。** マップの CASCADE で、
-- マップを消す・退会すると版も消える。取り込んだ人の個人マップ（#244 の次の PR）は残る。
CREATE TABLE learning_map_versions (
  map_id TEXT NOT NULL REFERENCES learning_maps(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  restored_from INTEGER,
  checks_included INTEGER NOT NULL CHECK (checks_included IN (0, 1)),
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (map_id, version)
);
