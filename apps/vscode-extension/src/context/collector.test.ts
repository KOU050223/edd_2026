import { expect, test, vi } from "vitest";

const { executeCommand, openTextDocument } = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  openTextDocument: vi.fn(),
}));

vi.mock("vscode", () => ({
  commands: { executeCommand },
  workspace: {
    asRelativePath: (uri: { path: string }) => uri.path,
    openTextDocument,
  },
  Position: class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  },
  Range: class Range {
    readonly start: { line: number; character: number };
    readonly end: { line: number; character: number };

    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  },
}));

import { collectFromEditor, collectFromText } from "./collector";

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

test("広い選択範囲ではimport由来の定義より本体の定義を優先する", async () => {
  const sourceUri = { path: "/workspace/main.go", toString: () => "file:///workspace/main.go" };
  const packageUri = {
    path: "/go/src/log/slog/logger.go",
    toString: () => "file:///go/src/log/slog/logger.go",
  };
  const appUri = {
    path: "/workspace/internal/app/logger.go",
    toString: () => "file:///workspace/internal/app/logger.go",
  };
  const lines = [
    'import ("context"; "log/slog")',
    "",
    "func main() {",
    "  app.SetupLogger()",
    "  app.SetupMetrics()",
    "  app.SetupTracer()",
    "}",
  ];
  const document = {
    uri: sourceUri,
    languageId: "go",
    lineCount: lines.length,
    lineAt: (line: number) => ({
      text: lines[line],
      range: { end: { character: lines[line].length } },
    }),
    getText: (range?: { start: { line: number }; end: { line: number } }) =>
      range?.start.line === 0 && range.end.line === 6 ? lines.join("\n") : "app",
    getWordRangeAtPosition: () => ({
      start: { line: 3, character: 2 },
      end: { line: 3, character: 5 },
    }),
  };
  const selection = {
    start: { line: 0, character: 0 },
    end: { line: 6, character: lines[6]!.length },
  };
  const editor = { document, selection };

  executeCommand.mockImplementation(
    (_command: string, _uri: unknown, position: { line: number; character: number }) => {
      if (position.line === 0) {
        return Promise.resolve([{ uri: packageUri, range: { start: { line: 0 } } }]);
      }

      if (position.line >= 3 && position.line <= 5 && position.character === 2) {
        return Promise.resolve([{ uri: appUri, range: { start: { line: position.line + 7 } } }]);
      }

      return Promise.resolve([]);
    },
  );
  openTextDocument.mockImplementation(async (uri: typeof appUri) => ({
    uri,
    lineCount: 20,
    lineAt: () => ({ range: { end: { character: 20 } } }),
    getText: () => (uri === packageUri ? "package slog" : "func SetupLogger() {}"),
  }));

  const context = await collectFromEditor(editor as never);

  expect(context.definitions).toEqual([
    {
      fileName: "app/logger.go",
      code: "func SetupLogger() {}",
      startLine: 10,
      symbol: "app",
    },
    {
      fileName: "app/logger.go",
      code: "func SetupLogger() {}",
      startLine: 11,
      symbol: "app",
    },
    {
      fileName: "app/logger.go",
      code: "func SetupLogger() {}",
      startLine: 12,
      symbol: "app",
    },
  ]);
});

test("Goの複数行importブロック内の定義より本体の定義を優先する", async () => {
  const sourceUri = { path: "/workspace/main.go", toString: () => "file:///workspace/main.go" };
  const packageUri = {
    path: "/go/src/log/slog/logger.go",
    toString: () => "file:///go/src/log/slog/logger.go",
  };
  const appUri = {
    path: "/workspace/internal/app/logger.go",
    toString: () => "file:///workspace/internal/app/logger.go",
  };
  const lines = [
    "import (",
    '  "context"',
    '  "log/slog" // package path includes a ) in a comment',
    ")",
    "",
    "func main() {",
    "  app.SetupLogger()",
    "  app.SetupMetrics()",
    "  app.SetupTracer()",
    "}",
  ];
  const document = {
    uri: sourceUri,
    languageId: "go",
    lineCount: lines.length,
    lineAt: (line: number) => ({
      text: lines[line],
      range: { end: { character: lines[line].length } },
    }),
    getText: (range?: { start: { line: number }; end: { line: number } }) =>
      range?.start.line === 0 && range.end.line === 9 ? lines.join("\n") : "app",
    getWordRangeAtPosition: () => ({
      start: { line: 6, character: 2 },
      end: { line: 6, character: 5 },
    }),
  };
  const selection = {
    start: { line: 0, character: 0 },
    end: { line: 9, character: lines[9]!.length },
  };
  const editor = { document, selection };

  executeCommand.mockImplementation(
    (_command: string, _uri: unknown, position: { line: number; character: number }) => {
      if (position.line >= 1 && position.line <= 2) {
        return Promise.resolve([{ uri: packageUri, range: { start: { line: 0 } } }]);
      }

      if (position.line >= 6 && position.line <= 8 && position.character === 2) {
        return Promise.resolve([{ uri: appUri, range: { start: { line: position.line + 4 } } }]);
      }

      return Promise.resolve([]);
    },
  );
  openTextDocument.mockImplementation(async (uri: typeof appUri) => ({
    uri,
    lineCount: 20,
    lineAt: () => ({ range: { end: { character: 20 } } }),
    getText: () => (uri === packageUri ? "package slog" : "func SetupLogger() {}"),
  }));

  const context = await collectFromEditor(editor as never);

  expect(context.definitions).toEqual([
    {
      fileName: "app/logger.go",
      code: "func SetupLogger() {}",
      startLine: 10,
      symbol: "app",
    },
    {
      fileName: "app/logger.go",
      code: "func SetupLogger() {}",
      startLine: 11,
      symbol: "app",
    },
    {
      fileName: "app/logger.go",
      code: "func SetupLogger() {}",
      startLine: 12,
      symbol: "app",
    },
  ]);
});
