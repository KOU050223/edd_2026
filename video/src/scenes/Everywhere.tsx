import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { brand, fontMono, fontUi, web } from "../theme";
import { EVERYWHERE, NOTES } from "../timeline";
import { Caption, DarkBackdrop, Flash, Notes, progress, usePop } from "../ui";

const CARDS = [
  { name: "VS Code", key: "⌘⇧J", glyph: "</>", color: brand.blue },
  { name: "Desktop", key: "⌘⇧K", glyph: "▢", color: "#0088b0" },
  { name: "Web", key: "Learning Map", glyph: "◎", color: web.primary },
];
const CARD_W = 440;
const GAP = 80;
const LEFT = (1920 - CARD_W * 3 - GAP * 2) / 2;
const CARD_TOP = 300;
const CARD_H = 260;
const HUB = { x: 960, y: 760 };

type Point = { x: number; y: number };
/** i 枚目のカードから中央のアイコンへ引く 3 次ベジェの制御点 */
const pathPoints = (i: number): Point[] => {
  const x = LEFT + i * (CARD_W + GAP) + CARD_W / 2;
  const y = CARD_TOP + CARD_H;
  return [
    { x, y },
    { x, y: y + 120 },
    { x: HUB.x, y: HUB.y - 200 },
    { x: HUB.x, y: HUB.y - 80 },
  ];
};
const bezier = ([a, b, c, d]: Point[], t: number): Point => {
  const u = 1 - t;
  const f = (k: "x" | "y") =>
    u ** 3 * a[k] + 3 * u * u * t * b[k] + 3 * u * t * t * c[k] + t ** 3 * d[k];
  return { x: f("x"), y: f("y") };
};

const Card = ({ i }: { i: number }) => {
  const c = CARDS[i];
  const pop = usePop(EVERYWHERE.cards[i], 11);
  return (
    <div
      style={{
        position: "absolute",
        left: LEFT + i * (CARD_W + GAP),
        top: CARD_TOP,
        width: CARD_W,
        height: CARD_H,
        borderRadius: 24,
        background: "rgba(248,250,252,0.06)",
        border: "1.5px solid rgba(148,163,184,0.3)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        transform: `translateY(${(1 - pop) * 80}px) scale(${0.8 + pop * 0.2})`,
        opacity: Math.min(1, pop * 2),
        fontFamily: fontUi,
      }}
    >
      <div
        style={{
          width: 96,
          height: 96,
          borderRadius: 24,
          background: c.color,
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: fontMono,
          fontSize: 40,
          fontWeight: 700,
        }}
      >
        {c.glyph}
      </div>
      <div style={{ color: "#fff", fontSize: 40, fontWeight: 800 }}>{c.name}</div>
      <div
        style={{ color: "#94a3b8", fontSize: 26, letterSpacing: "0.06em", fontFamily: fontMono }}
      >
        {c.key}
      </div>
    </div>
  );
};

export const Everywhere = () => {
  const frame = useCurrentFrame();
  const link = progress(frame, EVERYWHERE.link, 10);
  const hub = usePop(EVERYWHERE.link + 2, 10);
  return (
    <AbsoluteFill>
      <DarkBackdrop />
      <Caption
        lines={["どこからでも、同じ学びにつながる。"]}
        start={2}
        size={68}
        style={{ left: 90, top: 100 }}
      />
      <Notes notes={NOTES.everywhere} style={{ left: 128, top: 200 }} />
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
        {CARDS.map((_, i) => {
          const p = pathPoints(i);
          const d = `M${p[0].x} ${p[0].y} C ${p[1].x} ${p[1].y}, ${p[2].x} ${p[2].y}, ${p[3].x} ${p[3].y}`;
          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={web.edgeDone}
              strokeWidth={4}
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - link}
            />
          );
        })}
      </svg>
      {CARDS.map((_, i) => (
        <Card key={i} i={i} />
      ))}
      {/* 線がつながった後、各入口から記録が流れ込み続ける */}
      {frame > EVERYWHERE.link + 10 &&
        CARDS.flatMap((c, i) =>
          [0, 1].map((k) => {
            const t = ((((frame - EVERYWHERE.link - 10) / 36 + i * 0.2 + k * 0.5) % 1) + 1) % 1;
            const pt = bezier(pathPoints(i), t);
            return (
              <span
                key={`${i}-${k}`}
                style={{
                  position: "absolute",
                  left: pt.x - 9,
                  top: pt.y - 9,
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  background: c.color,
                  boxShadow: `0 0 16px ${c.color}`,
                  opacity: Math.sin(Math.PI * t),
                }}
              />
            );
          }),
        )}
      <div
        style={{
          position: "absolute",
          left: HUB.x - 90,
          top: HUB.y - 90,
          width: 180,
          height: 180,
          borderRadius: 48,
          background: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${hub})`,
          boxShadow: `0 0 0 ${10 * hub}px rgba(110,231,183,0.25), 0 30px 60px rgba(2,6,23,0.5)`,
        }}
      >
        <Img src={staticFile("icon.png")} style={{ width: 150, height: 150 }} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: HUB.y + 110,
          textAlign: "center",
          fontFamily: fontUi,
          fontWeight: 700,
          fontSize: 32,
          letterSpacing: "0.1em",
          color: web.edgeDone,
          opacity: progress(frame, EVERYWHERE.link + 12, 10),
        }}
      >
        学習の記録
      </div>
      <Flash duration={6} />
    </AbsoluteFill>
  );
};
