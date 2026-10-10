// 発表（プレゼン 5 分のうち、デモを除いた 3 分）の裏で流す映像の割り付け。
// 台本は PITCH.md。話す速さに合わせて場面の長さを決めてあり、読み上げ音声は付けない
// （発表者が台本を読む）。場面の長さや出す瞬間を変えるときはこのファイルだけを直す。

import { SCENES } from "../timeline";

export const PITCH_FPS = 30;
const sec = (s: number) => Math.round(s * PITCH_FPS);

/**
 * 場面の割り付け。審査員はローンチ動画を見ている前提なので、概要はおさらいだけにする。
 * おさらいの 2 場面はローンチ動画（src/scenes）を流用する。「どこからでも」は
 * 中の動きが 2 秒で済み、残りは記録が流れ込み続ける絵なので延ばしてよい。
 * 学習マップはノードが灯って現在地が光るところ（約 4 秒）までで切る。
 */
const ORDER = [
  ["everywhere", sec(8)],
  ["map", sec(5)],
  ["section", sec(5)],
  ["importDemo", sec(60)],
  ["repoMap", sec(40)],
  ["share", sec(14)],
  ["logo", SCENES.logo.duration],
] as const;

export type PitchSceneKey = (typeof ORDER)[number][0];

export const PITCH_SCENES = (() => {
  let from = 0;
  const out = {} as Record<PitchSceneKey, { from: number; duration: number }>;
  for (const [key, duration] of ORDER) {
    out[key] = { from, duration };
    from += duration;
  }
  return out;
})();

export const PITCH_DURATION = ORDER.reduce((sum, [, d]) => sum + d, 0);

// ---- 場面の中の拍（場面からの相対フレーム）。台本の段落の頭と揃えてある ----

/** ① AI の履歴から地図を作る（デモ） */
export const IMPORT = {
  /** 「履歴から地図を作る」を押す */
  open: sec(8.5),
  /** 見つかった履歴が 1 行ずつ出る */
  sources: [sec(10), sec(10.6), sec(11.2)],
  /** エクスポートファイルを選ぶ */
  pickFile: sec(14.5),
  analyzers: sec(16),
  /** 「Learning Map を作る」を押す */
  run: sec(19),
  /** 読み解きの進み具合。この区間でバーが満ちる */
  analyze: { from: sec(19.5), to: sec(33) },
  result: sec(34),
  /** 候補を 1 つ外す */
  uncheck: sec(38),
  /** 「地図に適用」を押す */
  apply: sec(40),
  /** Web のマップへ切り替わる */
  map: sec(41),
  /** 「履歴あり」の印が付き始める */
  chips: sec(42.5),
  /** 確認問題に正解して、1 つが確認済みに変わる */
  confirm: sec(51),
  undo: sec(56),
};

/** 右の欄に積み上げる要点。台本の「工夫」の段落ごとに 1 つ */
export const IMPORT_POINTS = [
  { start: sec(1), text: "使い始めは、地図が真っ白", sub: "これまで AI に聞いたことが活かせない" },
  {
    start: IMPORT.sources[0],
    text: "この PC の履歴を自動で見つける",
    sub: "Claude Code・Codex・VS Code・エクスポート",
  },
  {
    start: sec(20),
    text: "本文は端末の中で処理",
    sub: "メール・トークン・パスは先に除去",
  },
  {
    start: sec(25.5),
    text: "まずルール、残りだけ AI",
    sub: "AI は自分の Claude／Codex CLI でも",
  },
  {
    start: sec(30),
    text: "送るのは「触れた概念」だけ",
    sub: "会話の本文はサーバーに残さない",
  },
  { start: IMPORT.result, text: "送る前に確認して外せる", sub: "取り込みはあとから取り消せる" },
  {
    start: IMPORT.chips + sec(2),
    text: "「触れた」と「理解した」を分ける",
    sub: "履歴だけでは理解度を上げない",
  },
];

/** ② GitHub リポジトリから地図を作る（開発中） */
export const REPO = {
  /** URL を打ち始める */
  type: sec(2),
  submit: sec(7.5),
  /** 機械で分類・絞り込む様子 */
  classify: sec(8.5),
  /** AI に渡すものに絞られる */
  narrow: sec(15),
  /** 用語の候補（下書き）の画面 */
  candidates: sec(21),
  /** 関係ない候補を却下する（モノレポに混ざった別アプリの用語） */
  reject: sec(27.5),
  /** 実測の数字 */
  stats: sec(32),
};

export const REPO_POINTS = [
  { start: 0, text: "プロジェクトの言葉を学ぶ地図", sub: "例: 注文 → 決済 → 配送のつながり" },
  {
    start: REPO.classify,
    text: "まず機械で振り分ける",
    sub: "名前と場所だけ。中身は読まない",
  },
  {
    start: REPO.narrow,
    text: "AI には要約だけ渡す",
    sub: "README・docs／コード 5 個／Issue 5 件",
  },
  {
    start: REPO.candidates,
    text: "AI は候補まで、確定は作成者",
    sub: "用語ごとに根拠へリンク",
  },
  {
    start: REPO.stats,
    text: "1 マップ 約 1 万トークン",
    sub: "公開リポジトリ 4 つで実測・約 $0.01",
  },
];

/** 共有 */
export const SHARE = {
  cards: [sec(1), sec(1.4), sec(1.8)],
  take: sec(6),
  copy: sec(9),
};
