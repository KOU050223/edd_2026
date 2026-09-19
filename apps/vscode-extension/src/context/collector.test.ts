import { expect, test, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { collectFromText } from "./collector";

test("ターミナル入力は言語やファイルを推測せずに質問文脈へ渡す", () => {
  expect(collectFromText("go run main.go", "terminal")).toEqual({
    code: "go run main.go",
    source: "terminal",
    contextLevel: 1,
    surroundingCode: "",
  });
});

test("クリップボード入力は出所を推測せずに質問文脈へ渡す", () => {
  expect(collectFromText("const value = 1", "clipboard")).toEqual({
    code: "const value = 1",
    source: "clipboard",
    contextLevel: 1,
    surroundingCode: "",
  });
});
