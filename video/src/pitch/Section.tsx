import { AbsoluteFill, useCurrentFrame } from "remotion";
import { fontUi } from "../theme";
import { Caption, DarkBackdrop, Flash, progress, riseIn } from "../ui";

const ITEMS = [
  { no: "①", text: "普段使っている AI の履歴から、地図を作る", tag: "デモ" },
  { no: "②", text: "GitHub のリポジトリから、地図を作る", tag: "開発中" },
];

/** 概要から「ポスターセッション以降に足したこと」へ移る見出し。 */
export const Section = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <DarkBackdrop />
      <Flash duration={10} />
      <Caption
        lines={["ポスターセッションのあと、", "地図の作り方を広げました。"]}
        start={4}
        size={80}
        style={{ left: 180, top: 200 }}
      />
      <div
        style={{
          position: "absolute",
          left: 218,
          top: 560,
          display: "flex",
          flexDirection: "column",
          gap: 30,
          fontFamily: fontUi,
        }}
      >
        {ITEMS.map((item, i) => (
          <div
            key={item.no}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 24,
              color: "#e2e8f0",
              fontSize: 46,
              fontWeight: 700,
              ...riseIn(frame, 40 + i * 14, 30),
            }}
          >
            <span style={{ color: "#2dd4bf" }}>{item.no}</span>
            {item.text}
            <span
              style={{
                fontSize: 24,
                padding: "6px 16px",
                borderRadius: 999,
                background: i === 0 ? "#0f766e" : "rgba(148,163,184,0.25)",
                color: "#fff",
                opacity: progress(frame, 60 + i * 14, 10),
              }}
            >
              {item.tag}
            </span>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
