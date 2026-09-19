import { afterEach, expect, test, vi } from "vitest";

const { showWarningMessage } = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: { showWarningMessage },
}));

import { confirmSend } from "./confirm";

afterEach(() => {
  vi.clearAllMocks();
});

test("利用者が承諾した内容だけを送信対象にできる", async () => {
  showWarningMessage.mockResolvedValueOnce("送る");

  await expect(confirmSend("安全なコード")).resolves.toBe(true);
  expect(showWarningMessage).toHaveBeenCalledWith(
    expect.any(String),
    { modal: true, detail: "安全なコード" },
    "送る",
  );
});

test("利用者が中止した内容を送信対象にしない", async () => {
  showWarningMessage.mockResolvedValueOnce(undefined);

  await expect(confirmSend("送ってはいけない内容")).resolves.toBe(false);
});

test("長い入力でも確認画面に表示する内容を制限する", async () => {
  showWarningMessage.mockResolvedValueOnce("送る");
  const text = "a".repeat(501);

  await confirmSend(text);

  expect(showWarningMessage.mock.calls[0]?.[1]).toEqual({
    modal: true,
    detail: `${"a".repeat(500)}…`,
  });
});
