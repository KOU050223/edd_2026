import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { brand, fontUi, web } from "../theme";
import { LOGO } from "../timeline";
import { Flash, fontRounded, progress, usePop } from "../ui";

const TITLE = "がくしゅうそうち";
const ICON = 260;
const TITLE_SIZE = 104;
const ROW_W = ICON + 56 + TITLE.length * TITLE_SIZE;
const ROW_LEFT = (1920 - ROW_W) / 2;
const ROW_TOP = 250;

// アイコンが出た瞬間に飛び散る粒。色はアイコンの 3 つの玉から取る。
const PARTICLES = Array.from({ length: 18 }, (_, i) => ({
  angle: (i / 18) * Math.PI * 2 + (i % 3) * 0.2,
  dist: 190 + (i % 4) * 45,
  size: 10 + (i % 3) * 6,
  color: [brand.blue, brand.green, brand.orange][i % 3],
}));

export const Logo = () => {
  const frame = useCurrentFrame();
  const icon = usePop(LOGO.icon, 9);
  const burst = progress(frame, LOGO.icon, 28);
  const latin = progress(frame, LOGO.title + 10, 16);
  const copy = progress(frame, LOGO.copy, 18);
  const url = progress(frame, LOGO.url, 14);
  const cx = ROW_LEFT + ICON / 2;
  const cy = ROW_TOP + ICON / 2;
  const float = Math.sin(frame / 12) * 4;

  return (
    <AbsoluteFill
      style={{ background: `radial-gradient(1100px 700px at 50% 40%, #ffffff 0%, ${web.bg} 70%)` }}
    >
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            left: cx + Math.cos(p.angle) * p.dist * burst - p.size / 2,
            top: cy + Math.sin(p.angle) * p.dist * burst - p.size / 2,
            width: p.size,
            height: p.size,
            borderRadius: p.size,
            background: p.color,
            opacity: burst > 0 ? 1 - burst : 0,
          }}
        />
      ))}
      <Img
        src={staticFile("icon.png")}
        style={{
          position: "absolute",
          left: ROW_LEFT,
          top: ROW_TOP + float,
          width: ICON,
          height: ICON,
          transform: `scale(${icon}) rotate(${(1 - icon) * -25}deg)`,
        }}
      />
      <div style={{ position: "absolute", left: ROW_LEFT + ICON + 56, top: ROW_TOP + 40 }}>
        <div
          style={{
            fontFamily: fontRounded,
            fontWeight: 800,
            fontSize: TITLE_SIZE,
            color: brand.navy,
            lineHeight: 1.1,
            whiteSpace: "nowrap",
          }}
        >
          {[...TITLE].map((c, i) => {
            const p = progress(frame, LOGO.title + i * 1.5, 12);
            const y = interpolate(p, [0, 0.6, 1], [50, -10, 0]);
            return (
              <span
                key={i}
                style={{ display: "inline-block", opacity: p, transform: `translateY(${y}px)` }}
              >
                {c}
              </span>
            );
          })}
        </div>
        <div
          style={{
            marginTop: 16,
            fontFamily: fontUi,
            fontWeight: 700,
            fontSize: 40,
            letterSpacing: `${0.2 + (1 - latin) * 0.3}em`,
            color: brand.slate,
            opacity: latin,
            paddingLeft: 8,
          }}
        >
          GAKUSHUU SOUCHI
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 640,
          textAlign: "center",
          fontFamily: fontUi,
          fontWeight: 800,
          fontSize: 76,
          color: web.header,
          clipPath: `inset(0 ${(1 - copy) * 100}% 0 0)`,
          transform: `translateY(${(1 - copy) * 16}px)`,
        }}
      >
        聞くほど、学びが<span style={{ color: web.primary }}>地図</span>になる。
      </div>

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 790,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
          opacity: url,
          transform: `translateY(${(1 - url) * 20}px)`,
          fontFamily: fontUi,
        }}
      >
        <div style={{ fontSize: 30, color: web.muted, letterSpacing: "0.08em" }}>
          VS Code · Desktop · Web
        </div>
        <div
          style={{
            fontSize: 32,
            fontWeight: 700,
            color: "#fff",
            background: web.primary,
            padding: "14px 34px",
            borderRadius: 12,
          }}
        >
          gakushu-sochi-web.uozumi05.workers.dev
        </div>
      </div>
      <Flash duration={8} />
    </AbsoluteFill>
  );
};
