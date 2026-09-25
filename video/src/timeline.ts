// 映像と音の両方がこのファイルを読む。拍と効果音の位置をここ 1 か所で決めるので、
// 片方だけずれることがない。scripts/make-audio.ts は Node の型除去で直接読み込むため、
// 型注釈以外の TypeScript 固有構文（enum など）は使わない。

export const FPS = 30;
export const BPM = 120;
/** 1 拍のフレーム数（120 BPM / 30fps で 15） */
export const BEAT = (FPS * 60) / BPM;
export const BAR = BEAT * 4;
export const DURATION = BAR * 31; // 62 秒

export const WIDTH = 1920;
export const HEIGHT = 1080;

/**
 * 各場面の開始フレームと長さ。切り替えはすべて小節頭。
 * 30 秒版では説明が一瞬で流れて伝わらなかったので、各場面に「補足の一文」を
 * 読み切れるだけの小節を割り当てている（補足 1 つにつき 3〜4 秒が目安）。
 */
export const SCENES = {
  hook: { from: 0, duration: BAR * 3 },
  vscode: { from: BAR * 3, duration: BAR * 6 },
  desktop: { from: BAR * 9, duration: BAR * 5 },
  everywhere: { from: BAR * 14, duration: BAR * 2 },
  history: { from: BAR * 16, duration: BAR * 6 },
  map: { from: BAR * 22, duration: BAR * 6 },
  logo: { from: BAR * 28, duration: BAR * 3 },
} as const;

export type SceneKey = keyof typeof SCENES;

/** 場面の頭が何小節目か（音の譜面が使う） */
export const barOf = (scene: SceneKey): number => SCENES[scene].from / BAR;

// ---- 場面の中で使う拍（場面からの相対フレーム）。映像側はこれを参照する ----

export const HOOK = {
  squiggle: 36,
  error: 45,
  /** 調べ物でエディタを離れる様子のカード */
  detours: [BEAT * 6, BEAT * 7, BEAT * 8],
};

export const VSCODE = {
  select: BEAT * 2,
  keys: [BEAT * 6, BEAT * 7, BEAT * 8],
  panel: BEAT * 9,
  stream: BEAT * 10,
  /** 「学習の記録に追加しました」を出す拍。補足④と揃える */
  recorded: BEAT * 18,
  /** 回答を流す速さ（文字/フレーム）。読める速さに落としてある */
  cps: 1,
};

export const DESKTOP = {
  select: 20,
  keys: [BEAT * 3, BEAT * 4, BEAT * 5],
  popup: BEAT * 6,
  stream: BEAT * 6 + 10,
  cps: 1.2,
  /** 左の概念一覧へ注目させる拍 */
  sidebar: BEAT * 13 + 5,
};

export const EVERYWHERE = {
  cards: [0, BEAT / 2, BEAT],
  link: BEAT * 2,
};

export const HISTORY = {
  questions: [BEAT * 1, BEAT * 2, BEAT * 3, BEAT * 4, BEAT * 5, BEAT * 6],
  chart: BEAT * 9,
  counters: BEAT * 15,
  /** 注目する部分を切り替える拍。この間は他の部分を薄くする */
  focus: [
    { from: BEAT * 1, to: BEAT * 9, target: "feed" },
    { from: BEAT * 9, to: BEAT * 15, target: "chart" },
    { from: BEAT * 15, to: BEAT * 21, target: "tiles" },
  ],
};

export const MAP = {
  /** ノードが灯る拍。並びは scenes/LearningMap.tsx の NODES の点灯順と一致させる */
  lights: [0, 1, 2, 3, 4, 5, 6].map((i) => BEAT * 2 + (i * BEAT) / 2),
  current: BEAT * 7,
  next: BEAT * 16,
  /** 次に学ぶ候補へ注目させる区間 */
  focusNext: { from: BEAT * 16, to: BEAT * 22 },
};

export const LOGO = {
  icon: 0,
  title: BEAT * 1,
  copy: BEAT * 3,
  url: BEAT * 5,
};

/** 大見出しの下に出す補足。start は場面からの相対フレーム。 */
export type Note = { start: number; text: string };

export const NOTES: Record<SceneKey, Note[]> = {
  hook: [{ start: BEAT * 6, text: "調べるたびにエディタを離れて、集中が途切れる。" }],
  vscode: [
    { start: VSCODE.select, text: "① 気になるコードを選ぶ" },
    {
      start: VSCODE.keys[0],
      text: "② ⌘⇧J を押す。選んだコードとエラーが、そのまま質問に添えられる",
    },
    { start: BEAT * 12, text: "③ 返ってくるのは答えではなく、ヒントと「次に試す一手」" },
    { start: VSCODE.recorded, text: "④ やりとりは、学習の記録として自動で残る" },
  ],
  desktop: [
    { start: DESKTOP.select, text: "① ブラウザでもターミナルでも、文字を選んで ⌘⇧K" },
    { start: DESKTOP.popup + 20, text: "② 選んだテキストを常駐アプリが拾い、そのまま質問できる" },
    { start: DESKTOP.sidebar, text: "③ 左には、いま学んでいる概念の一覧" },
  ],
  everywhere: [{ start: BEAT * 3, text: "どの入口から聞いても、記録は 1 つにまとまる。" }],
  history: [
    { start: BEAT * 2, text: "① どの環境で聞いた質問も、1 か所に並ぶ" },
    { start: BEAT * 9, text: "② 日ごとの推移。緑の「自力解決」が少しずつ増えていく" },
    { start: BEAT * 15, text: "③ 記録のために書くことは何もない。聞けば、残る" },
  ],
  map: [
    { start: BEAT * 2, text: "① 聞いた内容から、理解した概念を地図に記していく" },
    { start: BEAT * 9, text: "② 緑は確認済み、橙は学習中。青がいまの現在地" },
    { start: BEAT * 16, text: "③ 破線の先が、次に学ぶ候補" },
  ],
  logo: [],
};

export type SfxKind = "click" | "whoosh" | "pop" | "chime" | "hit" | "riser" | "tick";

export type Sfx = {
  frame: number;
  kind: SfxKind;
  /** chime の音高（半音）。pop / click の変化にも使う */
  pitch?: number;
  gain?: number;
  /** riser の長さ（フレーム） */
  length?: number;
};

const at = (scene: SceneKey, rel: number) => SCENES[scene].from + rel;
const ticks = (scene: SceneKey, from: number, count: number, gain: number): Sfx[] =>
  Array.from({ length: count }, (_, i) => ({
    frame: at(scene, from + i * (BEAT / 2)),
    kind: "tick",
    gain,
  }));
// 補足が切り替わる瞬間に小さく鳴らし、目線を字幕へ誘う
const noteCues = (scene: SceneKey): Sfx[] =>
  NOTES[scene].map((n) => ({ frame: at(scene, n.start), kind: "pop", pitch: 12, gain: 0.25 }));

export const SFX: Sfx[] = [
  // 1. 導入: 波線が走る瞬間、調べ物のカード、次の場面へのライザー
  { frame: HOOK.error, kind: "tick", gain: 0.6 },
  ...HOOK.detours.map((d, i) => ({ frame: d, kind: "pop" as const, pitch: -5 + i * 2, gain: 0.5 })),
  { frame: BAR * 2, kind: "riser", length: BAR },

  // 2. VS Code
  { frame: at("vscode", VSCODE.select), kind: "whoosh", gain: 0.35 },
  ...VSCODE.keys.map((k, i) => ({ frame: at("vscode", k), kind: "click" as const, pitch: i * 2 })),
  { frame: at("vscode", VSCODE.panel), kind: "whoosh", gain: 0.7 },
  ...ticks("vscode", VSCODE.stream, 12, 0.15),
  ...noteCues("vscode"),

  // 3. デスクトップ
  { frame: at("desktop", 0), kind: "whoosh", gain: 0.5 },
  ...DESKTOP.keys.map((k, i) => ({
    frame: at("desktop", k),
    kind: "click" as const,
    pitch: i * 2,
  })),
  { frame: at("desktop", DESKTOP.popup), kind: "pop", pitch: 7, gain: 0.9 },
  ...ticks("desktop", DESKTOP.stream, 8, 0.15),
  ...noteCues("desktop"),

  // 4. どこからでも
  { frame: at("everywhere", 0), kind: "hit" },
  ...EVERYWHERE.cards.map((c, i) => ({
    frame: at("everywhere", c),
    kind: "pop" as const,
    pitch: i * 4,
  })),
  { frame: at("everywhere", EVERYWHERE.link), kind: "chime", pitch: 12 },
  ...noteCues("everywhere"),

  // 5. 履歴
  { frame: at("history", 0), kind: "whoosh", gain: 0.6 },
  ...HISTORY.questions.map((q, i) => ({ frame: at("history", q), kind: "pop" as const, pitch: i })),
  { frame: at("history", HISTORY.chart), kind: "whoosh", gain: 0.4 },
  ...ticks("history", HISTORY.counters, 8, 0.25),
  ...noteCues("history"),

  // 6. 学習マップ
  { frame: at("map", 0), kind: "whoosh", gain: 0.6 },
  ...MAP.lights.map((l, i) => ({
    frame: at("map", l),
    kind: "chime" as const,
    pitch: [0, 2, 4, 5, 7, 9, 11][i],
  })),
  { frame: at("map", MAP.current), kind: "hit", gain: 0.8 },
  { frame: at("map", MAP.current), kind: "chime", pitch: 12 },
  { frame: at("map", MAP.next), kind: "whoosh", gain: 0.4 },
  { frame: at("map", MAP.next + BEAT), kind: "chime", pitch: 14, gain: 0.6 },
  ...noteCues("map"),

  // 7. ロゴ
  { frame: at("logo", LOGO.icon), kind: "hit", gain: 1 },
  { frame: at("logo", LOGO.title), kind: "chime", pitch: 16 },
  { frame: at("logo", LOGO.copy), kind: "chime", pitch: 19, gain: 0.6 },
];
