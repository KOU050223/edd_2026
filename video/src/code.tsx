import type { CSSProperties } from "react";
import { fontMono } from "./theme";

// 導入と VS Code の場面で同じコードを見せる。デッドロックする最小の Go。
type Token = [text: string, color: string];

const K = "#c586c0";
const T = "#569cd6";
const F = "#dcdcaa";
const V = "#9cdcfe";
const N = "#b5cea8";
const P = "#d4d4d4";

export const CODE: Token[][] = [
  [
    ["package", K],
    [" main", P],
  ],
  [],
  [
    ["func", T],
    [" ", P],
    ["main", F],
    ["() {", P],
  ],
  [
    ["    ch", V],
    [" := ", P],
    ["make", F],
    ["(", P],
    ["chan", T],
    [" ", P],
    ["int", T],
    [")", P],
  ],
  [
    ["    ch", V],
    [" <- ", P],
    ["1", N],
  ],
  [
    ["    fmt", V],
    [".", P],
    ["Println", F],
    ["(<-", P],
    ["ch", V],
    [")", P],
  ],
  [["}", P]],
];

/** エラーの波線を引く行（0 始まり） */
export const ERROR_LINE = 4;

export const CodeLines = ({
  fontSize = 30,
  lineHeight = 1.7,
  visibleChars = Infinity,
  style,
  lineNumbers = true,
}: {
  fontSize?: number;
  lineHeight?: number;
  visibleChars?: number;
  style?: CSSProperties;
  lineNumbers?: boolean;
}) => {
  let budget = visibleChars;
  return (
    <div style={{ fontFamily: fontMono, fontSize, lineHeight, whiteSpace: "pre", ...style }}>
      {CODE.map((line, i) => (
        <div key={i} style={{ display: "flex", height: fontSize * lineHeight }}>
          {lineNumbers && (
            <span
              style={{
                width: fontSize * 2.2,
                color: "#6e7681",
                textAlign: "right",
                marginRight: fontSize,
              }}
            >
              {i + 1}
            </span>
          )}
          {line.map(([text, color], j) => {
            const shown = text.slice(0, Math.max(0, budget));
            budget -= text.length;
            return (
              <span key={j} style={{ color }}>
                {shown}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};

/** 赤い波線。progress で左から引く。 */
export const Squiggle = ({
  width,
  progress,
  style,
}: {
  width: number;
  progress: number;
  style?: CSSProperties;
}) => {
  const step = 10;
  let d = "M0 5";
  for (let x = 0; x < width; x += step) d += ` q${step / 4} -5 ${step / 2} 0 t${step / 2} 0`;
  return (
    <svg width={width} height={10} style={{ position: "absolute", overflow: "visible", ...style }}>
      <path
        d={d}
        fill="none"
        stroke="#f14c4c"
        strokeWidth={2.5}
        strokeDasharray={width * 1.6}
        strokeDashoffset={width * 1.6 * (1 - progress)}
      />
    </svg>
  );
};
