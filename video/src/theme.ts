// 実サイトとアプリの CSS から抜き出したトークン。値を変えるときは出典の CSS と揃えること。

/** Web（apps/web/src/client/style.css） */
export const web = {
  ink: "#1f2937",
  bg: "#f8fafc",
  surface: "#ffffff",
  header: "#0f172a",
  headerText: "#e2e8f0",
  primary: "#0f766e",
  chip: "#e2e8f0",
  chipText: "#334155",
  muted: "#64748b",
  border: "#e2e8f0",
  track: "#f1f5f9",
  confirmed: "#10b981",
  confirmedBg: "#ecfdf5",
  confirmedText: "#047857",
  learning: "#f59e0b",
  learningBg: "#fff7ed",
  learningText: "#b45309",
  unobservedBg: "#f1f5f9",
  unobservedBorder: "#cbd5e1",
  current: "#2563eb",
  currentBorder: "#1d4ed8",
  currentRing: "#bfdbfe",
  edgeDone: "#6ee7b7",
  solved: "#14b8a6",
  hint: "#f59e0b",
  recurred: "#ef4444",
  hintBg: "#eff6ff",
  hintText: "#1e3a8a",
} as const;

/** Desktop（apps/desktop/src/renderer/style.css の Broadsheet トークン） */
export const desk = {
  bg: "#f3f2f2",
  surface: "#eae9e9",
  text: "#201e1d",
  accent: "#0088b0",
  accent100: "#e9f8ff",
  accent700: "#006786",
  accent800: "#004961",
  neutral100: "#f8f4f4",
  neutral400: "#bab6b6",
  neutral700: "#605d5d",
  learning: "#ff90b1",
  divider: "rgba(32, 30, 29, 0.16)",
  shadowLg: "0 12px 32px rgba(45, 43, 43, 0.22)",
} as const;

/** ロゴの配色（assets/icons のアイコンから採色） */
export const brand = {
  navy: "#16264f",
  blue: "#1e88e5",
  green: "#22c58b",
  orange: "#f7a23b",
  slate: "#6b7a99",
} as const;

// Web は system-ui。macOS で描画すると日本語は Hiragino になるので、それを明示する。
export const fontUi = `"Hiragino Sans", "Hiragino Kaku Gothic ProN", system-ui, sans-serif`;
export const fontMono = `"SF Mono", Menlo, ui-monospace, monospace`;
