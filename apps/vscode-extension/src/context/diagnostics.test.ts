import { expect, test } from "vitest";
import { rangesOverlap } from "./diagnostics";

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
