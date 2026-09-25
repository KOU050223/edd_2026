import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { CodeLines, ERROR_LINE, Squiggle } from "../code";
import { fontMono, fontUi } from "../theme";
import { BEAT, HOOK, NOTES, SCENES } from "../timeline";
import { Caption, DarkBackdrop, Notes, progress, usePop } from "../ui";

const FONT = 34;
const LINE = FONT * 1.7;
const PAD = 44;
const GUTTER = FONT * 2.2 + FONT;
const CHAR = FONT * 0.602; // SF Mono の字幅
const END = SCENES.hook.duration;
const PUSH_FROM = END - BEAT * 1.5;
const DETOURS = ["ブラウザで検索", "ドキュメントを探す", "エラー文をコピペ"];

/** 調べ物のためにエディタを離れる、その寄り道をカードで見せる。 */
const Detour = ({ label, at, i }: { label: string; at: number; i: number }) => {
  const pop = usePop(at, 12);
  const frame = useCurrentFrame();
  const drift = Math.sin((frame - at) / 20 + i) * 4;
  return (
    <div
      style={{
        position: "absolute",
        left: 1370 + i * 36,
        top: 190 + i * 130 + drift,
        width: 420,
        padding: "26px 30px",
        borderRadius: 16,
        background: "rgba(248,250,252,0.08)",
        border: "1.5px solid rgba(148,163,184,0.35)",
        color: "#e2e8f0",
        fontFamily: fontUi,
        fontWeight: 700,
        fontSize: 32,
        display: "flex",
        alignItems: "center",
        gap: 18,
        opacity: Math.min(1, pop * 1.5),
        transform: `translateX(${(1 - pop) * 120}px) rotate(${(i - 1) * 2.5}deg)`,
      }}
    >
      <span style={{ fontFamily: fontMono, color: "#fca5a5", fontSize: 30 }}>↗</span>
      {label}
    </div>
  );
};

export const Hook = () => {
  const frame = useCurrentFrame();
  const errorPop = usePop(HOOK.error, 11);
  const cursorOn = Math.floor(frame / 8) % 2 === 0;
  // 最後の 1 拍半でエラー行へ寄る。次の場面のライザーと重ねる。
  const push = interpolate(frame, [PUSH_FROM, END], [1, 1.35], {
    easing: Easing.in(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const drift = interpolate(frame, [0, END], [1, 1.04]);
  const lineY = 150 + 56 + PAD + ERROR_LINE * LINE;
  const lineX = 180 + PAD + GUTTER + 4 * CHAR;

  return (
    <AbsoluteFill>
      <DarkBackdrop />
      <AbsoluteFill
        style={{
          transform: `scale(${drift * push})`,
          transformOrigin: `${lineX + 70}px ${lineY + 20}px`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 180,
            top: 150,
            width: 1100,
            height: 500,
            borderRadius: 18,
            background: "#0b1220",
            border: "1px solid #1e293b",
            boxShadow: "0 40px 80px rgba(2,6,23,0.6)",
            overflow: "hidden",
            opacity: progress(frame, 0, 10),
          }}
        >
          <div
            style={{
              height: 56,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "0 22px",
              borderBottom: "1px solid #1e293b",
            }}
          >
            {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
              <span key={c} style={{ width: 16, height: 16, borderRadius: 8, background: c }} />
            ))}
            <span style={{ marginLeft: 18, color: "#94a3b8", fontFamily: fontMono, fontSize: 22 }}>
              main.go
            </span>
          </div>
          <div style={{ padding: PAD, position: "relative" }}>
            <CodeLines fontSize={FONT} visibleChars={frame * 3.2} />
            {frame > 26 && cursorOn && frame < HOOK.squiggle && (
              <span
                style={{
                  position: "absolute",
                  left: PAD + GUTTER + 1 * CHAR,
                  top: PAD + 6 * LINE + 8,
                  width: 3,
                  height: FONT * 1.2,
                  background: "#e2e8f0",
                }}
              />
            )}
          </div>
        </div>

        <Squiggle
          width={7 * CHAR}
          progress={progress(frame, HOOK.squiggle, 10)}
          style={{ left: lineX, top: lineY + FONT * 1.35 }}
        />

        <div
          style={{
            position: "absolute",
            left: lineX - 10,
            top: lineY + LINE + 6,
            padding: "16px 22px",
            borderRadius: 12,
            background: "#1f1315",
            border: "1.5px solid #f14c4c",
            color: "#fecaca",
            fontFamily: fontMono,
            fontSize: 24,
            transform: `scale(${errorPop})`,
            transformOrigin: "top left",
            opacity: frame >= HOOK.error ? 1 : 0,
            boxShadow: "0 20px 40px rgba(0,0,0,0.5)",
          }}
        >
          <span style={{ color: "#f14c4c", fontWeight: 700, fontFamily: fontUi }}>✕ </span>
          fatal error: all goroutines are asleep - deadlock!
        </div>
      </AbsoluteFill>

      <AbsoluteFill style={{ opacity: 1 - progress(frame, PUSH_FROM, 8) }}>
        {DETOURS.map((label, i) => (
          <Detour key={label} label={label} at={HOOK.detours[i]} i={i} />
        ))}
        <Caption
          lines={["「わからない」は、", "手が止まった瞬間に来る。"]}
          start={20}
          style={{ left: 180, top: 700 }}
        />
        <Notes notes={NOTES.hook} style={{ left: 218, top: 945 }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
