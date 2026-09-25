import type { ReactNode } from "react";
import { AbsoluteFill } from "remotion";
import { fontUi, web } from "./theme";

// Web 版の枠（apps/web/src/client/routes/_framed/route.tsx の Header）を 1.4 倍で描く。
// 実寸の 64px ヘッダーでは 1080p の画面で小さすぎて読めない。
export const S = 1.4;

export const WebFrame = ({
  active,
  children,
}: {
  active: "マップ" | "推移";
  children: ReactNode;
}) => (
  <AbsoluteFill style={{ background: web.bg, color: web.ink, fontFamily: fontUi }}>
    <div
      style={{
        height: 64 * S,
        background: web.header,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 60px",
        fontSize: 16 * S,
      }}
    >
      <span style={{ fontWeight: 700 }}>
        学習装置 <small style={{ opacity: 0.65, fontWeight: 400 }}>Learning Map</small>
      </span>
      <span style={{ display: "flex", gap: 18 * S, color: web.headerText }}>
        {["マップ", "推移", "設定", "ログアウト"].map((n) => (
          <span
            key={n}
            style={
              n === active
                ? { color: "#fff", borderBottom: `3px solid ${web.solved}`, paddingBottom: 4 }
                : undefined
            }
          >
            {n}
          </span>
        ))}
      </span>
    </div>
    <div style={{ position: "relative", flex: 1 }}>{children}</div>
  </AbsoluteFill>
);
