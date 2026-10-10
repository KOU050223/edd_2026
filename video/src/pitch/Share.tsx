import { AbsoluteFill, useCurrentFrame } from "remotion";
import { fontUi, web } from "../theme";
import { Caption, DarkBackdrop, progress, usePop } from "../ui";
import { Cursor, type CursorStop } from "./parts";
import { SHARE } from "./timeline";

// みんなのマップ（apps/web/src/client/routes/_framed/explore.index.tsx）。マップ名は例。

const MAPS = [
  { title: "Go の並行処理", desc: "goroutine からチャネル、context まで", nodes: 12 },
  { title: "ecommerce のドメイン", desc: "注文・決済・配送のつながり", nodes: 18 },
  { title: "TypeScript の型", desc: "型の絞り込みからジェネリクスへ", nodes: 15 },
];
const CARD_W = 520;
const cardX = (i: number) => 120 + i * (CARD_W + 40);
const CARD_Y = 330;

const STOPS: CursorStop[] = [
  { at: SHARE.take - 30, x: 900, y: 900 },
  { at: SHARE.take, x: cardX(1) + 400, y: CARD_Y + 236, click: true },
];

export const Share = () => {
  const frame = useCurrentFrame();
  const taken = frame >= SHARE.take + 4;
  const toast = usePop(SHARE.take + 6, 14);
  return (
    <AbsoluteFill>
      <DarkBackdrop />
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 200,
          fontFamily: fontUi,
          color: "#fff",
          fontSize: 48,
          fontWeight: 800,
          opacity: progress(frame, 0, 12),
        }}
      >
        みんなのマップ
        <span style={{ fontSize: 24, color: "#94a3b8", fontWeight: 600, marginLeft: 24 }}>
          共有された地図を読んで、自分の地図に取り込める
        </span>
      </div>
      {MAPS.map((m, i) => {
        const pop = cardIn(frame, SHARE.cards[i]);
        return (
          <div
            key={m.title}
            style={{
              position: "absolute",
              left: cardX(i),
              top: CARD_Y,
              width: CARD_W,
              height: 290,
              boxSizing: "border-box",
              padding: "30px 34px",
              borderRadius: 16,
              background: web.surface,
              fontFamily: fontUi,
              color: web.ink,
              opacity: pop,
              transform: `translateY(${(1 - pop) * 40}px)`,
            }}
          >
            <div style={{ fontSize: 32, fontWeight: 800 }}>{m.title}</div>
            <div style={{ fontSize: 22, color: web.muted, marginTop: 10 }}>{m.desc}</div>
            <div style={{ fontSize: 20, color: web.muted, marginTop: 10 }}>{m.nodes} ノード</div>
            <span
              style={{
                position: "absolute",
                right: 34,
                bottom: 30,
                padding: "12px 24px",
                borderRadius: 10,
                background: i === 1 && taken ? web.confirmedBg : web.primary,
                color: i === 1 && taken ? web.confirmedText : "#fff",
                fontSize: 21,
                fontWeight: 700,
              }}
            >
              {i === 1 && taken ? "✓ 取り込み済み" : "自分のマップに取り込む"}
            </span>
          </div>
        );
      })}
      {frame >= SHARE.take + 6 && (
        <div
          style={{
            position: "absolute",
            left: cardX(1),
            top: CARD_Y + 320,
            whiteSpace: "nowrap",
            fontFamily: fontUi,
            fontSize: 22,
            color: "#cbd5e1",
            opacity: Math.min(1, toast * 1.4),
          }}
        >
          元の地図が更新されたら「更新あり」から差分を見て取り込み直せる
        </div>
      )}
      <Cursor stops={STOPS} />
      <Caption
        lines={["作った地図は、共有できる。"]}
        start={SHARE.copy}
        size={64}
        style={{ left: 120, top: 830 }}
      />
    </AbsoluteFill>
  );
};

/** カードが浮き上がる量。ループの中で呼ぶので hook にしない。 */
const cardIn = (frame: number, start: number) => progress(frame, start, 16);
