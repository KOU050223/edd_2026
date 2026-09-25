// 映像と音の両方がこのファイルを読む。拍と効果音の位置をここ 1 か所で決めるので、
// 片方だけずれることがない。scripts/make-audio.ts は Node の型除去で直接読み込むため、
// 型注釈以外の TypeScript 固有構文（enum など）は使わない。

export const FPS = 30;
export const BPM = 120;
/** 1 拍のフレーム数（120 BPM / 30fps で 15） */
export const BEAT = (FPS * 60) / BPM;
export const BAR = BEAT * 4;
export const DURATION = BAR * 15; // 30 秒

export const WIDTH = 1920;
export const HEIGHT = 1080;

/** 各場面の開始フレームと長さ。切り替えはすべて小節頭。 */
export const SCENES = {
  hook: { from: 0, duration: BAR * 2 },
  vscode: { from: BAR * 2, duration: BAR * 3 },
  desktop: { from: BAR * 5, duration: BAR * 2 },
  everywhere: { from: BAR * 7, duration: BAR },
  history: { from: BAR * 8, duration: BAR * 3 },
  map: { from: BAR * 11, duration: BAR * 2 },
  logo: { from: BAR * 13, duration: BAR * 2 },
} as const;

/** 場面の中での拍。`beatIn("vscode", 3)` は vscode の 4 拍目の絶対フレーム。 */
export const beatIn = (scene: keyof typeof SCENES, beat: number): number =>
  SCENES[scene].from + beat * BEAT;

// ---- 場面の中で使う拍（場面からの相対フレーム）。映像側はこれを参照する ----

export const VSCODE = {
  select: BEAT * 1,
  keys: [BEAT * 3, BEAT * 4, BEAT * 5],
  panel: BEAT * 6,
  stream: BEAT * 7,
};

export const DESKTOP = {
  keys: [BEAT * 2, BEAT * 3, BEAT * 4],
  popup: BEAT * 5,
};

export const EVERYWHERE = {
  cards: [0, BEAT / 2, BEAT],
  link: BEAT * 2,
};

export const HISTORY = {
  questions: [BEAT * 1, BEAT * 2, BEAT * 3, BEAT * 4, BEAT * 5, BEAT * 6],
  chart: BEAT * 2,
  counters: BEAT * 4,
};

export const MAP = {
  /** ノードが灯る拍。並びは scenes/Map.tsx の NODES の点灯順と一致させる */
  lights: [BEAT * 1, BEAT * 1.5, BEAT * 2, BEAT * 2.5, BEAT * 3, BEAT * 3.5, BEAT * 4],
  current: BEAT * 5,
  next: BEAT * 6,
};

export const LOGO = {
  icon: 0,
  title: BEAT * 1,
  copy: BEAT * 3,
  url: BEAT * 5,
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

const at = (scene: keyof typeof SCENES, rel: number) => SCENES[scene].from + rel;

export const SFX: Sfx[] = [
  // 1. 導入: 波線が走る瞬間と、次の場面へのライザー
  { frame: 45, kind: "tick", gain: 0.6 },
  { frame: BAR, kind: "riser", length: BAR },

  // 2. VS Code
  { frame: at("vscode", VSCODE.select), kind: "whoosh", gain: 0.35 },
  ...VSCODE.keys.map((k, i) => ({ frame: at("vscode", k), kind: "click" as const, pitch: i * 2 })),
  { frame: at("vscode", VSCODE.panel), kind: "whoosh", gain: 0.7 },
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({
    frame: at("vscode", VSCODE.stream + i * (BEAT / 2)),
    kind: "tick" as const,
    gain: 0.18,
  })),

  // 3. デスクトップ
  { frame: at("desktop", 0), kind: "whoosh", gain: 0.5 },
  ...DESKTOP.keys.map((k, i) => ({
    frame: at("desktop", k),
    kind: "click" as const,
    pitch: i * 2,
  })),
  { frame: at("desktop", DESKTOP.popup), kind: "pop", pitch: 7, gain: 0.9 },

  // 4. どこからでも
  { frame: at("everywhere", 0), kind: "hit" },
  ...EVERYWHERE.cards.map((c, i) => ({
    frame: at("everywhere", c),
    kind: "pop" as const,
    pitch: i * 4,
  })),
  { frame: at("everywhere", EVERYWHERE.link), kind: "chime", pitch: 12 },

  // 5. 履歴
  { frame: at("history", 0), kind: "whoosh", gain: 0.6 },
  ...HISTORY.questions.map((q, i) => ({ frame: at("history", q), kind: "pop" as const, pitch: i })),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
    frame: at("history", HISTORY.counters + i * (BEAT / 2)),
    kind: "tick" as const,
    gain: 0.25,
  })),

  // 6. 学習マップ
  { frame: at("map", 0), kind: "whoosh", gain: 0.6 },
  ...MAP.lights.map((l, i) => ({
    frame: at("map", l),
    kind: "chime" as const,
    pitch: [0, 2, 4, 5, 7, 9, 11][i],
  })),
  { frame: at("map", MAP.current), kind: "hit", gain: 0.8 },
  { frame: at("map", MAP.current), kind: "chime", pitch: 12 },
  { frame: at("map", MAP.next), kind: "whoosh", gain: 0.35 },

  // 7. ロゴ
  { frame: at("logo", LOGO.icon), kind: "hit", gain: 1 },
  { frame: at("logo", LOGO.title), kind: "chime", pitch: 16 },
  { frame: at("logo", LOGO.copy), kind: "chime", pitch: 19, gain: 0.6 },
];
