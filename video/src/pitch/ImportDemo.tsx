import { AbsoluteFill, useCurrentFrame } from "remotion";
import { desk, fontMono, fontUi, web } from "../theme";
import type { Note } from "../timeline";
import { Caption, DarkBackdrop, Notes, Tag, fontSerif, glow, progress, usePop } from "../ui";
import { Check, Cursor, DeskWindow, Points, crossfade, type CursorStop } from "./parts";
import { IMPORT, IMPORT_POINTS, PITCH_SCENES } from "./timeline";

// Desktop の「履歴から地図を作る」（apps/desktop/src/renderer/index.html の #import と
// history.js）を、文言と手順をそのままに再現する。件数は説明用の値で、実データではない。

const WIN = { left: 60, top: 50, width: 1180, height: 790 };
const BODY_TOP = WIN.top + 60;
const BODY_H = WIN.height - 60;
/** 右から出るシート（.import-panel）。画面上の絶対座標で持ち、カーソルの行き先と揃える */
const SHEET = { left: WIN.left + WIN.width - 660, top: BODY_TOP, width: 660, height: BODY_H };
const PAD = 40;
const ACTION_Y = SHEET.top + SHEET.height - 74;
const PRIMARY = { x: SHEET.left + SHEET.width - PAD - 125, y: ACTION_Y + 24 };
const OPEN_BUTTON = { x: WIN.left + 110, y: BODY_TOP + BODY_H - 62 };

const SOURCES = [
  { label: "Claude Code", count: 342 },
  { label: "Codex", count: 128 },
  { label: "VS Code", count: 57 },
];
const FILE_ROW_Y = SHEET.top + 300;

const CONCEPTS = [
  { label: "エラー処理", count: 64, from: "Claude Code 41件・VS Code 23件" },
  { label: "goroutine", count: 48, from: "Claude Code 30件・Codex 18件" },
  { label: "チャネル", count: 31, from: "Claude Code 22件・Codex 9件" },
  { label: "インターフェース", count: 22, from: "Codex 22件" },
  { label: "型の絞り込み", count: 19, from: "Claude 19件" },
  { label: "context", count: 12, from: "Claude Code 12件" },
];
const UNCHECKED = 5;
const CONCEPT_TOP = SHEET.top + 190;
const CONCEPT_ROW = 54;

const NOTES: Note[] = [
  { start: 0, text: "これまで Claude や Codex に聞いてきたことを、地図の出発点にする" },
  { start: IMPORT.open, text: "① 「履歴から地図を作る」を押す" },
  { start: IMPORT.pickFile, text: "② 見つかった履歴と、エクスポートファイルを選ぶ" },
  { start: IMPORT.run, text: "③ 端末の中で、過去の学習を読み解く" },
  { start: IMPORT.result, text: "④ 見つかった概念を確かめて、地図に適用" },
  { start: IMPORT.map, text: "⑤ 触れたことのある概念に「履歴あり」の印が付く" },
  { start: IMPORT.confirm, text: "⑥ 確認問題に正解して、はじめて「確認済み」になる" },
  { start: IMPORT.undo, text: "取り込みは、設定からいつでも取り消せる" },
];

const STOPS: CursorStop[] = [
  { at: IMPORT.open - 40, x: 700, y: 560 },
  { at: IMPORT.open, x: OPEN_BUTTON.x, y: OPEN_BUTTON.y, click: true },
  { at: IMPORT.pickFile, x: SHEET.left + PAD + 150, y: FILE_ROW_Y + 22, click: true },
  { at: IMPORT.run, x: PRIMARY.x, y: PRIMARY.y, click: true },
  {
    at: IMPORT.uncheck,
    x: SHEET.left + PAD + 12,
    y: CONCEPT_TOP + UNCHECKED * CONCEPT_ROW + 14,
    click: true,
  },
  { at: IMPORT.apply, x: PRIMARY.x, y: PRIMARY.y, click: true },
];

const Button = ({
  children,
  primary = false,
  style,
}: {
  children: string;
  primary?: boolean;
  style?: React.CSSProperties;
}) => (
  <span
    style={{
      padding: "10px 20px",
      borderRadius: 8,
      fontFamily: fontSerif,
      fontSize: 20,
      whiteSpace: "nowrap",
      border: primary ? "none" : `1px solid ${desk.divider}`,
      background: primary ? desk.accent : desk.neutral100,
      color: primary ? desk.bg : desk.text,
      fontWeight: primary ? 600 : 400,
      ...style,
    }}
  >
    {children}
  </span>
);

/** 取り込む前の Desktop。左の質問履歴と、下の「履歴から地図を作る」。 */
const DesktopBase = ({ frame }: { frame: number }) => {
  const press = frame >= IMPORT.open && frame < IMPORT.open + 6;
  const hint = progress(frame, IMPORT.open - 40, 10) * (1 - progress(frame, IMPORT.open + 4, 8));
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex" }}>
      <div
        style={{
          width: 330,
          background: desk.surface,
          padding: "24px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          fontFamily: fontSerif,
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
          質問履歴
        </div>
        {["この選択の意味を教えて", "このエラーの原因は？"].map((t) => (
          <div
            key={t}
            style={{ fontSize: 19, padding: "10px 12px", borderRadius: 10, color: desk.neutral700 }}
          >
            {t}
          </div>
        ))}
        <div style={{ marginTop: "auto", display: "flex", gap: 10 }}>
          <span
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              border: `1px solid ${desk.divider}`,
              background: press ? desk.accent100 : desk.bg,
              fontSize: 18,
              whiteSpace: "nowrap",
              ...glow(hint),
            }}
          >
            履歴から地図を作る
          </span>
          <span
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              border: `1px solid ${desk.divider}`,
              fontSize: 18,
              whiteSpace: "nowrap",
            }}
          >
            設定
          </span>
        </div>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          padding: 28,
        }}
      >
        <div
          style={{
            fontFamily: fontSerif,
            fontSize: 21,
            color: desk.neutral700,
            background: desk.neutral100,
            borderRadius: 10,
            padding: "14px 18px",
          }}
        >
          何を知りたいですか？
        </div>
      </div>
    </div>
  );
};

/** 取り込みのシート（#import）。手順ごとに中身を差し替える。 */
const ImportSheet = ({ frame }: { frame: number }) => {
  const enter = progress(frame, IMPORT.open + 4, 14);
  const step =
    frame < IMPORT.run + 4
      ? "sources"
      : frame < IMPORT.result
        ? "progress"
        : frame < IMPORT.apply + 4
          ? "result"
          : "applied";
  const fileOn = frame >= IMPORT.pickFile + 8;
  const analyzed = progress(
    frame,
    IMPORT.analyze.from,
    IMPORT.analyze.to - IMPORT.analyze.from,
    (t) => t,
  );
  const rel = (y: number) => y - SHEET.top;
  const kept = CONCEPTS.filter((_, i) => i !== UNCHECKED || frame < IMPORT.uncheck);
  const observations = kept.reduce((s, c) => s + c.count, 0);

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: WIN.left,
          top: BODY_TOP,
          width: WIN.width,
          height: BODY_H,
          background: "rgba(32,30,29,0.35)",
          opacity: enter,
        }}
      />
      <div
        style={{
          position: "absolute",
          ...SHEET,
          background: desk.bg,
          boxShadow: desk.shadowLg,
          transform: `translateX(${(1 - enter) * SHEET.width}px)`,
          fontFamily: fontSerif,
          fontSize: 21,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: PAD,
            right: PAD,
            top: 30,
            fontSize: 27,
            fontWeight: 600,
            lineHeight: 1.4,
          }}
        >
          これまでの学習から Learning Map を作ります
        </div>

        {step === "sources" && (
          <>
            <div style={{ position: "absolute", left: PAD, top: 110 }}>
              このPCで見つかった学習履歴
            </div>
            {SOURCES.map((s, i) => (
              <div
                key={s.label}
                style={{
                  position: "absolute",
                  left: PAD,
                  top: 156 + i * 44,
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  opacity: progress(frame, IMPORT.sources[i], 8),
                }}
              >
                <Check on />✓ {s.label}（{s.count}件）
              </div>
            ))}
            <div
              style={{
                position: "absolute",
                left: PAD,
                right: PAD,
                top: rel(FILE_ROW_Y),
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontSize: 18,
              }}
            >
              <Button>エクスポートファイルを選ぶ</Button>
              {fileOn && (
                <>
                  <span
                    style={{
                      padding: "8px 12px",
                      borderRadius: 6,
                      border: `1px solid ${desk.divider}`,
                      background: "#fff",
                      opacity: progress(frame, IMPORT.pickFile + 8, 8),
                    }}
                  >
                    Claude エクスポート ▾
                  </span>
                  <span
                    style={{
                      color: desk.neutral700,
                      fontFamily: fontMono,
                      fontSize: 17,
                      opacity: progress(frame, IMPORT.pickFile + 14, 8),
                    }}
                  >
                    conversations.json
                  </span>
                </>
              )}
            </div>
            <div
              style={{
                position: "absolute",
                left: PAD,
                right: PAD,
                top: rel(FILE_ROW_Y) + 80,
                fontSize: 18,
                color: desk.neutral700,
                opacity: progress(frame, IMPORT.analyzers, 10),
              }}
            >
              分析に使えるもの: ✓ Codex CLI ✓ Claude CLI ✓ Managed AI
            </div>
          </>
        )}

        {step === "progress" && (
          <>
            <div style={{ position: "absolute", left: PAD, top: 110 }}>
              過去の学習を読み解いています
            </div>
            {[...SOURCES.map((s) => s.label), "Claude"].map((label, i) => {
              const done = analyzed > (i + 1) / 4;
              return (
                <div
                  key={label}
                  style={{
                    position: "absolute",
                    left: PAD,
                    top: 160 + i * 44,
                    color: desk.neutral700,
                  }}
                >
                  {label} {done ? "✓" : analyzed > i / 4 ? "analyzing..." : ""}
                </div>
              );
            })}
            <div
              style={{
                position: "absolute",
                left: PAD,
                right: PAD,
                top: 360,
                height: 10,
                borderRadius: 5,
                background: "#e2e0e0",
                overflow: "hidden",
              }}
            >
              <div
                style={{ width: `${analyzed * 100}%`, height: "100%", background: desk.accent }}
              />
            </div>
            <div
              style={{
                position: "absolute",
                left: PAD,
                right: PAD,
                top: 400,
                fontSize: 18,
                color: desk.neutral700,
                lineHeight: 1.7,
              }}
            >
              <div style={{ opacity: progress(frame, IMPORT_POINTS[2].start, 10) }}>
                前処理で除去: メールアドレス・トークン・ローカルのパス
              </div>
              <div style={{ opacity: progress(frame, IMPORT_POINTS[3].start, 10) }}>
                ローカルルールで分類 → 残りを Claude CLI で分析
              </div>
            </div>
          </>
        )}

        {(step === "result" || step === "applied") && (
          <>
            <div style={{ position: "absolute", left: PAD, right: PAD, top: 110, lineHeight: 1.5 }}>
              {step === "applied"
                ? `${observations.toLocaleString()} 件の観測を Learning Map に適用しました。`
                : `527 件の会話から ${observations.toLocaleString()} 件の Concept 観測を見つけました。`}
            </div>
            {CONCEPTS.map((c, i) => {
              const on = i !== UNCHECKED || frame < IMPORT.uncheck;
              return (
                <div
                  key={c.label}
                  style={{
                    position: "absolute",
                    left: PAD,
                    right: PAD,
                    top: CONCEPT_TOP - SHEET.top + i * CONCEPT_ROW,
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    fontSize: 19,
                    opacity: progress(frame, IMPORT.result + 4 + i * 4, 8) * (on ? 1 : 0.5),
                  }}
                >
                  <Check on={on} />
                  <span>
                    {c.label} — {c.count}件
                    <span style={{ color: desk.neutral700 }}>（{c.from}）</span>
                  </span>
                </div>
              );
            })}
          </>
        )}

        <div
          style={{
            position: "absolute",
            right: PAD,
            top: rel(ACTION_Y),
            display: "flex",
            gap: 12,
          }}
        >
          <Button>閉じる</Button>
          <Button primary style={{ width: 250, textAlign: "center" }}>
            {step === "sources"
              ? "Learning Map を作る"
              : step === "applied"
                ? "この Import を取り消す"
                : "地図に適用"}
          </Button>
        </div>
      </div>
    </>
  );
};

// ---- 取り込んだあとの Web の学習マップ ----

type MapNode = {
  name: string;
  c: number;
  r: number;
  base: "confirmed" | "unobserved";
  familiar?: boolean;
  /** 確認問題で確認済みに変わるノード */
  confirms?: boolean;
};
const MAP_NODES: MapNode[] = [
  { name: "変数と型", c: 0, r: 0, base: "confirmed" },
  { name: "関数", c: 0, r: 2, base: "confirmed" },
  { name: "構造体", c: 1, r: 0, base: "unobserved" },
  { name: "エラー処理", c: 1, r: 2, base: "unobserved", familiar: true, confirms: true },
  { name: "インターフェース", c: 2, r: 0, base: "unobserved", familiar: true },
  { name: "goroutine", c: 2, r: 2, base: "unobserved", familiar: true },
  { name: "チャネル", c: 3, r: 1, base: "unobserved", familiar: true },
  { name: "context", c: 3, r: 3, base: "unobserved" },
];
const MAP_EDGES: [number, number][] = [
  [0, 2],
  [1, 2],
  [1, 3],
  [2, 4],
  [2, 5],
  [5, 6],
  [5, 7],
  [4, 6],
];
const NW = 236;
const NH = 84;
const nx = (c: number) => 40 + c * 272;
const ny = (r: number) => 30 + r * 120;

const WebMap = ({ frame }: { frame: number }) => {
  const familiarNodes = MAP_NODES.filter((n) => n.familiar);
  const toast = progress(frame, IMPORT.confirm, 12) * (1 - progress(frame, IMPORT.undo - 10, 10));
  const confirmed = frame >= IMPORT.confirm + 6;
  return (
    <div
      style={{
        position: "absolute",
        ...WIN,
        borderRadius: 14,
        overflow: "hidden",
        background: web.bg,
        color: web.ink,
        fontFamily: fontUi,
        boxShadow: "0 40px 90px rgba(2,6,23,0.6)",
      }}
    >
      <div
        style={{
          height: 76,
          background: web.header,
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 36px",
          fontSize: 22,
        }}
      >
        <span style={{ fontWeight: 700 }}>
          学習装置 <small style={{ opacity: 0.65, fontWeight: 400 }}>Learning Map</small>
        </span>
        <span style={{ display: "flex", gap: 24, color: web.headerText }}>
          <span
            style={{ color: "#fff", borderBottom: `3px solid ${web.solved}`, paddingBottom: 4 }}
          >
            マップ
          </span>
          <span>推移</span>
          <span>設定</span>
        </span>
      </div>
      <div style={{ padding: "26px 36px 0", display: "flex", alignItems: "baseline", gap: 18 }}>
        <span style={{ fontSize: 30, fontWeight: 700 }}>Go の学習マップ</span>
        <span style={{ fontSize: 19, color: web.muted }}>
          <em className="familiar" style={chipStyle}>
            履歴あり
          </em>{" "}
          ＝ 過去に触れた形跡。理解度には数えない
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 36,
          right: 36,
          top: 150,
          bottom: 30,
          background: web.surface,
          borderRadius: 14,
        }}
      >
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
          {MAP_EDGES.map(([a, b]) => {
            const A = MAP_NODES[a];
            const B = MAP_NODES[b];
            const x1 = nx(A.c) + NW;
            const y1 = ny(A.r) + NH / 2;
            const x2 = nx(B.c);
            const y2 = ny(B.r) + NH / 2;
            const mx = (x1 + x2) / 2;
            return (
              <path
                key={`${a}-${b}`}
                d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`}
                fill="none"
                stroke={web.unobservedBorder}
                strokeWidth={2}
              />
            );
          })}
        </svg>
        {MAP_NODES.map((n) => {
          const fi = familiarNodes.indexOf(n);
          const chipAt = IMPORT.chips + fi * 10;
          const chip = n.familiar ? progress(frame, chipAt, 10) : 0;
          const isConfirmed = n.base === "confirmed" || (n.confirms && confirmed);
          const flash = n.confirms
            ? progress(frame, IMPORT.confirm, 10) * (1 - progress(frame, IMPORT.confirm + 30, 20))
            : 0;
          const s = isConfirmed
            ? { background: web.confirmedBg, borderColor: web.confirmed, color: web.confirmedText }
            : { background: web.unobservedBg, borderColor: web.unobservedBorder, color: web.muted };
          return (
            <div
              key={n.name}
              style={{
                position: "absolute",
                left: nx(n.c),
                top: ny(n.r),
                width: NW,
                height: NH,
                boxSizing: "border-box",
                borderRadius: 12,
                border: `2.5px solid ${s.borderColor}`,
                background: s.background,
                color: s.color,
                padding: "10px 16px",
                ...glow(
                  Math.max(
                    flash,
                    n.familiar && !isConfirmed ? chip * (1 - progress(frame, chipAt + 14, 16)) : 0,
                  ),
                  n.confirms && flash > 0 ? web.confirmed : "#2dd4bf",
                ),
              }}
            >
              <div style={{ fontSize: 22, fontWeight: 700, whiteSpace: "nowrap" }}>
                {isConfirmed && "✓ "}
                {n.name}
              </div>
              <div
                style={{
                  fontSize: 16,
                  marginTop: 4,
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                {isConfirmed ? "確認済み" : "未観測"}
                {n.familiar && !isConfirmed && chip > 0 && (
                  <em
                    style={{
                      ...chipStyle,
                      opacity: chip,
                      transform: `scale(${0.6 + chip * 0.4})`,
                    }}
                  >
                    履歴あり
                  </em>
                )}
              </div>
            </div>
          );
        })}
        {toast > 0 && (
          <div
            style={{
              position: "absolute",
              left: nx(1) - 20,
              top: ny(3) + 10,
              padding: "14px 22px",
              borderRadius: 12,
              background: web.header,
              color: "#fff",
              fontSize: 20,
              fontWeight: 700,
              opacity: toast,
              transform: `translateY(${(1 - toast) * 16}px)`,
            }}
          >
            エラー処理: 確認問題に正解 → <span style={{ color: "#6ee7b7" }}>確認済み</span>
          </div>
        )}
      </div>
    </div>
  );
};

const chipStyle: React.CSSProperties = {
  fontStyle: "normal",
  padding: "1px 10px",
  borderRadius: 999,
  background: "#ccfbf1",
  color: "#0f766e",
  fontSize: 15,
  fontWeight: 700,
  display: "inline-block",
};

export const ImportDemo = () => {
  const frame = useCurrentFrame();
  const enter = progress(frame, 0, 14);
  const toMap = crossfade(frame, IMPORT.map, 14);
  const pop = usePop(IMPORT.map, 14);
  const D = PITCH_SCENES.importDemo.duration;

  return (
    <AbsoluteFill>
      <DarkBackdrop />
      {toMap < 1 && (
        <AbsoluteFill
          style={{ opacity: enter * (1 - toMap), transform: `translateY(${(1 - enter) * 40}px)` }}
        >
          <DeskWindow style={WIN}>
            <DesktopBase frame={frame} />
          </DeskWindow>
          {frame >= IMPORT.open + 4 && <ImportSheet frame={frame} />}
        </AbsoluteFill>
      )}
      {toMap > 0 && (
        <AbsoluteFill style={{ opacity: toMap, transform: `scale(${0.96 + pop * 0.04})` }}>
          <WebMap frame={frame} />
        </AbsoluteFill>
      )}
      <Cursor stops={STOPS} hideAt={IMPORT.map} />

      <Points points={IMPORT_POINTS} style={{ left: 1300, top: 70, width: 580 }} />

      <Caption
        lines={["普段使っている AI の履歴から、地図を作る。"]}
        start={4}
        size={58}
        style={{ left: 70, top: 870 }}
      />
      <Notes notes={NOTES} size={32} style={{ left: 108, top: 966 }} />
      <Tag start={10} style={{ right: 60, top: 884 }}>
        {frame < IMPORT.map ? "Desktop　デモ" : "Web　学習マップ"}
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
        ※ 画面は実装の文言と手順をもとに再現したもの。件数は説明用
      </div>
    </AbsoluteFill>
  );
};
