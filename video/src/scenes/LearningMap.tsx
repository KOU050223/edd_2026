import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { web } from "../theme";
import { MAP } from "../timeline";
import { Caption, easeInOut, progress, usePop } from "../ui";
import { S, WebFrame } from "../web-frame";

type Status = "confirmed" | "learning" | "unobserved";
type Node = {
  id: string;
  name: string;
  depth: number;
  row: number;
  status: Status;
  light?: number;
};

// light は MAP.lights の何番目で灯るか。goroutine が最後に灯り、そのまま現在地になる。
const NODES: Node[] = [
  { id: "A", name: "変数と型", depth: 0, row: 1, status: "confirmed", light: 0 },
  { id: "B", name: "関数", depth: 0, row: 3, status: "confirmed", light: 1 },
  { id: "C", name: "スライス", depth: 1, row: 0, status: "confirmed", light: 2 },
  { id: "D", name: "構造体", depth: 1, row: 2, status: "confirmed", light: 3 },
  { id: "E", name: "エラー処理", depth: 1, row: 4, status: "learning", light: 4 },
  { id: "F", name: "インターフェース", depth: 2, row: 1, status: "learning", light: 5 },
  { id: "G", name: "goroutine", depth: 2, row: 3, status: "learning", light: 6 },
  { id: "H", name: "チャネル", depth: 3, row: 2, status: "unobserved" },
  { id: "I", name: "sync.WaitGroup", depth: 3, row: 4, status: "unobserved" },
  { id: "J", name: "select", depth: 4, row: 1, status: "unobserved" },
  { id: "K", name: "context", depth: 4, row: 3, status: "unobserved" },
];
const EDGES: [string, string][] = [
  ["A", "C"],
  ["A", "D"],
  ["B", "D"],
  ["B", "E"],
  ["C", "F"],
  ["D", "F"],
  ["D", "G"],
  ["B", "G"],
  ["G", "H"],
  ["G", "I"],
  ["H", "J"],
  ["H", "K"],
  ["F", "J"],
];
const CURRENT = "G";
const NEXT = new Set(["H", "I"]);

const NODE_W = 230;
const NODE_H = 48 * S;
const COL = 262;
const ROW = 92;
const nodeX = (d: number) => 28 + d * COL;
const nodeY = (r: number) => 24 + r * ROW;
const byId = new Map(NODES.map((n) => [n.id, n]));

const statusLabel: Record<Status, string> = {
  confirmed: "確認済み",
  learning: "学習中",
  unobserved: "未観測",
};

const style = (status: Status | "current") =>
  ({
    confirmed: {
      background: web.confirmedBg,
      borderColor: web.confirmed,
      color: web.confirmedText,
    },
    learning: { background: web.learningBg, borderColor: web.learning, color: web.learningText },
    unobserved: {
      background: web.unobservedBg,
      borderColor: web.unobservedBorder,
      color: web.muted,
    },
    current: { background: web.current, borderColor: web.currentBorder, color: "#fff" },
  })[status];

export const LearningMap = () => {
  const frame = useCurrentFrame();
  const lit = (n: Node) => n.light !== undefined && frame >= MAP.lights[n.light];
  const isCurrent = frame >= MAP.current;
  const nextOn = progress(frame, MAP.next, 12);
  const ring = usePop(MAP.current, 8);
  const detail = progress(frame, MAP.current + 2, 14);
  const confirmedCount = NODES.filter((n) => n.status === "confirmed" && lit(n)).length;
  const learningCount = NODES.filter((n) => n.status === "learning" && lit(n)).length;
  // 現在地へ寄せる
  const zoom = interpolate(frame, [MAP.current - 10, MAP.current + 20], [1, 1.03], {
    easing: easeInOut,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: "700px 600px" }}>
        <WebFrame active="マップ">
          <div style={{ position: "absolute", left: 60, right: 60, top: 26 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 16 * S, marginBottom: 16 }}>
              <span style={{ color: web.primary, textDecoration: "underline", fontSize: 15 * S }}>
                ← 一覧
              </span>
              <span style={{ fontSize: 20 * S * 1.2, fontWeight: 700 }}>Go</span>
              <div
                style={{
                  marginLeft: "auto",
                  display: "flex",
                  alignItems: "center",
                  gap: 18,
                  fontSize: 13 * S,
                  color: web.muted,
                }}
              >
                <div
                  style={{
                    width: 420,
                    height: 12,
                    borderRadius: 999,
                    background: web.track,
                    display: "flex",
                    overflow: "hidden",
                  }}
                >
                  <i
                    style={{
                      width: `${(confirmedCount / NODES.length) * 100}%`,
                      background: web.confirmed,
                    }}
                  />
                  <i
                    style={{
                      width: `${(learningCount / NODES.length) * 100}%`,
                      background: web.learning,
                    }}
                  />
                </div>
                確認済み {confirmedCount} · 学習中 {learningCount} / {NODES.length}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                gap: 32 * S,
                padding: "14px 22px",
                background: web.surface,
                borderRadius: 12 * S,
                marginBottom: 16,
                fontSize: 16 * S,
                minHeight: 72,
                alignItems: "center",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 14,
                  alignItems: "baseline",
                  opacity: progress(frame, MAP.current, 8),
                }}
              >
                <span style={{ color: web.muted }}>現在地</span>
                <b>goroutine</b>
              </div>
              <div style={{ display: "flex", gap: 14, alignItems: "baseline", opacity: nextOn }}>
                <span style={{ color: web.muted }}>次に学ぶ候補</span>
                <b>チャネル</b>
                <b>sync.WaitGroup</b>
              </div>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0,1fr) 400px",
                gap: 16 * S,
                alignItems: "start",
              }}
            >
              <div
                style={{
                  background: web.surface,
                  borderRadius: 12 * S,
                  padding: "22px 16px",
                  position: "relative",
                  height: 540,
                }}
              >
                <div style={{ fontSize: 15 * S, fontWeight: 700, margin: "0 8px 8px" }}>
                  Go の学習マップ
                </div>
                <div style={{ position: "relative" }}>
                  <svg
                    width={1300}
                    height={500}
                    style={{ position: "absolute", inset: 0, overflow: "visible" }}
                  >
                    {EDGES.map(([f, t]) => {
                      const a = byId.get(f)!;
                      const b = byId.get(t)!;
                      const x1 = nodeX(a.depth) + NODE_W;
                      const y1 = nodeY(a.row) + NODE_H / 2;
                      const x2 = nodeX(b.depth);
                      const y2 = nodeY(b.row) + NODE_H / 2;
                      const mid = (x1 + x2) / 2;
                      const d = `M${x1} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
                      const next = f === CURRENT && NEXT.has(t);
                      const done = lit(a) && lit(b) && a.status === "confirmed";
                      return (
                        <g key={f + t}>
                          <path
                            d={d}
                            fill="none"
                            stroke={done ? web.edgeDone : web.unobservedBorder}
                            strokeWidth={2}
                          />
                          {next && (
                            <path
                              d={d}
                              fill="none"
                              stroke={web.current}
                              strokeWidth={4}
                              pathLength={1}
                              strokeDasharray={1}
                              strokeDashoffset={1 - nextOn}
                            />
                          )}
                        </g>
                      );
                    })}
                  </svg>
                  {NODES.map((n, i) => {
                    const on = lit(n);
                    const current = n.id === CURRENT && isCurrent;
                    const s = style(current ? "current" : on ? n.status : "unobserved");
                    const lightAt = n.light !== undefined ? MAP.lights[n.light] : Infinity;
                    const bump = on ? 1 + 0.12 * (1 - progress(frame, lightAt, 10)) : 1;
                    const next = NEXT.has(n.id) && nextOn > 0.5;
                    return (
                      <div
                        key={n.id}
                        style={{
                          position: "absolute",
                          left: nodeX(n.depth),
                          top: nodeY(n.row),
                          width: NODE_W,
                          height: NODE_H,
                          borderRadius: 10 * S,
                          border: `2px ${next ? "dashed" : "solid"} ${next ? web.current : s.borderColor}`,
                          background: s.background,
                          color: s.color,
                          padding: "4px 14px",
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "center",
                          gap: 2,
                          opacity: progress(frame, i * 1.2, 8),
                          transform: `scale(${current ? 1 + 0.08 * (1 - ring) + 0.04 : bump})`,
                          boxShadow: current
                            ? `0 0 0 ${6 * ring}px ${web.currentRing}, 0 12px 30px rgba(37,99,235,0.35)`
                            : undefined,
                        }}
                      >
                        <span style={{ fontSize: 13 * S, fontWeight: 600, whiteSpace: "nowrap" }}>
                          {on && n.status === "confirmed" && "✓ "}
                          {n.name}
                        </span>
                        <span
                          style={{
                            fontSize: 11 * S,
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          {current && (
                            <em
                              style={{
                                padding: "0 8px",
                                borderRadius: 999,
                                background: "#fff",
                                color: web.currentBorder,
                                fontStyle: "normal",
                              }}
                            >
                              現在地
                            </em>
                          )}
                          {statusLabel[on || current ? n.status : "unobserved"]}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div
                style={{
                  background: web.surface,
                  borderRadius: 12 * S,
                  padding: 18 * S,
                  opacity: detail,
                  transform: `translateX(${(1 - detail) * 60}px)`,
                  fontSize: 14 * S,
                }}
              >
                <div style={{ fontSize: 18 * S, fontWeight: 700, marginBottom: 8 }}>goroutine</div>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    marginBottom: 16,
                    color: web.learningText,
                  }}
                >
                  <em
                    style={{
                      padding: "0 10px",
                      borderRadius: 999,
                      background: web.currentBorder,
                      color: "#fff",
                      fontStyle: "normal",
                      fontSize: 11 * S,
                    }}
                  >
                    現在地
                  </em>
                  学習中
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 16px" }}>
                  <span style={{ color: web.muted }}>理解度</span>
                  <span>{Math.round(62 * progress(frame, MAP.current + 6, 30))}%</span>
                  <span style={{ color: web.muted }}>自力解決</span>
                  <span>5 回</span>
                  <span style={{ color: web.muted }}>ヒント利用</span>
                  <span>7 回</span>
                </div>
                <div
                  style={{
                    fontSize: 13 * S,
                    color: "#475569",
                    fontWeight: 700,
                    margin: "22px 0 8px",
                  }}
                >
                  次に接続する Concept
                </div>
                {["チャネル", "sync.WaitGroup"].map((c) => (
                  <div
                    key={c}
                    style={{ color: web.primary, textDecoration: "underline", marginBottom: 4 }}
                  >
                    {c}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </WebFrame>
      </AbsoluteFill>
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
        lines={["いまの自分の、現在地がわかる。"]}
        start={MAP.lights[2]}
        dark={false}
        size={68}
        accent={web.current}
        style={{ left: 60, top: 905 }}
      />
    </AbsoluteFill>
  );
};
