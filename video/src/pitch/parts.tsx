import type { CSSProperties, ReactNode } from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { desk, fontUi, web } from "../theme";
import { easeInOut, easeOut, fontSerif, progress, riseIn } from "../ui";

/** マウスカーソルの経路の 1 点。at のフレームでそこに着き、click なら押す。 */
export type CursorStop = { at: number; x: number; y: number; click?: boolean };

/**
 * デモ操作のカーソル。stops の間を滑らかに動き、click の点で波紋を出す。
 * 最初の点より前と、hideAt 以降は描かない。
 */
export const Cursor = ({ stops, hideAt = Infinity }: { stops: CursorStop[]; hideAt?: number }) => {
  const frame = useCurrentFrame();
  if (stops.length === 0 || frame < stops[0].at - 10 || frame >= hideAt) return null;
  // 次の点へは、その点の到着より 18 フレーム前から動き出す
  let x = stops[0].x;
  let y = stops[0].y;
  for (let i = 1; i < stops.length; i++) {
    const p = progress(frame, stops[i].at - 18, 18, easeInOut);
    x += (stops[i].x - stops[i - 1].x) * p;
    y += (stops[i].y - stops[i - 1].y) * p;
  }
  const appear = progress(frame, stops[0].at - 10, 8);
  const clicks = stops.filter((s) => s.click);
  const press = clicks.reduce((m, s) => Math.max(m, frame >= s.at && frame < s.at + 6 ? 1 : 0), 0);
  return (
    <>
      {clicks.map((s) => {
        const r = progress(frame, s.at, 16);
        if (frame < s.at || r >= 1) return null;
        return (
          <span
            key={s.at}
            style={{
              position: "absolute",
              left: s.x - 34 * r,
              top: s.y - 34 * r,
              width: 68 * r,
              height: 68 * r,
              borderRadius: "50%",
              border: "4px solid #2dd4bf",
              opacity: 1 - r,
            }}
          />
        );
      })}
      <svg
        width={40}
        height={48}
        viewBox="0 0 20 24"
        style={{
          position: "absolute",
          left: x - 4,
          top: y - 2,
          opacity: appear,
          transform: `scale(${1 - press * 0.15})`,
          transformOrigin: "4px 2px",
          filter: "drop-shadow(0 4px 6px rgba(2,6,23,0.45))",
        }}
      >
        <path
          d="M2 1 L2 19 L7 14.5 L10.5 22 L13.5 20.6 L10 13.3 L16.5 13.3 Z"
          fill="#fff"
          stroke="#0f172a"
          strokeWidth={1.4}
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
};

const MAX_POINTS = 4;

/**
 * 右の欄に積み上げる要点。新しいものほど強く、古いものは薄く残す。
 * 話している段落がどれかを、聞き手が目で追えるようにする。
 */
export const Points = ({
  points,
  style,
}: {
  points: { start: number; text: string; sub?: string }[];
  style?: CSSProperties;
}) => {
  const frame = useCurrentFrame();
  // 縦に収まる数だけ残し、古いものから押し出す
  const all = points.filter((p) => frame >= p.start);
  const shown = all.slice(-MAX_POINTS);
  const latest = shown.length - 1;
  return (
    <div
      style={{
        position: "absolute",
        display: "flex",
        flexDirection: "column",
        gap: 22,
        fontFamily: fontUi,
        ...style,
      }}
    >
      {shown.map((p, i) => {
        const active = i === latest;
        const fade = active ? 0 : progress(frame, shown[i + 1].start, 12, easeInOut);
        return (
          <div
            key={p.start}
            style={{
              display: "flex",
              gap: 18,
              alignItems: "flex-start",
              opacity: 1 - fade * 0.55,
              ...riseIn(frame, p.start, 24),
            }}
          >
            <span
              style={{
                flex: "none",
                marginTop: 6,
                width: 30,
                height: 30,
                borderRadius: 15,
                background: active ? "#2dd4bf" : "rgba(148,163,184,0.35)",
                color: web.header,
                fontWeight: 800,
                fontSize: 18,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ✓
            </span>
            <div>
              <div
                style={{
                  color: "#fff",
                  fontWeight: 800,
                  fontSize: 34,
                  lineHeight: 1.35,
                  whiteSpace: "nowrap",
                }}
              >
                {p.text}
              </div>
              {p.sub && (
                <div
                  style={{
                    color: "#94a3b8",
                    fontWeight: 600,
                    fontSize: 23,
                    marginTop: 4,
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.sub}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** Desktop 版のウィンドウ枠（apps/desktop/src/renderer の Broadsheet）。 */
export const DeskWindow = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <div
    style={{
      position: "absolute",
      borderRadius: 18,
      overflow: "hidden",
      background: desk.bg,
      color: desk.text,
      boxShadow: "0 40px 90px rgba(2,6,23,0.6)",
      display: "flex",
      flexDirection: "column",
      ...style,
    }}
  >
    <div
      style={{
        height: 60,
        flex: "none",
        display: "flex",
        alignItems: "baseline",
        gap: 16,
        padding: "16px 28px 0",
        borderBottom: `1px solid ${desk.divider}`,
      }}
    >
      <span style={{ fontFamily: fontSerif, fontWeight: 600, fontSize: 26 }}>学習装置</span>
      <span style={{ fontFamily: fontSerif, fontSize: 19, color: desk.accent700 }}>
        Gakushu Sochi
      </span>
    </div>
    <div style={{ flex: 1, position: "relative", minHeight: 0 }}>{children}</div>
  </div>
);

/** 画面の外枠ごと差し替えるときのクロスフェード量（0→1）。 */
export const crossfade = (frame: number, at: number, duration = 12) =>
  interpolate(frame, [at, at + duration], [0, 1], {
    easing: easeOut,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

/** チェックボックス（Desktop の input[type=checkbox]）。 */
export const Check = ({ on, color = desk.accent }: { on: boolean; color?: string }) => (
  <span
    style={{
      flex: "none",
      width: 22,
      height: 22,
      borderRadius: 5,
      border: `2px solid ${on ? color : desk.neutral400}`,
      background: on ? color : "#fff",
      color: "#fff",
      fontSize: 15,
      fontWeight: 800,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    {on ? "✓" : ""}
  </span>
);
