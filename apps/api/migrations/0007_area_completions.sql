-- 分野（Concept ID のプレフィックス）を全件 確認済みにした記録。
--
-- 件数だけを持たない。どの分野をいつ達成したかが要る。
-- 到達は「その時点の観測」なので、あとで Concept が増えて未達に戻っても
-- この行は消さない。消すと、達成の履歴が Concept 定義の都合で書き換わる。
--
-- user_id と language の複合主キーで、同じ分野が二重に記録されない。
-- 退会は DELETE FROM users 1文で消えること（ON DELETE CASCADE）。
CREATE TABLE area_completions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, language)
);
