import { afterEach, expect, test, vi } from "vitest";

const { clipboard, executeCommand } = vi.hoisted(() => ({
  clipboard: {
    readText: vi.fn(),
    writeText: vi.fn(),
  },
  executeCommand: vi.fn(),
}));

vi.mock("vscode", () => ({
  env: { clipboard },
  commands: { executeCommand },
}));

import { readClipboard, readTerminalSelection } from "./clipboard";

afterEach(() => {
  vi.clearAllMocks();
});

test("ターミナルの選択内容を取得した後も元のクリップボードを使える", async () => {
  clipboard.readText.mockResolvedValueOnce("以前のコピー").mockResolvedValueOnce("選択したコード");

  const result = await readTerminalSelection();

  expect(result).toEqual({ ok: true, text: "選択したコード" });
  expect(clipboard.writeText).toHaveBeenLastCalledWith("以前のコピー");
});

test("選択が無いときに以前のクリップボード内容を送信しない", async () => {
  clipboard.readText.mockImplementation(async () => {
    const writes = clipboard.writeText.mock.calls;
    return writes.length === 0 ? "以前のコピー" : writes[0]?.[0];
  });

  const result = await readTerminalSelection();

  expect(result).toEqual({ ok: false, reason: "no-selection" });
  expect(clipboard.writeText).toHaveBeenLastCalledWith("以前のコピー");
});

test("ターミナル取得に失敗してもクリップボードを復元する", async () => {
  clipboard.readText.mockResolvedValueOnce("以前のコピー");
  executeCommand.mockRejectedValueOnce(new Error("copy failed"));

  await expect(readTerminalSelection()).rejects.toThrow("copy failed");

  expect(clipboard.writeText).toHaveBeenLastCalledWith("以前のコピー");
});

test("空白だけのクリップボード内容を送信対象にしない", async () => {
  clipboard.readText.mockResolvedValueOnce(" \n\t");

  await expect(readClipboard()).resolves.toEqual({ ok: false, reason: "empty" });
  expect(clipboard.writeText).not.toHaveBeenCalled();
});

test("クリップボード経路では内容を変更せずに読み取る", async () => {
  clipboard.readText.mockResolvedValueOnce("外部アプリからコピーした内容");

  await expect(readClipboard()).resolves.toEqual({
    ok: true,
    text: "外部アプリからコピーした内容",
  });
  expect(clipboard.writeText).not.toHaveBeenCalled();
});
