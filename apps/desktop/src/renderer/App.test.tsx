// @vitest-environment happy-dom
// App 全体の受け入れテスト。window.desktop はモックで差し替え、
// Electron の実ウィンドウは立てない（apps/desktop/AGENTS.md の方針）。
import { StrictMode, act } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../shared/ipc.js";
import type { ImportProgress } from "../shared/types.js";
import type { Conversation } from "@gakushu-sochi/domain";

import { App } from "./App.js";

// React の act() をテストで使うための環境フラグ。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listener<T> = (payload: T) => void;

interface ListenerBox<T> {
  listeners: Set<Listener<T>>;
  subscribe: (listener: Listener<T>) => () => void;
  emit: (payload: T) => void;
  activeCount: () => number;
}

function listenerBox<T>(): ListenerBox<T> {
  const listeners = new Set<Listener<T>>();
  return {
    listeners,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (payload) => {
      for (const listener of [...listeners]) listener(payload);
    },
    activeCount: () => listeners.size,
  };
}

/** resolve/reject を外から制御できる Promise。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SETTINGS = {
  apiBaseUrl: "http://localhost:8787",
  shortcut: "CommandOrControl+Shift+K",
  model: "gemini-3.6-flash",
  temperature: 0.4,
  maxTokens: 1024,
  restoreClipboard: false,
  launchAtLogin: false,
  persona: "",
  saveConversationHistory: false,
  hasRefreshToken: true,
};

const SUMMARY = {
  id: "c1",
  origin: "desktop",
  occurredAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  messageCount: 3,
  complete: true,
  title: "テスト履歴",
};

const CONVERSATION: Conversation = {
  id: "c1",
  origin: "desktop",
  occurredAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  complete: true,
  messages: [
    { role: "context", text: "const x = 1;", at: "2026-01-01T00:00:00.000Z" },
    { role: "user", text: "説明して", at: "2026-01-01T00:00:01.000Z" },
    { role: "assistant", text: "定数宣言です。", at: "2026-01-01T00:01:00.000Z" },
  ],
};

interface MockDesktop {
  api: DesktopApi;
  selection: ListenerBox<{ selection: string; error?: string }>;
  delta: ListenerBox<string>;
  authState: ListenerBox<{ hasRefreshToken: boolean }>;
  historyProgress: ListenerBox<ImportProgress>;
  saveFailed: ListenerBox<string>;
  listConversations: ReturnType<typeof vi.fn>;
  getConversation: ReturnType<typeof vi.fn>;
  deleteConversation: ReturnType<typeof vi.fn>;
  ask: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const mockDesktop = (): MockDesktop => {
  const selection = listenerBox<{ selection: string; error?: string }>();
  const delta = listenerBox<string>();
  const authState = listenerBox<{ hasRefreshToken: boolean }>();
  const historyProgress = listenerBox<ImportProgress>();
  const saveFailed = listenerBox<string>();
  const listConversations = vi.fn(async () => ({ conversations: [], nextCursor: null }));
  const getConversation = vi.fn(async () => CONVERSATION);
  const deleteConversation = vi.fn(async () => ({ deletedCount: 1 }));
  const ask = vi.fn(async () => {});
  const login = vi.fn(async () => {});
  const logout = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const api = {
    getSettings: vi.fn(async () => ({ ...SETTINGS })),
    saveSettings: vi.fn(async () => {}),
    login,
    logout,
    retrySelection: vi.fn(async () => {}),
    ask,
    getConsentStatus: vi.fn(async () => ({ granted: true, grantedAt: "2026-01-01T00:00:00Z" })),
    reviewConsent: vi.fn(async () => ({ granted: true, grantedAt: "2026-01-01T00:00:00Z" })),
    getConversationHistoryOptIn: vi.fn(async () => ({ saveConversationHistory: false })),
    setConversationHistoryOptIn: vi.fn(async (enabled: boolean) => ({
      saveConversationHistory: enabled,
    })),
    onHistorySaveFailed: vi.fn(saveFailed.subscribe),
    close,
    minimize: vi.fn(async () => {}),
    openExternalLink: vi.fn(async () => {}),
    listConversations,
    getConversation,
    deleteConversation,
    openAccessibilitySettings: vi.fn(async () => {}),
    onSelection: vi.fn(selection.subscribe),
    onDelta: vi.fn(delta.subscribe),
    historyDetect: vi.fn(async () => ({ sources: [], analyzers: [] })),
    historyPickFile: vi.fn(async () => null),
    historyAnalyze: vi.fn(async () => ({})),
    historyBuildPrompt: vi.fn(async () => "prompt"),
    historyPasteAnalysis: vi.fn(async () => ({})),
    historyApply: vi.fn(async () => ({})),
    historyList: vi.fn(async () => ({ sessions: [] })),
    historyUndo: vi.fn(async () => ({ id: "", status: "undone", deletedEvidenceCount: 0 })),
    historyDeleteProvider: vi.fn(async () => ({ deletedCount: 0, sessionsMarkedUndone: 0 })),
    onHistoryProgress: vi.fn(historyProgress.subscribe),
    onAuthState: vi.fn(authState.subscribe),
  } as unknown as DesktopApi;
  return {
    api,
    selection,
    delta,
    authState,
    historyProgress,
    saveFailed,
    listConversations,
    getConversation,
    deleteConversation,
    ask,
    login,
    logout,
    close,
  };
};

let desktop: MockDesktop;

beforeEach(() => {
  desktop = mockDesktop();
  Object.defineProperty(window, "desktop", { value: desktop.api, configurable: true });
});

afterEach(() => {
  // 前のテストの App が document リスナーを残さないよう必ず unmount する。
  cleanup();
  vi.useRealTimers();
});

/** マウント時の一覧読み込みなど、進行中の非同期を流し切る。 */
const settle = async () => {
  await act(async () => {});
};

describe("App", () => {
  it("invokes ask only once when Send and Cmd+Enter overlap while sending", async () => {
    const pending = deferred<void>();
    desktop.ask.mockReturnValue(pending.promise);
    const view = render(<App />);
    await settle();

    const send = view.container.querySelector<HTMLButtonElement>("#send");
    expect(send).not.toBeNull();
    await act(async () => {
      send!.click();
      send!.click();
      // 送信中に Cmd+Enter が来ても弾く。
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
      );
    });
    expect(desktop.ask).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve();
    });
  });

  it("keeps the newer conversation list when an older load resolves later", async () => {
    const first = deferred<{ conversations: (typeof SUMMARY)[]; nextCursor: string | null }>();
    const second = deferred<{ conversations: (typeof SUMMARY)[]; nextCursor: string | null }>();
    desktop.listConversations
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = render(<App />);
    await settle();
    // onSelection で一覧の読み直しが走る（2 回目の読み込み）。
    await act(async () => {
      desktop.selection.emit({ selection: "code" });
    });
    expect(desktop.listConversations).toHaveBeenCalledTimes(2);

    const newer = { ...SUMMARY, id: "newer", title: "新しい履歴" };
    await act(async () => {
      second.resolve({ conversations: [newer], nextCursor: null });
    });
    expect(view.container.textContent).toContain("新しい履歴");

    // 古い応答が後から返っても表示は上書きしない（RULE-005）。
    await act(async () => {
      first.resolve({ conversations: [SUMMARY], nextCursor: null });
    });
    expect(view.container.textContent).toContain("新しい履歴");
    expect(view.container.textContent).not.toContain("テスト履歴");
  });

  it("does not open history while an answer is generating and shows a notice", async () => {
    desktop.listConversations.mockResolvedValue({ conversations: [SUMMARY], nextCursor: null });
    const pending = deferred<void>();
    desktop.ask.mockReturnValue(pending.promise);
    const view = render(<App />);
    await settle();

    const item = view.container.querySelector<HTMLButtonElement>(".conversation");
    expect(item).not.toBeNull();

    // 回答を生成中にする。
    const send = view.container.querySelector<HTMLButtonElement>("#send");
    await act(async () => {
      send!.click();
    });

    await act(async () => {
      item!.click();
    });
    expect(desktop.getConversation).not.toHaveBeenCalled();
    const error = view.container.querySelector<HTMLElement>("#error");
    expect(error?.textContent).toBe("回答を生成している間は履歴を開けません。");
    expect(error?.dataset.tone).toBe("notice");
    await act(async () => {
      pending.resolve();
    });
  });

  it("does not let auth:state overwrite the in-progress login display", async () => {
    const pending = deferred<void>();
    desktop.login.mockReturnValue(pending.promise);
    const view = render(<App />);
    await settle();

    // 設定シートを開いて auth-status を見えるようにする。
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>("#settings")!.click();
    });
    await settle();

    const status = () => view.container.querySelector("#auth-status")?.textContent;
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>("#auth-login")!.click();
    });
    expect(status()).toBe("ブラウザでログインしています…");

    // ログイン中に届いた通知は取り込まない。
    await act(async () => {
      desktop.authState.emit({ hasRefreshToken: false });
    });
    expect(status()).toBe("ブラウザでログインしています…");

    await act(async () => {
      pending.resolve();
    });
    expect(status()).toBe("ログイン済み");
  });

  it("requires two steps to delete history and auto-disarms after five seconds", async () => {
    desktop.listConversations.mockResolvedValue({ conversations: [SUMMARY], nextCursor: null });
    const view = render(<App />);
    await settle();

    // 履歴の詳細を開く。
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>(".conversation")!.click();
    });
    await settle();
    expect(desktop.getConversation).toHaveBeenCalledWith("c1");

    const button = view.container.querySelector<HTMLButtonElement>("#history-delete");
    expect(button?.hidden).toBe(false);
    expect(button?.textContent).toBe("履歴を削除");

    vi.useFakeTimers();
    // 1 回目は「もう一度押すと削除」に変わるだけ。
    await act(async () => {
      button!.click();
    });
    expect(button?.textContent).toBe("もう一度押すと削除");
    expect(button?.dataset.armed).toBe("true");
    expect(desktop.deleteConversation).not.toHaveBeenCalled();

    // 5 秒で自動解除される。
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(button?.textContent).toBe("履歴を削除");
    expect(button?.dataset.armed).toBe("false");

    // 再度 2 回押すと削除が走る。
    await act(async () => {
      button!.click();
    });
    await act(async () => {
      button!.click();
    });
    expect(desktop.deleteConversation).toHaveBeenCalledWith("c1");
    vi.useRealTimers();
  });

  it("removes inert and returns focus to the settings button on Escape", async () => {
    const view = render(<App />);
    await settle();

    await act(async () => {
      view.container.querySelector<HTMLButtonElement>("#settings")!.click();
    });
    await settle();

    const titlebar = view.container.querySelector<HTMLElement>("#titlebar");
    const workspace = view.container.querySelector<HTMLElement>("#workspace");
    const form = view.container.querySelector<HTMLElement>("#settings-form");
    expect(titlebar?.hasAttribute("inert")).toBe(true);
    expect(workspace?.hasAttribute("inert")).toBe(true);
    expect(form?.hidden).toBe(false);
    expect(document.activeElement?.id).toBe("api-base-url");

    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(form?.hidden).toBe(true);
    expect(titlebar?.hasAttribute("inert")).toBe(false);
    expect(workspace?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement?.id).toBe("settings");
    expect(desktop.close).not.toHaveBeenCalled();
  });

  it("registers each event listener exactly once under StrictMode", async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await settle();
    expect(desktop.delta.activeCount()).toBe(1);
    expect(desktop.selection.activeCount()).toBe(1);
    expect(desktop.authState.activeCount()).toBe(1);
    expect(desktop.saveFailed.activeCount()).toBe(1);
  });
});
