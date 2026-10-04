-- 学習イベントが触れた「理解すること」（LearningObjective）の ID（設計/04 #223）。
--
-- ObjectiveId の配列を JSON 文字列で持つ。concept_ids と同じ流儀。
-- NULL は「項目の情報を持たないイベント」で、空配列とは区別する。
-- 0011 より前のイベントはすべて NULL になり、項目ごとの理解度の計算には使わない
-- （記録としては残す）。docs/concepts.md「項目ごとの理解度」を参照。
ALTER TABLE learning_events ADD COLUMN objective_ids TEXT;
