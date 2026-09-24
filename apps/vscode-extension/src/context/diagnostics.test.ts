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
