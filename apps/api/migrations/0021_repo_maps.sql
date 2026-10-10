-- GitHub リポジトリからのドメイン知識のマップ（Issue #249 / マップ v3、2026-10-10 の決定）。
--
-- 利用者が公開リポジトリの URL を入れると、README・docs・コード・Issue から用語の候補を作り、
-- 確認して確定するとマップになる。処理は複数のリクエストに分け（取得 → 要約 → 候補）、
-- 途中の状態を repo_map_drafts に持つ。失敗しても続きから再開できる。
--
-- **ここに入るのは利用者のデータと、公開リポジトリの要約である。** 下書き・回数・AI の呼び出しの記録は
-- users(id) を ON DELETE CASCADE で参照し、退会の `DELETE FROM users` 1文で消える。
-- 要約の保管（repo_file_summaries）だけは利用者に属さない（下に理由を書く）。

-- ## repo_map_drafts
--
-- 下書き。作った時点で「月 3 マップ」に数える（repo_map_usage）。寿命は 30 日（expires_at）で、
-- 過ぎたものは読めない扱いにし、掃除で消す。確定するとマップができ、下書きは残さず消す
-- （confirmed_map_id は確定の直後に消えるまでの間だけ、二重の確定を止めるために使う）。
--
-- repo_owner / repo_name は `github.com/owner/repo` の形だけを受けた結果。
-- commit_sha は下書きを作った時点の既定ブランチの先頭で、根拠のリンクをこの SHA で固定する。
-- 材料（取得したツリー・分類・一覧・選んだファイル）は大きいので、段階ごとの JSON として
-- stage_state に置く。形は apps/api/src/repo-maps/ が持つ（版は stage_state_version）。
CREATE TABLE repo_map_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  -- 利用者が任意で指定した入力。どれも JSON 配列の文字列で、ツリーに存在するものだけを受けて保存する。
  -- 対象のフォルダ（空なら全体）、参考にしてほしいファイル（5 個まで）、Issue 番号（5 個まで）。
  target_folders TEXT NOT NULL DEFAULT '[]',
  hint_files TEXT NOT NULL DEFAULT '[]',
  hint_issues TEXT NOT NULL DEFAULT '[]',
  -- 段階。fetched: ツリーの取得と絞り込みまで / summarized: 要約まで / candidates: 候補まで。
  -- failed は段階の途中で止まったもの（failed_stage が、どこから続けるかを持つ）。
  status TEXT NOT NULL CHECK (status IN ('fetched', 'summarized', 'candidates', 'failed')),
  failed_stage TEXT CHECK (failed_stage IN ('fetch', 'summarize', 'candidates')),
  failure_code TEXT,
  stage_state TEXT NOT NULL DEFAULT '{}',
  stage_state_version INTEGER NOT NULL DEFAULT 1,
  -- 用語の候補（最大 20 個前後）と、それぞれの根拠の ID。AI には ID だけを返させ、パスは機械で戻す。
  candidates TEXT,
  -- この下書きを作り直した回数。作り直しは月の枠に数えず、1 日 5 回までを repo_map_usage で数える。
  rebuild_count INTEGER NOT NULL DEFAULT 0,
  -- 下書きの AI の合計。段ごとの内訳は repo_map_ai_calls。
  ai_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- 確定して作ったマップ。マップを消しても下書きの記録は要らないので SET NULL にする。
  confirmed_map_id TEXT REFERENCES learning_maps(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_repo_map_drafts_user ON repo_map_drafts (user_id, updated_at DESC);
-- 期限切れの掃除。
CREATE INDEX idx_repo_map_drafts_expires ON repo_map_drafts (expires_at);

-- ## repo_map_usage
--
-- 月の枠と作り直しの回数。ai_usage（0004）と同じく、利用者×暦月（UTC）に 1 行。
-- 下書きは 30 日で消えるので、月の回数は下書きの行数から数えず、ここへ足していく
-- （消えた下書きの分を数え直すと枠が戻ってしまう）。
-- 枠の値（月 3 マップ・作り直し 1 日 5 回）は docs/ai-limits.md が正本で、コードの定数が写す。
CREATE TABLE repo_map_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 暦月（UTC）。`YYYY-MM`。
  month_key TEXT NOT NULL,
  -- 当月に下書きを作った数（月の枠はこれと突き合わせる）。
  monthly_drafts INTEGER NOT NULL DEFAULT 0,
  -- daily_rebuilds がどの日のものか（UTC、`YYYY-MM-DD`）。日が変わったら 0 から数え直す。
  day_key TEXT NOT NULL,
  daily_rebuilds INTEGER NOT NULL DEFAULT 0,
  -- 当月に使ったトークン（入力 + 出力）。枠は機能ができて実測してから決める（#249）。それまでは記録だけ。
  monthly_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, month_key)
);

-- ## repo_map_ai_calls
--
-- AI の呼び出し 1 回につき 1 行。トークンの枠と、段ごとのモデルの選び方を実測で決めるための記録。
-- 本文（材料・応答）は持たない。段・モデル・トークン・結果だけ。
-- 下書きを消す（期限・退会）と一緒に消える。
CREATE TABLE repo_map_ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL REFERENCES repo_map_drafts(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('summarize', 'select', 'candidates', 'tree', 'objectives')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_repo_map_ai_calls_draft ON repo_map_ai_calls (draft_id);

-- ## repo_file_summaries
--
-- 取得したファイルの要約の保管。(リポジトリ, blob SHA) をキーに、同じ中身を 2 度要約しない
-- （作り直しは「候補を出す 1 回」で済ませる）。
--
-- **利用者に属さない。** user_id を持たず、users を参照しない（concept_checks（0009）と同じ判断）。
-- 入るのは公開リポジトリ（非公開は受けない）の中身の要約だけで、誰が頼んだかは持たない。
-- 利用者ごとに分けると、同じ公開ファイルの要約を人数分作ることになる。退会では消えない。
-- prompt_version が今と違う行は使わない（プロンプトを変えたら要約をやり直す）。
CREATE TABLE repo_file_summaries (
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  -- 要約した範囲。大きなファイルは先頭だけ取る（バイト数）。
  bytes_read INTEGER NOT NULL,
  summary TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_owner, repo_name, blob_sha)
);

-- ## learning_maps の取り込み元のリポジトリ
--
-- リポジトリから作ったマップだけが持つ。手で作ったマップ・AI で作ったマップ・取り込んだマップは NULL。
-- source_map_id（0020）は共有マップの取り込み元で、こちらは別の概念なので列を分ける。
-- repo_url: `github.com/owner/repo`。commit_sha: 根拠のリンクを固定した SHA。
ALTER TABLE learning_maps ADD COLUMN repo_url TEXT;
ALTER TABLE learning_maps ADD COLUMN repo_commit_sha TEXT;

-- ## learning_map_node_sources
--
-- ノードの根拠。確定のときに、候補の根拠（ID から機械で戻したパスと要約）を写す。
-- 木と「理解すること」を作る段（#243 の仕組み）と、作成時の確認問題（#247）に、
-- 根拠のパスと要約を渡して項目をリポジトリ固有にする。確定後は取り直しも追加の要約もしない。
-- 画面では commit_sha で固定したリンク（github.com/owner/repo/blob/<sha>/<path>）にする。
--
-- マップの持ち主のデータとして、ノード（マップ）を消すと CASCADE で消える。
CREATE TABLE learning_map_node_sources (
  map_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  -- doc: README・docs / glossary: 用語集 / code: コード / issue: Issue / schema: データの形
  kind TEXT NOT NULL CHECK (kind IN ('doc', 'glossary', 'code', 'issue', 'schema')),
  -- kind が issue のときは NULL。それ以外はリポジトリの中のパス。
  path TEXT,
  -- kind が issue のときの番号。それ以外は NULL。
  issue_number INTEGER,
  -- 要約（AI へ渡す材料）。schema は機械で抜いた名前と関係を短く書く。
  summary TEXT NOT NULL,
  PRIMARY KEY (map_id, concept_id, position),
  FOREIGN KEY (map_id, concept_id)
    REFERENCES learning_map_nodes (map_id, concept_id) ON DELETE CASCADE,
  CHECK ((kind = 'issue') = (issue_number IS NOT NULL)),
  CHECK ((kind = 'issue') = (path IS NULL))
);
