-- 学習マップの AI 生成（Web/19 #243）。
--
-- ## map_generation_consents
--
-- 学習マップの AI 生成で、テーマ・目標と本人の理解度を AI へ送ることへの同意のうち、
-- 「今後表示しない」を選んだ記録。確認問題の同意（check_generation_consents）と同じ形で、
-- 送るものが違うので表と版を分ける（packages/domain の MAP_GENERATION_CONSENT_VERSION）。
-- 版が今と違う記録は同意として扱わない。取り消すと行を消す。退会では users と一緒に消える。
CREATE TABLE map_generation_consents (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  granted_at TEXT NOT NULL
);
