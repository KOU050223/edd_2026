import { expect, test } from "vitest";
import {
  DiagnosticSeverityValue,
  diagnosticCodeOfKey,
  errorKeyOf,
  isErrorLikeSeverity,
  normalizeDiagnosticMessage,
  rangesOverlap,
} from "./diagnostics";

const range = (
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
) => ({
  start: { line: startLine, character: startCharacter },
  end: { line: endLine, character: endCharacter },
});

test("選択範囲と実際に重なるDiagnosticsだけを採用する", () => {
  const selection = range(10, 3, 10, 8);

  expect(rangesOverlap(selection, range(10, 4, 10, 7))).toBe(true);
  expect(rangesOverlap(selection, range(10, 8, 10, 12))).toBe(false);
  expect(rangesOverlap(selection, range(9, 0, 11, 0))).toBe(true);
});

test("ErrorとWarningだけをエラーとしてAIへ渡す", () => {
  expect(isErrorLikeSeverity(DiagnosticSeverityValue.Error)).toBe(true);
  expect(isErrorLikeSeverity(DiagnosticSeverityValue.Warning)).toBe(true);
  // 未使用変数などの Hint で Error Explain に切り替えない（#161）。
  expect(isErrorLikeSeverity(DiagnosticSeverityValue.Information)).toBe(false);
  expect(isErrorLikeSeverity(DiagnosticSeverityValue.Hint)).toBe(false);
});

test("長さ0のDiagnosticは、その位置が選択範囲の内側にあれば採用する", () => {
  const selection = range(10, 3, 10, 8);

  expect(rangesOverlap(range(10, 5, 10, 5), selection)).toBe(true);
  expect(rangesOverlap(selection, range(10, 5, 10, 5))).toBe(true);
});

test("長さ0のDiagnosticは、選択範囲の外にあれば採用しない", () => {
  const selection = range(10, 3, 10, 8);

  expect(rangesOverlap(range(10, 2, 10, 2), selection)).toBe(false);
  expect(rangesOverlap(range(10, 9, 10, 9), selection)).toBe(false);
  expect(rangesOverlap(range(11, 0, 11, 0), selection)).toBe(false);
});

test("長さ0のDiagnosticは、選択範囲の両端にあっても採用する", () => {
  // 行末の「; が必要」のような位置は、選択の終端にちょうど来やすい。
  const selection = range(10, 3, 10, 8);

  expect(rangesOverlap(range(10, 3, 10, 3), selection)).toBe(true);
  expect(rangesOverlap(range(10, 8, 10, 8), selection)).toBe(true);
});

test("codeがあればsourceと組にして識別し、メッセージの違いは無視する", () => {
  const first = errorKeyOf({
    source: "ts",
    code: 2345,
    message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
  });
  const second = errorKeyOf({
    source: "ts",
    code: 2345,
    message: "Argument of type 'boolean' is not assignable to parameter of type 'User'.",
  });

  expect(first).toBe("code:ts:2345");
  expect(second).toBe(first);
});

test("同じcodeでもsourceが違えば別のエラーとして扱う", () => {
  expect(errorKeyOf({ source: "ts", code: "1", message: "a" })).not.toBe(
    errorKeyOf({ source: "eslint", code: "1", message: "a" }),
  );
});

test("targetつきのcodeはvalueを使う", () => {
  expect(errorKeyOf({ source: "eslint", code: { value: "no-unused-vars" }, message: "x" })).toBe(
    "code:eslint:no-unused-vars",
  );
});

test("codeが無ければ正規化したメッセージで識別する", () => {
  const first = errorKeyOf({ source: "go", message: "undefined: userName (line 12)" });
  const moved = errorKeyOf({ source: "go", message: "undefined: userName  (line 40)" });
  const other = errorKeyOf({ source: "go", message: "missing return" });

  expect(moved).toBe(first);
  expect(other).not.toBe(first);
});

test("引用された識別子と数値をプレースホルダへ置き換える", () => {
  expect(normalizeDiagnosticMessage("Cannot find name 'foo'. Did you mean \"bar\"? (3)")).toBe(
    "Cannot find name _. Did you mean _? (#)",
  );
});

test("サーバーへ送る診断コードはcode由来のキーだけに限る", () => {
  expect(diagnosticCodeOfKey("code:ts:2345")).toBe("ts:2345");
  expect(diagnosticCodeOfKey("message:go:missing return")).toBeUndefined();
});

test("APIの上限を超える診断コードは送らない", () => {
  // 付けるとイベントごと拒否され、再発の記録がサーバーへ届かなくなる。
  expect(diagnosticCodeOfKey(`code:eslint:${"x".repeat(128)}`)).toBeUndefined();
});
