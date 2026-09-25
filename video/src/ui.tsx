import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont as loadRounded } from "@remotion/google-fonts/MPLUSRounded1c";
import { loadFont as loadSerif } from "@remotion/google-fonts/SourceSerif4";
import { fontMono, fontUi, web } from "./theme";

export const fontRounded = loadRounded("normal", {
  weights: ["800"],
  subsets: ["japanese", "latin"],
  // 日本語は 119 分割で配られ、全部読むと警告が出る。ロゴの 8 文字のために
  // 分割番号を割り出すより、描画時に全部読むほうが壊れにくいので受け入れる。
  ignoreTooManyRequestsWarning: true,
}).fontFamily;
export const fontSerif = `${loadSerif("normal", { weights: ["400", "600"], subsets: ["latin"] }).fontFamily}, "Hiragino Mincho ProN", serif`;

export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

/** start から duration かけて 0→1。範囲外は切り詰める。 */
export const progress = (frame: number, start: number, duration: number, easing = easeOut) =>
  interpolate(frame, [start, start + duration], [0, 1], {
    easing,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

/** 弾む登場。1 を少し越えて戻る。 */
export const usePop = (start: number, damping = 12) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - start, fps, config: { damping, stiffness: 170, mass: 0.8 } });
};

/** 下から浮き上がって現れる。 */
export const riseIn = (
  frame: number,
  start: number,
  distance = 40,
  duration = 14,
): CSSProperties => {
  const p = progress(frame, start, duration);
  return { opacity: p, transform: `translateY(${(1 - p) * distance}px)` };
};

/** 場面全体をゆっくり寄せるカメラ。止まった画にしないための動き。 */
export const Camera = ({
  children,
  from = 1,
  to = 1.05,
  duration,
}: {
  children: ReactNode;
  from?: number;
  to?: number;
  duration: number;
}) => {
  const frame = useCurrentFrame();
  const s = interpolate(frame, [0, duration], [from, to], { easing: Easing.inOut(Easing.quad) });
  return <AbsoluteFill style={{ transform: `scale(${s})` }}>{children}</AbsoluteFill>;
};

/** 暗い地。ヘッダーと同じ #0f172a に、奥行きのための光だまりと方眼を重ねる。 */
export const DarkBackdrop = () => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(1200px 700px at 70% 30%, #1e3a5f 0%, ${web.header} 60%)`,
    }}
  >
    <AbsoluteFill
      style={{
        backgroundImage:
          "linear-gradient(rgba(148,163,184,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.07) 1px, transparent 1px)",
        backgroundSize: "64px 64px",
      }}
    />
  </AbsoluteFill>
);

/**
 * 大見出しのテロップ。1 文字ずつ下から立ち上げる。
 * lines は行ごとの文字列。2 行目は 1 行目の後に続けて出す。
 */
export const Caption = ({
  lines,
  start,
  dark = true,
  style,
  size = 76,
  accent = web.primary,
}: {
  lines: string[];
  start: number;
  dark?: boolean;
  style?: CSSProperties;
  size?: number;
  accent?: string;
}) => {
  const frame = useCurrentFrame();
  let offset = 0;
  const bar = progress(frame, start - 4, 12);
  return (
    <div style={{ position: "absolute", display: "flex", gap: 28, ...style }}>
      <div
        style={{
          width: 10,
          borderRadius: 5,
          background: accent,
          transform: `scaleY(${bar})`,
          transformOrigin: "top",
        }}
      />
      <div>
        {lines.map((line, li) => {
          const chars = [...line];
          const lineStart = start + offset;
          offset += chars.length * 0.8 + 4;
          return (
            <div
              key={li}
              style={{
                fontFamily: fontUi,
                fontWeight: 800,
                fontSize: size,
                lineHeight: 1.3,
                letterSpacing: "0.02em",
                color: dark ? "#fff" : web.header,
                whiteSpace: "nowrap",
                overflow: "hidden",
                paddingBottom: 6,
              }}
            >
              {chars.map((c, i) => {
                const p = progress(frame, lineStart + i * 0.8, 12);
                return (
                  <span
                    key={i}
                    style={{
                      display: "inline-block",
                      opacity: p,
                      transform: `translateY(${(1 - p) * size * 0.7}px)`,
                    }}
                  >
                    {c}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/** 小さなラベル（どの環境の画面かを示す）。 */
export const Tag = ({
  children,
  start,
  style,
  dark = true,
}: {
  children: ReactNode;
  start: number;
  style?: CSSProperties;
  dark?: boolean;
}) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        fontFamily: fontUi,
        fontWeight: 700,
        fontSize: 26,
        letterSpacing: "0.12em",
        padding: "10px 22px",
        borderRadius: 999,
        color: dark ? web.headerText : web.chipText,
        background: dark ? "rgba(148,163,184,0.16)" : web.chip,
        ...riseIn(frame, start, 20),
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/**
 * キーキャップ。pressAt で沈み、release まで押されたまま光る。
 * 組み合わせキーは前のキーを押したまま次を押すので、release は全キーで揃える。
 */
export const Keycap = ({
  label,
  pressAt,
  release,
  wide = false,
}: {
  label: string;
  pressAt: number;
  release: number;
  wide?: boolean;
}) => {
  const frame = useCurrentFrame();
  const down = frame >= pressAt && frame < release;
  const press = progress(frame, pressAt, 4) * (1 - progress(frame, release, 6));
  const bounce = usePop(pressAt, 9);
  return (
    <div
      style={{
        width: wide ? 200 : 132,
        height: 132,
        borderRadius: 26,
        background: down ? web.primary : "#f8fafc",
        color: down ? "#fff" : web.header,
        boxShadow: `0 ${14 - press * 10}px 0 ${down ? "#115e59" : "#94a3b8"}, 0 ${30 - press * 16}px 50px rgba(2,6,23,0.45)`,
        transform: `translateY(${press * 10}px) scale(${1 + (down ? (1 - bounce) * 0.1 : 0)})`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: fontUi,
        fontWeight: 700,
        fontSize: 64,
      }}
    >
      {label === "⇧" ? <ShiftGlyph size={60} /> : label}
    </div>
  );
};

/** ⇧ の字形。Hiragino では細い矢印に化けるので、形を自前で描く。 */
const ShiftGlyph = ({ size }: { size: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.2}
    strokeLinejoin="round"
  >
    <path d="M12 3 L21 12 H16 V20 H8 V12 H3 Z" />
  </svg>
);

/** タグの中のショートカット表記。⇧ を等幅書体で描き、字形の化けを避ける。 */
export const Shortcut = ({ children }: { children: string }) => (
  <span style={{ fontFamily: fontMono, letterSpacing: "0.08em" }}>{children}</span>
);

export const KeyCombo = ({
  keys,
  pressAt,
  release,
}: {
  keys: string[];
  pressAt: number[];
  release: number;
}) => {
  const frame = useCurrentFrame();
  const appear = progress(frame, pressAt[0] - 10, 10);
  const leave = progress(frame, release, 10, easeInOut);
  return (
    <div
      style={{
        display: "flex",
        gap: 28,
        alignItems: "center",
        opacity: appear * (1 - leave),
        transform: `translateY(${(1 - appear) * 40 + leave * 30}px) scale(${1 - leave * 0.1})`,
      }}
    >
      {keys.map((k, i) => (
        <div key={k} style={{ display: "flex", alignItems: "center", gap: 28 }}>
          {i > 0 && (
            <span style={{ color: "#94a3b8", fontSize: 56, fontFamily: fontUi, fontWeight: 300 }}>
              +
            </span>
          )}
          <Keycap label={k} pressAt={pressAt[i]} release={release} />
        </div>
      ))}
    </div>
  );
};

/** 文字を 1 つずつ流す（AI の回答のストリーミング表示）。 */
export const streamed = (text: string, frame: number, start: number, charsPerFrame: number) => {
  const n = Math.max(0, Math.floor((frame - start) * charsPerFrame));
  return [...text].slice(0, n).join("");
};

/** 数字のカウントアップ。 */
export const countUp = (frame: number, start: number, duration: number, to: number) =>
  Math.round(to * progress(frame, start, duration, Easing.out(Easing.cubic)));

/** 場面の頭で一瞬光らせ、切り替えを拍に乗せる。 */
export const Flash = ({ color = "#fff", duration = 8 }: { color?: string; duration?: number }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, duration], [0.5, 0], { extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ background: color, opacity: o, pointerEvents: "none" }} />;
};
