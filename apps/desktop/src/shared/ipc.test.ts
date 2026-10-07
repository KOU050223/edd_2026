// IPC 契約のずれを検出するテスト（Issue #279 ステップ 2）。
// Electron は起動せず、contextBridge / ipcRenderer / ipcMain をモックして、
// preload が公開する API・main が handle/send するチャネルが契約（ipc.ts）と
// 一致することを確かめる。
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { EVENT_CHANNELS, INVOKE_CHANNELS, type DesktopApi } from "./ipc.js";

const mocks = vi.hoisted(() => ({
  exposed: {} as { name?: string; api?: DesktopApi },
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: DesktopApi) => {
      mocks.exposed = { name, api };
    },
  },
  ipcRenderer: {
    invoke: mocks.invoke,
    on: mocks.on,
    removeListener: mocks.removeListener,
  },
}));

await import("../preload/index.js");

const api = mocks.exposed.api as DesktopApi;
const apiRecord = api as unknown as Record<string, (...args: unknown[]) => unknown>;

// preload のメソッド名 → 対応するチャネルの期待値。
// invoke 系は呼んだときの引数、イベント系は登録したリスナーで確かめる。
const expectedApi: Record<string, { channel: string; args: unknown[] } | { onChannel: string }> = {
  getSettings: { channel: INVOKE_CHANNELS.settingsGet, args: [] },
  saveSettings: { channel: INVOKE_CHANNELS.settingsSave, args: [{}] },
  login: { channel: INVOKE_CHANNELS.authLogin, args: [] },
  logout: { channel: INVOKE_CHANNELS.authLogout, args: [] },
  retrySelection: { channel: INVOKE_CHANNELS.selectionRetry, args: [] },
  ask: { channel: INVOKE_CHANNELS.answerAsk, args: ["selection", "question"] },
  getConsentStatus: { channel: INVOKE_CHANNELS.consentStatus, args: [] },
  reviewConsent: { channel: INVOKE_CHANNELS.consentReview, args: [] },
  getConversationHistoryOptIn: {
    channel: INVOKE_CHANNELS.conversationHistoryGet,
    args: [],
  },
  setConversationHistoryOptIn: {
    channel: INVOKE_CHANNELS.conversationHistorySet,
    args: [true],
  },
  onHistorySaveFailed: { onChannel: EVENT_CHANNELS.historySaveFailed },
  close: { channel: INVOKE_CHANNELS.windowClose, args: [] },
  minimize: { channel: INVOKE_CHANNELS.windowMinimize, args: [] },
  openExternalLink: { channel: INVOKE_CHANNELS.externalLinkOpen, args: ["https://example.com"] },
  listConversations: { channel: INVOKE_CHANNELS.conversationsList, args: ["cursor"] },
  getConversation: { channel: INVOKE_CHANNELS.conversationsGet, args: ["id"] },
  deleteConversation: { channel: INVOKE_CHANNELS.conversationsDelete, args: ["id"] },
  openAccessibilitySettings: { channel: INVOKE_CHANNELS.systemAccessibility, args: [] },
  onSelection: { onChannel: EVENT_CHANNELS.selection },
  onDelta: { onChannel: EVENT_CHANNELS.answerDelta },
  historyDetect: { channel: INVOKE_CHANNELS.historyDetect, args: [] },
  historyPickFile: { channel: INVOKE_CHANNELS.historyPickFile, args: [] },
  historyAnalyze: { channel: INVOKE_CHANNELS.historyAnalyze, args: [{}] },
  historyBuildPrompt: { channel: INVOKE_CHANNELS.historyBuildPrompt, args: [] },
  historyPasteAnalysis: { channel: INVOKE_CHANNELS.historyPasteAnalysis, args: ["text"] },
  historyApply: { channel: INVOKE_CHANNELS.historyApply, args: [{}] },
  historyList: { channel: INVOKE_CHANNELS.historyList, args: [] },
  historyUndo: { channel: INVOKE_CHANNELS.historyUndo, args: ["id"] },
  historyDeleteProvider: { channel: INVOKE_CHANNELS.historyDeleteProvider, args: ["codex"] },
  onHistoryProgress: { onChannel: EVENT_CHANNELS.historyProgress },
  onAuthState: { onChannel: EVENT_CHANNELS.authState },
};

describe("preload の window.desktop", () => {
  it('"desktop" という名前で公開し、キーの集合が契約と一致する', () => {
    expect(mocks.exposed.name).toBe("desktop");
    expect(Object.keys(apiRecord).sort()).toEqual(Object.keys(expectedApi).sort());
  });

  it("invoke 系メソッドが契約のチャネルを呼ぶ", () => {
    const usedChannels = new Set<string>();
    for (const [name, spec] of Object.entries(expectedApi)) {
      if (!("channel" in spec)) continue;
      mocks.invoke.mockClear();
      apiRecord[name](...spec.args);
      expect(mocks.invoke, name).toHaveBeenCalledWith(spec.channel, ...spec.args);
      usedChannels.add(spec.channel);
    }
    // 契約の invoke チャネルはすべて API メソッド経由で公開されている。
    expect(usedChannels).toEqual(new Set(Object.values(INVOKE_CHANNELS)));
  });

  it("on* メソッドが契約のチャネルを購読し、登録解除の関数を返す", () => {
    const usedChannels = new Set<string>();
    for (const [name, spec] of Object.entries(expectedApi)) {
      if (!("onChannel" in spec)) continue;
      mocks.on.mockClear();
      mocks.removeListener.mockClear();
      const listener = vi.fn();
      const unsubscribe = apiRecord[name](listener);
      expect(mocks.on, name).toHaveBeenCalledTimes(1);
      const [channel, wrapped] = mocks.on.mock.calls[0] as [string, (...a: unknown[]) => void];
      expect(channel, name).toBe(spec.onChannel);
      // 登録したラッパー経由でリスナーへ payload が届く。
      wrapped({}, "payload");
      expect(listener).toHaveBeenCalledWith("payload");
      // React の useEffect の後始末に使えるよう、解除関数を返す。
      expect(typeof unsubscribe).toBe("function");
      (unsubscribe as () => void)();
      expect(mocks.removeListener).toHaveBeenCalledWith(channel, wrapped);
      usedChannels.add(spec.onChannel);
    }
    expect(usedChannels).toEqual(new Set(Object.values(EVENT_CHANNELS)));
  });
});

describe("main のハンドラ登録", () => {
  const mainSource = readFileSync(new URL("../main/index.ts", import.meta.url), "utf8");

  it("handle() で契約の全 invoke チャネルを登録している", () => {
    const handled = new Set(
      [...mainSource.matchAll(/\bhandle\(\s*INVOKE_CHANNELS\.(\w+)/g)].map(
        (m) => INVOKE_CHANNELS[m[1] as keyof typeof INVOKE_CHANNELS],
      ),
    );
    expect(handled).toEqual(new Set(Object.values(INVOKE_CHANNELS)));
  });

  it("send() で契約の全イベントチャネルを送っている", () => {
    const sent = new Set(
      [...mainSource.matchAll(/\bsend\([^,]+,\s*EVENT_CHANNELS\.(\w+)/g)].map(
        (m) => EVENT_CHANNELS[m[1] as keyof typeof EVENT_CHANNELS],
      ),
    );
    expect(sent).toEqual(new Set(Object.values(EVENT_CHANNELS)));
  });

  it("チャネル名を main / preload のコードへ直書きしていない", () => {
    const preloadSource = readFileSync(new URL("../preload/index.ts", import.meta.url), "utf8");
    expect(mainSource).not.toContain("ipcMain.handle(");
    // handle/send/invoke/on の第一引数にチャネル名のリテラルが残っていないこと。
    // 正規表現は `"xxx:yyy"` 形のリテラルだけを対象にし、イベント名（"closed" 等）は許容する。
    for (const source of [mainSource, preloadSource]) {
      expect(source).not.toMatch(
        /\b(?:handle|invoke)\(\s*"[a-z-]+:[a-z-]+"|\bsend\(\s*"[^"]+:[^"]+"/,
      );
    }
  });
});
