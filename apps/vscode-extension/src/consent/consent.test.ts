import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CONSENT_NOTICE_VERSION } from "@gakushu-sochi/domain";

const { showWarningMessage, showInformationMessage, showErrorMessage } = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: { showWarningMessage, showInformationMessage, showErrorMessage },
}));

import { CONSENT_KEY, ensureConsent, hasConsent, revokeConsent, reviewConsent } from "./consent";

/** globalState だけを持つ最小の ExtensionContext。実際の VS Code は起動しない。 */
function createContext(stored?: unknown) {
  const state = new Map<string, unknown>();
  if (stored !== undefined) {
    state.set(CONSENT_KEY, stored);
  }
  return {
    globalState: {
      get: vi.fn((key: string) => state.get(key)),
      update: vi.fn(async (key: string, value: unknown) => {
        if (value === undefined) {
          state.delete(key);
          return;
        }
        state.set(key, value);
      }),
    },
  };
}

const granted = { version: CONSENT_NOTICE_VERSION, grantedAt: "2026-09-21T00:00:00.000Z" };

beforeEach(() => {
  showWarningMessage.mockReset();
  showInformationMessage.mockReset();
  showErrorMessage.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

test("記録が無ければ同意していない", () => {
  expect(hasConsent(createContext() as never)).toBe(false);
});

test("保存済みの同意を読み取れる", () => {
  expect(hasConsent(createContext(granted) as never)).toBe(true);
});

test("同意済みなら確認ダイアログを出さない", async () => {
  const context = createContext(granted);

  await expect(ensureConsent(context as never, vi.fn())).resolves.toBe(true);
  expect(showWarningMessage).not.toHaveBeenCalled();
});

test("同意しなかった場合は送信を許可しない", async () => {
  showWarningMessage.mockResolvedValueOnce("同意しない");
  const context = createContext();

  await expect(ensureConsent(context as never, vi.fn())).resolves.toBe(false);
  expect(context.globalState.update).not.toHaveBeenCalled();
});

test("ダイアログを閉じただけの場合も送信を許可しない", async () => {
  showWarningMessage.mockResolvedValueOnce(undefined);

  await expect(ensureConsent(createContext() as never, vi.fn())).resolves.toBe(false);
});

test("同意した内容を globalState へ記録する", async () => {
  showWarningMessage.mockResolvedValueOnce("同意して続ける");
  const context = createContext();

  await expect(ensureConsent(context as never, vi.fn())).resolves.toBe(true);
  expect(context.globalState.update).toHaveBeenCalledWith(
    CONSENT_KEY,
    expect.objectContaining({ version: CONSENT_NOTICE_VERSION, grantedAt: expect.any(String) }),
  );
  expect(hasConsent(context as never)).toBe(true);
});

test("同意の記録に失敗したら、同意が成立したことにしない", async () => {
  showWarningMessage.mockResolvedValueOnce("同意して続ける");
  const context = createContext();
  context.globalState.update.mockRejectedValueOnce(new Error("disk full"));
  const onError = vi.fn();

  await expect(ensureConsent(context as never, onError)).resolves.toBe(false);
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  expect(showErrorMessage).toHaveBeenCalled();
});

test("同意を取り消すと、以降は同意していない状態になる", async () => {
  const context = createContext(granted);

  await revokeConsent(context as never, vi.fn());

  expect(hasConsent(context as never)).toBe(false);
  expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("取り消しました"));
});

test("取り消しに失敗したら、止まったことにせず失敗を伝える", async () => {
  const context = createContext(granted);
  context.globalState.update.mockRejectedValueOnce(new Error("locked"));
  const onError = vi.fn();

  await revokeConsent(context as never, onError);

  expect(onError).toHaveBeenCalledWith(expect.stringContaining("locked"));
  expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("停止していません"));
  expect(hasConsent(context as never)).toBe(true);
});

test("未同意のまま確認を開いたら、その場で同意を求める", async () => {
  showWarningMessage.mockResolvedValueOnce("同意して続ける");
  const context = createContext();

  await reviewConsent(context as never, vi.fn());

  expect(showWarningMessage).toHaveBeenCalled();
  expect(hasConsent(context as never)).toBe(true);
});

test("確認画面から同意を取り消せる", async () => {
  showInformationMessage.mockResolvedValueOnce("同意を取り消す");
  const context = createContext(granted);

  await reviewConsent(context as never, vi.fn());

  expect(hasConsent(context as never)).toBe(false);
});
