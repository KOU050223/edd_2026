import { afterEach, expect, test, vi } from "vitest";

import { buildVscodeConversation } from "./conversation";
import {
  getRemoteSaveConversationHistory,
  setRemoteSaveConversationHistory,
  uploadConversation,
} from "./sync";

const CONVERSATION = buildVscodeConversation({
  id: "session-1",
  context: {
    code: "const x = 1;",
    source: "editor",
    contextLevel: 2,
    surroundingCode: "",
    languageId: "typescript",
    fileName: "index.ts",
  },
  question: "q?",
  answer: "a",
  occurredAt: "2026-01-01T00:00:00.000Z",
  answeredAt: "2026-01-01T00:00:01.000Z",
});

const CONFIG = {
  apiBaseUrl: "https://api.example.com",
  apiToken: async () => "test-token",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

test("会話を Bearer トークン付きで PUT し、リダイレクトは追跡しない", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"saved":true}', { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const outcome = await uploadConversation(CONVERSATION, CONFIG);

  expect(outcome).toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.example.com/v1/conversations/session-1",
    expect.objectContaining({
      method: "PUT",
      redirect: "error",
      headers: expect.objectContaining({ authorization: "Bearer test-token" }),
    }),
  );
});

test("403 はサーバー側で無効の確定情報として返す", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":"conversation_history_disabled"}', { status: 403 }),
      ),
  );

  const outcome = await uploadConversation(CONVERSATION, CONFIG);

  // disabled:true を根拠に呼び出し側がローカルキャッシュを落とす。
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.disabled).toBe(true);
});

test("安全でない送信先にはトークンを載せる前に止める", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const outcome = await uploadConversation(CONVERSATION, {
    ...CONFIG,
    apiBaseUrl: "http://api.example.com",
  });

  expect(outcome.ok).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("200 でも saved:true でなければ失敗として返す", async () => {
  // { saved: false }（新しい会話が既存）を保存成功と見なすと履歴が黙って抜ける
  // （RULE-004）。
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(new Response('{"saved":false,"reason":"newer_exists"}', { status: 200 })),
  );

  const outcome = await uploadConversation(CONVERSATION, CONFIG);

  expect(outcome.ok).toBe(false);
});

test("オプトインの切り替えは saveConversationHistory だけを送る", async () => {
  // GET → PUT の全文送り返しだと、読み取りと書き込みの間に別端末が
  // 変更した項目を古い値で上書きする。
  const remoteSettings = {
    version: 1,
    displayName: "学習者",
    activityPeriodDays: 30,
    saveConversationHistory: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(remoteSettings), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const outcome = await setRemoteSaveConversationHistory(true, CONFIG);

  expect(outcome).toEqual({ ok: true, enabled: true });
  // 切り替えたい項目だけを送り、GET で先行読み取りはしない。
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const putBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(putBody).toEqual({ saveConversationHistory: true });
});

test("フィールドを持たない古いサーバー応答は未対応として失敗にする", async () => {
  // saveConversationHistory が無い応答を既定値へ黙って落とすと、
  // 有効化したつもりの利用者へ偽の表示を出す（RULE-004）。
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: 1, displayName: null, activityPeriodDays: 30 }), {
        status: 200,
      }),
    ),
  );

  const outcome = await getRemoteSaveConversationHistory(CONFIG);

  expect(outcome.ok).toBe(false);
});
