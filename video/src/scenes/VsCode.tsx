import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { CODE, CodeLines } from "../code";
import { fontMono, fontUi, web } from "../theme";
import { VSCODE } from "../timeline";
import { Caption, Shortcut, DarkBackdrop, KeyCombo, Tag, progress, streamed } from "../ui";

const FONT = 36;
const LINE = FONT * 1.7;
const CHAR = FONT * 0.602;
const SELECTED = [3, 4, 5];

const ANSWER_HINT = "バッファのないチャネルへの送信は、受け取る側が現れるまで止まります。";
const ANSWER_NEXT = "受け取る goroutine はどこにありますか？ 送信を go func() に分けてみましょう。";
const CPS = 1.5;

export const VsCode = () => {
  const frame = useCurrentFrame();
  const panel = progress(frame, VSCODE.panel, 16);
  const sel = progress(frame, VSCODE.select, 12);
  const hint = streamed(ANSWER_HINT, frame, VSCODE.stream, CPS);
  const nextStart = VSCODE.stream + ANSWER_HINT.length / CPS + 4;
  const next = streamed(ANSWER_NEXT, frame, nextStart, CPS);
  const recordedAt = nextStart + ANSWER_NEXT.length / CPS + 4;
  const enter = progress(frame, 0, 16);

  return (
    <AbsoluteFill>
      <DarkBackdrop />
      <div
        style={{
          position: "absolute",
          left: 90,
          top: 50,
          width: 1740,
          height: 790,
          borderRadius: 14,
          overflow: "hidden",
          background: "#1f1f1f",
          boxShadow: "0 40px 90px rgba(2,6,23,0.7)",
          border: "1px solid #2b2b2b",
          display: "flex",
          flexDirection: "column",
          opacity: enter,
          transform: `translateY(${(1 - enter) * 60}px) scale(${0.96 + enter * 0.04})`,
        }}
      >
        <div
          style={{
            height: 44,
            background: "#181818",
            display: "flex",
            alignItems: "center",
            padding: "0 18px",
            gap: 9,
            borderBottom: "1px solid #2b2b2b",
          }}
        >
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <span key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />
          ))}
          <span
            style={{
              flex: 1,
              textAlign: "center",
              color: "#9d9d9d",
              fontFamily: fontUi,
              fontSize: 18,
            }}
          >
            main.go — learn-go
          </span>
        </div>
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div
            style={{
              width: 64,
              background: "#181818",
              borderRight: "1px solid #2b2b2b",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 26,
              paddingTop: 20,
            }}
          >
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  border: `2.5px solid ${i === 0 ? "#d4d4d4" : "#6e6e6e"}`,
                }}
              />
            ))}
          </div>
          <div
            style={{
              width: 270,
              background: "#181818",
              borderRight: "1px solid #2b2b2b",
              padding: "16px 0",
              fontFamily: fontUi,
              fontSize: 19,
              color: "#cccccc",
            }}
          >
            <div
              style={{
                padding: "0 20px 12px",
                fontSize: 14,
                letterSpacing: "0.1em",
                color: "#9d9d9d",
              }}
            >
              EXPLORER
            </div>
            {["go.mod", "main.go", "worker.go", "README.md"].map((f) => (
              <div
                key={f}
                style={{ padding: "6px 28px", background: f === "main.go" ? "#37373d" : undefined }}
              >
                {f}
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
            <div
              style={{
                height: 48,
                background: "#181818",
                display: "flex",
                borderBottom: "1px solid #2b2b2b",
              }}
            >
              <div
                style={{
                  padding: "0 26px",
                  display: "flex",
                  alignItems: "center",
                  background: "#1f1f1f",
                  color: "#fff",
                  fontFamily: fontUi,
                  fontSize: 18,
                  borderTop: "2px solid #0078d4",
                }}
              >
                main.go
              </div>
            </div>
            <div style={{ position: "relative", padding: 28 }}>
              {SELECTED.map((l) => {
                const len = CODE[l].reduce((a, [t]) => a + t.length, 0);
                return (
                  <div
                    key={l}
                    style={{
                      position: "absolute",
                      left: 28 + FONT * 3.2,
                      top: 28 + l * LINE + 4,
                      height: LINE - 8,
                      width: len * CHAR * sel,
                      background: "#264f78",
                      borderRadius: 3,
                    }}
                  />
                );
              })}
              <CodeLines fontSize={FONT} style={{ position: "relative" }} />
            </div>
          </div>
          <div
            style={{
              width: 720 * panel,
              background: "#181818",
              borderLeft: "1px solid #2b2b2b",
              overflow: "hidden",
              flex: "none",
            }}
          >
            <div
              style={{
                width: 720,
                padding: "22px 30px",
                fontFamily: fontUi,
                color: "#cccccc",
                display: "flex",
                flexDirection: "column",
                gap: 24,
              }}
            >
              <div style={{ fontSize: 15, letterSpacing: "0.1em", color: "#9d9d9d" }}>CHAT</div>
              <div style={{ display: "flex", gap: 14 }}>
                <span
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    background: "#3b4252",
                    flex: "none",
                  }}
                />
                <div style={{ fontSize: 27, lineHeight: 1.6 }}>
                  <span style={{ color: "#4daafc" }}>@gakushu-sochi</span> なぜここで止まる？
                  <div
                    style={{
                      marginTop: 8,
                      display: "inline-block",
                      fontFamily: fontMono,
                      fontSize: 17,
                      padding: "3px 10px",
                      borderRadius: 6,
                      background: "#2b2b2b",
                      color: "#9d9d9d",
                    }}
                  >
                    main.go:4-6
                  </div>
                </div>
              </div>
              <div
                style={{ display: "flex", gap: 14, opacity: progress(frame, VSCODE.stream - 6, 8) }}
              >
                <Img src={staticFile("icon.png")} style={{ width: 38, height: 38, flex: "none" }} />
                <div style={{ fontSize: 27, lineHeight: 1.7, color: "#e5e5e5" }}>
                  <div style={{ fontWeight: 700, color: "#fff", marginBottom: 6 }}>学習装置</div>
                  <div
                    style={{
                      padding: "12px 16px",
                      borderRadius: 10,
                      background: web.hintBg,
                      color: web.hintText,
                      marginBottom: 14,
                    }}
                  >
                    <b>ヒント</b>　{hint}
                  </div>
                  {frame >= nextStart && (
                    <div>
                      <b style={{ color: "#5eead4" }}>次に試す一手</b>
                      <br />
                      {next}
                    </div>
                  )}
                  <div
                    style={{
                      marginTop: 18,
                      fontSize: 19,
                      color: "#5eead4",
                      opacity: progress(frame, recordedAt, 8),
                      transform: `translateY(${(1 - progress(frame, recordedAt, 8)) * 10}px)`,
                    }}
                  >
                    ✓ 学習の記録に追加しました
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 540,
          display: "flex",
          justifyContent: "center",
          paddingRight: 500,
        }}
      >
        <KeyCombo keys={["⌘", "⇧", "J"]} pressAt={VSCODE.keys} release={VSCODE.panel + 6} />
      </div>

      <Caption
        lines={["ショートカット1つで、その場で質問。"]}
        start={VSCODE.keys[0]}
        size={68}
        style={{ left: 90, top: 888 }}
      />
      <Tag start={10} style={{ right: 90, top: 905 }}>
        VS Code　<Shortcut>⌘⇧J</Shortcut>
      </Tag>
    </AbsoluteFill>
  );
};
