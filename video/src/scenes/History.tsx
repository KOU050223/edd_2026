import { AbsoluteFill, useCurrentFrame } from "remotion";
import { fontUi, web } from "../theme";
import { HISTORY } from "../timeline";
import { Caption, countUp, progress } from "../ui";
import { S, WebFrame } from "../web-frame";

type Outcome = "solved" | "hint" | "recurred";
const QUESTIONS: { q: string; from: string; outcome: Outcome }[] = [
  { q: "なぜここで止まる？", from: "VS Code · main.go", outcome: "hint" },
  { q: "go の後ろの関数は何をしている？", from: "Desktop", outcome: "solved" },
  { q: "select はいつ使う？", from: "VS Code · worker.go", outcome: "hint" },
  { q: "nil チャネルに送るとどうなる？", from: "Desktop", outcome: "solved" },
  { q: "WaitGroup の Add はどこで呼ぶ？", from: "VS Code · pool.go", outcome: "solved" },
  { q: "range で回すと終わらない", from: "VS Code · main.go", outcome: "recurred" },
];
const OUTCOME = {
  solved: { color: web.solved, label: "自力解決" },
  hint: { color: web.hint, label: "ヒント利用" },
  recurred: { color: web.recurred, label: "エラー再発" },
};

// 30 日ぶんの件数。右へ行くほど自力解決が増える、という物語に沿って作る。
const DAYS = Array.from({ length: 30 }, (_, d) => {
  const total = 3 + Math.round(d * 0.32 + 4 * Math.sin(d * 1.3) ** 2);
  const solved = Math.round(total * (0.25 + d * 0.018));
  const recurred = d % 7 === 3 ? 2 : d % 5 === 1 ? 1 : 0;
  return { solved, hint: Math.max(0, total - solved - recurred), recurred };
});
const MAX = Math.max(...DAYS.map((d) => d.solved + d.hint + d.recurred));

const CARD_H = 104;
const CARD_GAP = 14;

const QuestionFeed = ({ frame }: { frame: number }) => (
  <div style={{ position: "absolute", left: 60, top: 36, width: 540 }}>
    <div style={{ fontSize: 17 * S, fontWeight: 700, marginBottom: 20 }}>最近の質問</div>
    <div style={{ position: "relative" }}>
      {QUESTIONS.map((item, k) => {
        const at = HISTORY.questions[k];
        const enter = progress(frame, at, 12);
        // 新しい質問が上に積まれ、古いものは押し下げられる
        const below = QUESTIONS.reduce(
          (y, _, j) =>
            j > k ? y + progress(frame, HISTORY.questions[j], 12) * (CARD_H + CARD_GAP) : y,
          0,
        );
        const o = OUTCOME[item.outcome];
        return (
          <div
            key={k}
            style={{
              position: "absolute",
              left: 0,
              top: below,
              width: 540,
              height: CARD_H,
              borderRadius: 12 * S,
              background: web.surface,
              border: `1px solid ${web.border}`,
              padding: "16px 22px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: 6,
              opacity: enter,
              transform: `translateX(${(1 - enter) * -80}px) scale(${0.9 + enter * 0.1})`,
              boxShadow: "0 8px 20px rgba(15,23,42,0.06)",
            }}
          >
            <div style={{ fontSize: 25, fontWeight: 700 }}>{item.q}</div>
            <div
              style={{
                fontSize: 19,
                color: web.muted,
                display: "flex",
                gap: 10,
                alignItems: "center",
              }}
            >
              <i style={{ width: 12, height: 12, borderRadius: 6, background: o.color }} />
              {o.label}　·　{item.from}
            </div>
          </div>
        );
      })}
    </div>
  </div>
);

const Tile = ({
  label,
  value,
  unit,
  frame,
  i,
}: {
  label: string;
  value: number;
  unit: string;
  frame: number;
  i: number;
}) => {
  const at = HISTORY.counters + i * 4;
  return (
    <div
      style={{
        background: web.surface,
        borderRadius: 12 * S,
        padding: 16 * S,
        minWidth: 130 * S,
        flex: 1,
        opacity: progress(frame, 6 + i * 3, 10),
      }}
    >
      <div style={{ fontSize: 15 * S, color: web.muted }}>{label}</div>
      <strong
        style={{ fontSize: 28 * S * 1.35, display: "block", fontVariantNumeric: "tabular-nums" }}
      >
        {countUp(frame, at, 40, value)}
        <small style={{ fontSize: 18 * S, marginLeft: 6 }}>{unit}</small>
      </strong>
    </div>
  );
};

export const History = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <WebFrame active="推移">
        <QuestionFeed frame={frame} />
        <div
          style={{
            position: "absolute",
            left: 660,
            top: 36,
            width: 1200,
            display: "flex",
            flexDirection: "column",
            gap: 24,
          }}
        >
          <div style={{ display: "flex", gap: 16, fontSize: 16 * S }}>
            {["7 日", "30 日", "90 日"].map((p) => (
              <span
                key={p}
                style={{
                  borderRadius: 8 * S,
                  padding: "10px 20px",
                  background: p === "30 日" ? web.primary : web.chip,
                  color: p === "30 日" ? "#fff" : web.chipText,
                }}
              >
                {p}
              </span>
            ))}
            <span
              style={{
                borderRadius: 8 * S,
                padding: "10px 20px",
                background: web.chip,
                color: web.chipText,
              }}
            >
              再読み込み
            </span>
          </div>
          <div style={{ display: "flex", gap: 16 * S }}>
            <Tile label="質問" value={128} unit="件" frame={frame} i={0} />
            <Tile label="自力解決" value={74} unit="%" frame={frame} i={1} />
            <Tile label="学んだ概念" value={23} unit="個" frame={frame} i={2} />
          </div>
          <div
            style={{
              height: 380,
              background: web.surface,
              borderRadius: 12 * S,
              padding: 28,
              display: "flex",
              alignItems: "flex-end",
              gap: 6,
            }}
          >
            {DAYS.map((d, i) => {
              const grow = progress(frame, HISTORY.chart + i * 1.8, 14);
              const total = d.solved + d.hint + d.recurred;
              return (
                <div
                  key={i}
                  style={{
                    height: `${(total / MAX) * 100 * grow}%`,
                    flex: 1,
                    display: "flex",
                    flexDirection: "column-reverse",
                    borderRadius: "4px 4px 0 0",
                    overflow: "hidden",
                  }}
                >
                  <i style={{ height: `${(d.solved / total) * 100}%`, background: web.solved }} />
                  <i style={{ height: `${(d.hint / total) * 100}%`, background: web.hint }} />
                  <i
                    style={{ height: `${(d.recurred / total) * 100}%`, background: web.recurred }}
                  />
                </div>
              );
            })}
          </div>
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              color: "#475569",
              fontSize: 15 * S,
              fontFamily: fontUi,
            }}
          >
            {Object.values(OUTCOME).map((o) => (
              <span
                key={o.label}
                style={{ display: "flex", gap: 10, alignItems: "center", marginRight: 16 }}
              >
                <i style={{ width: 18, height: 18, background: o.color }} />
                {o.label}
              </span>
            ))}
          </div>
        </div>
      </WebFrame>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 230,
          background: `linear-gradient(transparent, ${web.bg} 45%)`,
        }}
      />
      <Caption
        lines={["質問するたびに、履歴がたまっていく。"]}
        start={HISTORY.questions[1]}
        dark={false}
        size={68}
        style={{ left: 60, top: 905 }}
      />
    </AbsoluteFill>
  );
};
