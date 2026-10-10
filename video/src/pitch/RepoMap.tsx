import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { fontMono, fontUi, web } from "../theme";
import type { Note } from "../timeline";
import { Caption, DarkBackdrop, Notes, Tag, easeInOut, progress, streamed, usePop } from "../ui";
import { Cursor, Points, crossfade, type CursorStop } from "./parts";
import { PITCH_SCENES, REPO, REPO_POINTS } from "./timeline";

// Issue #249（開発中）。画面はまだ無いので、Issue に書かれた手順と
// スパイクの結果（コメント 2026-10-10）をもとに描く。用語と根拠は説明用の例。

const CARD = { left: 60, top: 50, width: 1180, height: 790 };
const URL = "github.com/RailsEventStore/ecommerce";
const SUBMIT = { x: CARD.left + 160, y: CARD.top + 527 };

const BINS = [
  { label: "用語集・文書", hint: "README・docs", color: "#14b8a6" },
  { label: "データの形", hint: "db/schema.rb", color: "#2563eb" },
  { label: "コード候補", hint: "domain・models", color: "#f59e0b" },
  { label: "その他", hint: "件数だけ数える", color: "#94a3b8" },
  { label: "捨てる", hint: "生成物・依存・画像", color: "#ef4444" },
];
// 振り分けの割合（説明用）。ドットの数で見せる
const DOTS = Array.from({ length: 140 }, (_, i) => {
  const r = (i * 37) % 140;
  const bin = r < 10 ? 0 : r < 13 ? 1 : r < 45 ? 2 : r < 80 ? 3 : 4;
  return { i, bin };
});

const TERMS = [
  { name: "注文", raw: "Order", from: ["ordering/", "README"] },
  { name: "価格設定", raw: "Pricing", from: ["pricing/", "Issue"] },
  { name: "決済", raw: "Payment", from: ["payments/"] },
  { name: "配送", raw: "Shipment", from: ["shipping/", "db/schema.rb"] },
  { name: "請求書", raw: "Invoice", from: ["invoicing/"] },
  { name: "投稿", raw: "Post", from: ["apps/twitter/"], reject: true },
];
const TERM_TOP = CARD.top + 230;
const TERM_ROW = 72;
const REJECT_INDEX = TERMS.findIndex((t) => t.reject);
const REJECT_BUTTON = {
  x: CARD.left + CARD.width - 110,
  y: TERM_TOP + REJECT_INDEX * TERM_ROW + 26,
};

const STOPS: CursorStop[] = [
  { at: REPO.type + 20, x: 900, y: 700 },
  { at: REPO.submit, x: SUBMIT.x, y: SUBMIT.y, click: true },
  { at: REPO.reject - 30, x: 800, y: 760 },
  { at: REPO.reject, x: REJECT_BUTTON.x, y: REJECT_BUTTON.y, click: true },
];

const NOTES: Note[] = [
  { start: 0, text: "新しく入ったプロジェクトの「言葉」と、そのつながりを学べるように" },
  { start: REPO.classify, text: "全ファイルを AI に渡すと高くつく。まず名前と場所で振り分ける" },
  { start: REPO.narrow, text: "AI が読むのは、絞り込んだ材料の要約だけ" },
  { start: REPO.candidates, text: "出てきた用語の候補を、作成者が採用・却下して確定する" },
  { start: REPO.reject, text: "別のアプリの用語が混ざったら、根拠を見て外せる" },
];

const WebHeader = () => (
  <div
    style={{
      height: 76,
      background: web.header,
      color: "#fff",
      display: "flex",
      alignItems: "center",
      padding: "0 36px",
      fontSize: 22,
    }}
  >
    <span style={{ fontWeight: 700 }}>
      学習装置 <small style={{ opacity: 0.65, fontWeight: 400 }}>Learning Map</small>
    </span>
  </div>
);

const Field = ({ label, value, caret }: { label: string; value: string; caret?: boolean }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
    <span style={{ fontSize: 21, fontWeight: 700 }}>{label}</span>
    <span
      style={{
        height: 58,
        borderRadius: 10,
        border: `2px solid ${caret ? web.primary : web.border}`,
        background: "#fff",
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        fontFamily: fontMono,
        fontSize: 22,
        color: value ? web.ink : web.muted,
      }}
    >
      {value || "すべて（任意で絞り込む）"}
      {caret && <span style={{ width: 2, height: 28, background: web.ink, marginLeft: 2 }} />}
    </span>
  </div>
);

const Form = ({ frame }: { frame: number }) => {
  const typed = streamed(URL, frame, REPO.type, 1.4);
  const pressed = frame >= REPO.submit && frame < REPO.submit + 6;
  return (
    <div style={{ padding: "40px 60px", display: "flex", flexDirection: "column", gap: 30 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <span style={{ fontSize: 34, fontWeight: 800 }}>リポジトリから地図を作る</span>
        <span
          style={{
            fontSize: 18,
            padding: "4px 14px",
            borderRadius: 999,
            background: web.learningBg,
            color: web.learningText,
            fontWeight: 700,
          }}
        >
          開発中（#249）
        </span>
      </div>
      <Field label="GitHub のリポジトリ" value={typed} caret={frame < REPO.submit} />
      <Field label="対象のフォルダ" value="" />
      <span style={{ fontSize: 18, color: web.muted }}>
        公開リポジトリの README・ドキュメント・一部のコード・Issue を AI に送ります。
      </span>
      <span
        style={{
          alignSelf: "flex-start",
          padding: "14px 30px",
          borderRadius: 10,
          background: pressed ? "#115e59" : web.primary,
          color: "#fff",
          fontSize: 22,
          fontWeight: 700,
        }}
      >
        下書きを作る
      </span>
    </div>
  );
};

/** ファイル一覧を、中身を読まずに振り分ける → AI に渡すものへ絞る。 */
const Funnel = ({ frame }: { frame: number }) => {
  const sort = progress(frame, REPO.classify + 40, 50, easeInOut);
  const narrow = progress(frame, REPO.narrow, 18);
  const binW = 196;
  const binX = (b: number) => 60 + b * (binW + 16);
  const binY = 330;
  const perBin = BINS.map(() => 0);
  return (
    <div style={{ position: "absolute", inset: 0, top: 76 }}>
      <div style={{ position: "absolute", left: 60, top: 30, fontSize: 26, fontWeight: 800 }}>
        ① ファイル一覧を振り分ける
        <span style={{ fontSize: 19, color: web.muted, fontWeight: 600, marginLeft: 16 }}>
          パス・名前・サイズだけ。中身は読まない
        </span>
      </div>
      {DOTS.map((d) => {
        const k = perBin[d.bin]++;
        const gx = 60 + (d.i % 35) * 30;
        const gy = 100 + Math.floor(d.i / 35) * 30;
        const bx = binX(d.bin) + 16 + (k % 8) * 21;
        const by = binY + 80 + Math.floor(k / 8) * 21;
        const appear = progress(frame, REPO.classify + (d.i % 35) * 0.6, 10);
        const fadeTrash = d.bin >= 3 ? narrow * 0.75 : 0;
        return (
          <span
            key={d.i}
            style={{
              position: "absolute",
              left: interpolate(sort, [0, 1], [gx, bx]),
              top: interpolate(sort, [0, 1], [gy, by]),
              width: 14,
              height: 14,
              borderRadius: 4,
              background: sort > 0.4 ? BINS[d.bin].color : "#cbd5e1",
              opacity: appear * (1 - fadeTrash),
            }}
          />
        );
      })}
      {BINS.map((b, i) => (
        <div
          key={b.label}
          style={{
            position: "absolute",
            left: binX(i),
            top: binY,
            width: binW,
            height: 250,
            borderRadius: 12,
            border: `2px solid ${b.color}`,
            padding: "10px 14px",
            boxSizing: "border-box",
            opacity: progress(frame, REPO.classify + 30, 12) * (i >= 3 ? 1 - narrow * 0.6 : 1),
          }}
        >
          <div style={{ fontSize: 21, fontWeight: 800, color: b.color }}>{b.label}</div>
          <div style={{ fontSize: 15, color: web.muted }}>{b.hint}</div>
        </div>
      ))}
      <div
        style={{
          position: "absolute",
          left: 60,
          top: 610,
          right: 60,
          display: "flex",
          alignItems: "center",
          gap: 16,
          opacity: narrow,
          transform: `translateY(${(1 - narrow) * 20}px)`,
        }}
      >
        <span style={{ fontSize: 22, fontWeight: 800, whiteSpace: "nowrap" }}>② AI へ</span>
        {["README・docs の要約", "中心のコード 5 個", "Issue 5 件"].map((t) => (
          <span
            key={t}
            style={{
              padding: "12px 18px",
              borderRadius: 10,
              background: web.hintBg,
              color: web.hintText,
              fontSize: 21,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            {t}
          </span>
        ))}
        <span style={{ fontSize: 22, fontWeight: 800, whiteSpace: "nowrap" }}>→ 用語の候補</span>
      </div>
    </div>
  );
};

const Candidates = ({ frame }: { frame: number }) => {
  const rejected = frame >= REPO.reject + 4;
  return (
    <div style={{ position: "absolute", inset: 0, top: 76, padding: "34px 60px" }}>
      <div style={{ fontSize: 28, fontWeight: 800 }}>
        ③ 用語の候補（下書き）
        <span style={{ fontSize: 19, color: web.muted, fontWeight: 600, marginLeft: 16 }}>
          確定するまでは作成者だけが見られる
        </span>
      </div>
      {TERMS.map((t, i) => {
        const off = t.reject && rejected;
        return (
          <div
            key={t.raw}
            style={{
              position: "absolute",
              left: 60,
              right: 60,
              top: TERM_TOP - CARD.top - 76 + i * TERM_ROW,
              height: 58,
              borderRadius: 12,
              background: off ? web.track : web.surface,
              border: `1.5px solid ${web.border}`,
              display: "flex",
              alignItems: "center",
              gap: 16,
              padding: "0 18px",
              opacity: progress(frame, REPO.candidates + 6 + i * 5, 10) * (off ? 0.55 : 1),
            }}
          >
            <span
              style={{
                fontSize: 23,
                fontWeight: 800,
                width: 280,
                textDecoration: off ? "line-through" : undefined,
              }}
            >
              {t.name}
              <span
                style={{ fontFamily: fontMono, fontWeight: 400, color: web.muted, fontSize: 20 }}
              >
                （{t.raw}）
              </span>
            </span>
            {t.from.map((f) => (
              <span
                key={f}
                style={{
                  fontFamily: fontMono,
                  fontSize: 16,
                  padding: "3px 10px",
                  borderRadius: 6,
                  background: web.chip,
                  color: web.chipText,
                }}
              >
                {f} ↗
              </span>
            ))}
            <span
              style={{
                marginLeft: "auto",
                display: "flex",
                gap: 10,
                fontSize: 18,
                fontWeight: 700,
              }}
            >
              <span
                style={{
                  padding: "6px 14px",
                  borderRadius: 8,
                  background: off ? web.track : web.confirmedBg,
                  color: web.confirmedText,
                }}
              >
                採用
              </span>
              <span
                style={{
                  padding: "6px 14px",
                  borderRadius: 8,
                  background: off ? "#fee2e2" : web.track,
                  color: off ? "#b91c1c" : web.muted,
                }}
              >
                却下
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
};

const Stats = ({ frame }: { frame: number }) => {
  const pop = usePop(REPO.stats, 13);
  if (frame < REPO.stats) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: CARD.left + 190,
        top: CARD.top + 170,
        width: 800,
        padding: "40px 50px",
        borderRadius: 20,
        background: web.header,
        color: "#fff",
        fontFamily: fontUi,
        boxShadow: "0 30px 80px rgba(2,6,23,0.55)",
        transform: `scale(${0.7 + pop * 0.3})`,
        opacity: Math.min(1, pop * 1.5),
      }}
    >
      <div style={{ fontSize: 24, color: "#94a3b8", fontWeight: 700 }}>1 マップあたり（実測）</div>
      <div style={{ fontSize: 76, fontWeight: 800, margin: "8px 0", letterSpacing: "0.01em" }}>
        約 1 万 tokens
      </div>
      <div style={{ fontSize: 30, fontWeight: 700, color: "#6ee7b7" }}>
        8,000〜17,000 tokens ／ 約 $0.01
      </div>
      <div style={{ fontSize: 20, color: "#94a3b8", marginTop: 16 }}>
        公開リポジトリ 4 つで実測。当初の見積もりの 1/10 以下
      </div>
    </div>
  );
};

export const RepoMap = () => {
  const frame = useCurrentFrame();
  const D = PITCH_SCENES.repoMap.duration;
  const enter = progress(frame, 0, 14);
  const toFunnel = crossfade(frame, REPO.classify, 10);
  const toTerms = crossfade(frame, REPO.candidates, 10);
  return (
    <AbsoluteFill>
      <DarkBackdrop />
      <div
        style={{
          position: "absolute",
          ...CARD,
          borderRadius: 14,
          overflow: "hidden",
          background: web.bg,
          color: web.ink,
          fontFamily: fontUi,
          boxShadow: "0 40px 90px rgba(2,6,23,0.6)",
          opacity: enter,
          transform: `translateY(${(1 - enter) * 40}px)`,
        }}
      >
        <WebHeader />
        {toFunnel < 1 && (
          <div style={{ position: "absolute", inset: 0, top: 76, opacity: 1 - toFunnel }}>
            <Form frame={frame} />
          </div>
        )}
        {toFunnel > 0 && toTerms < 1 && (
          <div style={{ position: "absolute", inset: 0, opacity: toFunnel * (1 - toTerms) }}>
            <Funnel frame={frame} />
          </div>
        )}
        {toTerms > 0 && (
          <div style={{ position: "absolute", inset: 0, opacity: toTerms }}>
            <Candidates frame={frame} />
          </div>
        )}
      </div>
      <Stats frame={frame} />
      <Cursor stops={STOPS} hideAt={REPO.stats} />

      <Points points={REPO_POINTS} style={{ left: 1300, top: 70, width: 580 }} />
      <Caption
        lines={["GitHub のリポジトリから、地図を作る。"]}
        start={4}
        size={58}
        style={{ left: 70, top: 870 }}
      />
      <Notes notes={NOTES} size={32} style={{ left: 108, top: 966 }} />
      <Tag start={10} style={{ right: 60, top: 884 }}>
        開発中　Issue #249
      </Tag>
      <div
        style={{
          position: "absolute",
          right: 60,
          bottom: 22,
          fontFamily: fontUi,
          fontSize: 17,
          color: "#64748b",
          opacity: progress(frame, 0, 20) * (1 - progress(frame, D - 10, 10)),
        }}
      >
        ※ 画面は Issue の設計をもとに描いたイメージ。用語は例
      </div>
    </AbsoluteFill>
  );
};
