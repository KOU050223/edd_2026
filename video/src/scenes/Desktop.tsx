import { AbsoluteFill, useCurrentFrame } from "remotion";
import { desk, fontMono, fontUi } from "../theme";
import { DESKTOP, NOTES } from "../timeline";
import {
  Caption,
  Shortcut,
  DarkBackdrop,
  KeyCombo,
  Notes,
  Tag,
  glow,
  fontSerif,
  progress,
  streamed,
  usePop,
} from "../ui";

const DOC_CODE = [
  "results := make(chan int)",
  "for w := 1; w <= 3; w++ {",
  "    go worker(w, results)",
  "}",
];
const HL = 2;
const ANSWER =
  "go の後ろの関数は、別の goroutine で並行に動きます。worker が results へ送るたび、受け取る側がいるか確かめてみましょう。";

const CONCEPTS: {
  name: string;
  status: "confirmed" | "learning" | "unobserved";
  current?: boolean;
}[] = [
  { name: "変数と型", status: "confirmed" },
  { name: "スライス", status: "confirmed" },
  { name: "goroutine", status: "learning", current: true },
  { name: "チャネル", status: "learning" },
  { name: "select", status: "unobserved" },
  { name: "context", status: "unobserved" },
];
const dotColor = { confirmed: desk.accent, learning: desk.learning, unobserved: desk.neutral400 };

/** ブラウザで読んでいるドキュメント。デスクトップ版はエディタ以外からも呼べることを見せる。 */
const Browser = ({ frame }: { frame: number }) => {
  const sel = progress(frame, DESKTOP.select, 12);
  return (
    <div
      style={{
        position: "absolute",
        left: 80,
        top: 50,
        width: 1760,
        height: 800,
        borderRadius: 14,
        overflow: "hidden",
        background: "#fff",
        boxShadow: "0 40px 90px rgba(2,6,23,0.6)",
      }}
    >
      <div
        style={{
          height: 56,
          background: "#e5e7eb",
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "0 20px",
        }}
      >
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <span key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />
        ))}
        <div
          style={{
            marginLeft: 24,
            flex: 1,
            height: 34,
            borderRadius: 17,
            background: "#fff",
            display: "flex",
            alignItems: "center",
            padding: "0 18px",
            color: "#6b7280",
            fontFamily: fontUi,
            fontSize: 17,
          }}
        >
          docs.example.dev/go/channels
        </div>
      </div>
      <div style={{ padding: "50px 120px", fontFamily: fontUi, color: "#111827" }}>
        <div style={{ fontSize: 44, fontWeight: 800, marginBottom: 26 }}>Worker Pools</div>
        {[1, 0.92, 0.7].map((w, i) => (
          <div
            key={i}
            style={{
              height: 18,
              width: `${w * 100}%`,
              background: "#e5e7eb",
              borderRadius: 9,
              marginBottom: 16,
            }}
          />
        ))}
        <div
          style={{
            marginTop: 34,
            padding: "26px 32px",
            borderRadius: 12,
            background: "#f3f4f6",
            fontFamily: fontMono,
            fontSize: 28,
            lineHeight: 1.8,
            position: "relative",
          }}
        >
          {DOC_CODE.map((l, i) => (
            <div key={i} style={{ position: "relative", whiteSpace: "pre" }}>
              {i === HL && (
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 4,
                    bottom: 4,
                    width: `${sel * 22}em`,
                    background: "#bfdbfe",
                    borderRadius: 3,
                  }}
                />
              )}
              <span style={{ position: "relative" }}>{l}</span>
            </div>
          ))}
        </div>
        {[0.96, 0.8].map((w, i) => (
          <div
            key={i}
            style={{
              height: 18,
              width: `${w * 100}%`,
              background: "#e5e7eb",
              borderRadius: 9,
              marginTop: 20,
            }}
          />
        ))}
      </div>
    </div>
  );
};

export const Desktop = () => {
  const frame = useCurrentFrame();
  const pop = usePop(DESKTOP.popup, 13);
  const shown = frame >= DESKTOP.popup;
  const dim = progress(frame, DESKTOP.popup - 4, 10);
  const answer = streamed(ANSWER, frame, DESKTOP.stream, DESKTOP.cps);
  // 補足②の間は選択テキスト、補足③の間は左の概念一覧を光らせる
  const selectionGlow =
    progress(frame, NOTES.desktop[1].start, 10) * (1 - progress(frame, DESKTOP.sidebar, 10));
  const sidebarGlow = progress(frame, DESKTOP.sidebar, 10);
  const enter = progress(frame, 0, 14);

  return (
    <AbsoluteFill>
      <DarkBackdrop />
      <AbsoluteFill style={{ opacity: enter, transform: `translateX(${(1 - enter) * 120}px)` }}>
        <Browser frame={frame} />
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "rgba(15,23,42,0.45)", opacity: dim }} />

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 560,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <KeyCombo keys={["⌘", "⇧", "K"]} pressAt={DESKTOP.keys} release={DESKTOP.popup - 2} />
      </div>

      {shown && (
        <div
          style={{
            position: "absolute",
            left: 400,
            top: 70,
            width: 1120,
            height: 760,
            borderRadius: 18,
            overflow: "hidden",
            background: desk.bg,
            color: desk.text,
            boxShadow: desk.shadowLg,
            display: "flex",
            flexDirection: "column",
            transform: `scale(${0.6 + pop * 0.4})`,
            opacity: Math.min(1, pop * 1.5),
          }}
        >
          <div
            style={{
              height: 60,
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
            <span style={{ marginLeft: "auto", fontSize: 26, color: desk.neutral700 }}>×</span>
          </div>
          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            <div
              style={{
                width: 290,
                background: desk.surface,
                padding: "24px 16px",
                fontFamily: fontSerif,
                boxShadow: `inset 0 0 0 ${4 * sidebarGlow}px #2dd4bf`,
              }}
            >
              <div
                style={{
                  fontSize: 15,
                  letterSpacing: "0.1em",
                  color: desk.neutral700,
                  padding: "0 12px 14px",
                  fontFamily: fontUi,
                }}
              >
                LEARNING MAP · GO
              </div>
              {CONCEPTS.map((c, i) => (
                <div
                  key={c.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "12px 14px",
                    borderRadius: 10,
                    fontSize: 21,
                    background: c.current ? desk.bg : undefined,
                    opacity: progress(frame, DESKTOP.popup + 4 + i * 2, 8),
                  }}
                >
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 6,
                      background: dotColor[c.status],
                      flex: "none",
                    }}
                  />
                  {c.name}
                </div>
              ))}
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
              <div
                style={{
                  flex: 1,
                  padding: "26px 36px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 20,
                }}
              >
                <div
                  style={{
                    fontSize: 15,
                    letterSpacing: "0.1em",
                    color: desk.neutral700,
                    fontFamily: fontUi,
                  }}
                >
                  選択テキスト
                </div>
                <div
                  style={{
                    padding: "18px 24px",
                    borderRadius: 14,
                    background: desk.neutral100,
                    boxShadow: "0 1px 2px rgba(45,43,43,0.14)",
                    ...glow(selectionGlow),
                    fontFamily: fontMono,
                    fontSize: 22,
                    color: desk.neutral700,
                  }}
                >
                  <span style={{ background: desk.accent100, borderRadius: 3, padding: "2px 4px" }}>
                    go worker(w, results)
                  </span>
                </div>
                <div
                  style={{
                    padding: 24,
                    borderRadius: 22,
                    background: desk.bg,
                    boxShadow: "0 1px 2px rgba(45,43,43,0.14), 0 0 0 1px rgba(32,30,29,0.06)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        background: desk.accent100,
                        color: desk.accent700,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontFamily: fontSerif,
                        fontSize: 18,
                      }}
                    >
                      学
                    </span>
                    <span style={{ fontFamily: fontSerif, fontWeight: 600, fontSize: 21 }}>
                      回答
                    </span>
                  </div>
                  <div
                    style={{
                      fontFamily: fontSerif,
                      fontSize: 23,
                      lineHeight: 1.75,
                      minHeight: 120,
                    }}
                  >
                    {answer}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      opacity: progress(frame, DESKTOP.stream + ANSWER.length / DESKTOP.cps, 8),
                    }}
                  >
                    {["goroutine", "チャネル"].map((c) => (
                      <span
                        key={c}
                        style={{
                          fontFamily: fontUi,
                          fontSize: 16,
                          padding: "4px 14px",
                          borderRadius: 999,
                          background: desk.accent100,
                          color: desk.accent800,
                        }}
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <div
                style={{
                  padding: "18px 36px 22px",
                  background: desk.surface,
                  borderTop: `1px solid ${desk.divider}`,
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div
                  style={{
                    fontFamily: fontSerif,
                    fontSize: 21,
                    color: desk.neutral700,
                    background: desk.bg,
                    borderRadius: 10,
                    padding: "12px 16px",
                  }}
                >
                  何を知りたいですか？
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 10,
                    fontFamily: fontSerif,
                    fontSize: 18,
                  }}
                >
                  <span
                    style={{
                      padding: "8px 16px",
                      borderRadius: 8,
                      border: `1px solid ${desk.divider}`,
                    }}
                  >
                    もっと自分で考えたい
                  </span>
                  <span
                    style={{
                      padding: "8px 22px",
                      borderRadius: 8,
                      background: desk.accent,
                      color: desk.bg,
                      fontWeight: 600,
                    }}
                  >
                    送信
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <Caption
        lines={["エディタの外でも、すぐに。"]}
        start={DESKTOP.select}
        size={64}
        style={{ left: 90, top: 862 }}
      />
      <Notes notes={NOTES.desktop} style={{ left: 128, top: 962 }} />
      <Tag start={10} style={{ right: 90, top: 878 }}>
        Desktop　<Shortcut>⌘⇧K</Shortcut>
      </Tag>
    </AbsoluteFill>
  );
};
